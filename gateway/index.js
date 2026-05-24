/**
 * API Gateway с механизмами отказоустойчивости и метриками Prometheus.
 * Метрики для графиков (эндпоинт GET /metrics, формат Prometheus):
 *   - состояние цепи (closed=0 / open=1 / half-open=2)
 *   - счётчики исходов запросов (success/failure/timeout/reject/fallback)
 *   - гистограмма задержек шлюза по маршрутам и статусам
 *   - стандартные метрики Node.js (CPU, память, event loop)
 *

 */

const express = require("express");
const axios = require("axios");
const axiosRetry = require("axios-retry").default;
const CircuitBreaker = require("opossum");
const rateLimit = require("express-rate-limit");
const client = require("prom-client");

const CONFIG = {
  POST_SERVICE_URL: process.env.POST_SERVICE_URL || "http://post-service:3003",

  HTTP_TIMEOUT_MS: parseInt(process.env.HTTP_TIMEOUT_MS) || 2000,

  RETRY_COUNT: parseInt(process.env.RETRY_COUNT) || 2, // повторов сверх 1-й попытки

  CB_TIMEOUT_MS: parseInt(process.env.CB_TIMEOUT_MS) || 6000,
  CB_ERROR_THRESHOLD: parseInt(process.env.CB_ERROR_THRESHOLD) || 50, // % ошибок для размыкания
  CB_RESET_TIMEOUT_MS: parseInt(process.env.CB_RESET_TIMEOUT_MS) || 5000,
  CB_ROLLING_WINDOW_MS: parseInt(process.env.CB_ROLLING_WINDOW_MS) || 10000,

  RL_WINDOW_MS: parseInt(process.env.RL_WINDOW_MS) || 1000,
  RL_LIMIT: parseInt(process.env.RL_LIMIT) || 100,
};

(function validateConfig() {
  const worstCase = CONFIG.HTTP_TIMEOUT_MS * (CONFIG.RETRY_COUNT + 1);
  if (CONFIG.CB_TIMEOUT_MS < worstCase) {
    console.warn(
      `[CONFIG WARNING] CB_TIMEOUT_MS=${CONFIG.CB_TIMEOUT_MS}мс < ` +
        `HTTP_TIMEOUT_MS × (RETRY_COUNT+1)=${worstCase}мс. ` +
        `Размыкатель цепи может прерывать повторные запросы. ` +
        `Рекомендуется CB_TIMEOUT_MS ≥ ${worstCase}.`,
    );
  }
})();

const register = new client.Registry();
register.setDefaultLabels({ app: "gateway" });
// стандартные метрики Node.js (CPU, память, event loop)

client.collectDefaultMetrics({ register, prefix: "node_" });

const cbStateGauge = new client.Gauge({
  name: "circuit_breaker_state",
  help: "Состояние размыкателя цепи: 0=closed, 1=open, 2=half-open",
  registers: [register],
  collect() {
    this.set(breaker.opened ? 1 : breaker.halfOpen ? 2 : 0);
  },
});

const cbResultCounter = new client.Counter({
  name: "circuit_breaker_requests_total",
  help: "Количество запросов через размыкатель цепи по исходам",
  labelNames: ["result"],
  registers: [register],
});

const httpLatency = new client.Histogram({
  name: "gateway_request_duration_seconds",
  help: "Длительность обработки запроса шлюзом, секунды",
  labelNames: ["route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

const httpClient = axios.create({
  baseURL: CONFIG.POST_SERVICE_URL,
  timeout: CONFIG.HTTP_TIMEOUT_MS,
});

axiosRetry(httpClient, {
  retries: CONFIG.RETRY_COUNT,
  retryDelay: axiosRetry.exponentialDelay,

  shouldResetTimeout: true,

  retryCondition: (error) => {
    return (
      axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      error.code === "ECONNABORTED" ||
      (error.response && error.response.status >= 500)
    );
  },
  onRetry: (retryCount, error, requestConfig) => {
    console.log(
      `[RETRY] попытка #${retryCount} для ` +
        `${requestConfig.method?.toUpperCase()} ${requestConfig.url} ` +
        `(причина: ${error.code || error.message})`,
    );
  },
});

function forwardRequest(requestConfig) {
  return httpClient.request(requestConfig);
}

const breaker = new CircuitBreaker(forwardRequest, {
  timeout: CONFIG.CB_TIMEOUT_MS,
  errorThresholdPercentage: CONFIG.CB_ERROR_THRESHOLD,
  resetTimeout: CONFIG.CB_RESET_TIMEOUT_MS,
  rollingCountTimeout: CONFIG.CB_ROLLING_WINDOW_MS,

  errorFilter: (err) => {
    const status = err && err.response && err.response.status;
    return status !== undefined && status >= 400 && status < 500;
  },
});

breaker.fallback(() => ({
  __fallback: true,
  status: 503,
  data: { error: "Service temporarily unavailable" },
}));

breaker.on("success", () => cbResultCounter.inc({ result: "success" }));
breaker.on("failure", () => cbResultCounter.inc({ result: "failure" }));
breaker.on("timeout", () => cbResultCounter.inc({ result: "timeout" }));
breaker.on("reject", () => cbResultCounter.inc({ result: "reject" }));
breaker.on("fallback", () => cbResultCounter.inc({ result: "fallback" }));

breaker.on("open", () =>
  console.log("[BREAKER] OPEN — post-service недоступен, режим fail-fast"),
);
breaker.on("halfOpen", () =>
  console.log("[BREAKER] HALF-OPEN — пробный запрос к post-service"),
);
breaker.on("close", () =>
  console.log("[BREAKER] CLOSE — post-service восстановлен"),
);

/**
 * Унифицированный проброс запроса через размыкатель цепи.
 * @returns {Promise<{ok:boolean,status:number,data:any}>}
 */
async function callPostService(requestConfig) {
  try {
    const result = await breaker.fire(requestConfig);
    if (result && result.__fallback) {
      return { ok: false, status: result.status, data: result.data };
    }
    return { ok: true, status: result.status, data: result.data };
  } catch (err) {
    if (err.response) {
      return {
        ok: false,
        status: err.response.status,
        data: err.response.data,
      };
    }

    return {
      ok: false,
      status: 503,
      data: { error: "Service temporarily unavailable" },
    };
  }
}

const rateLimiter = rateLimit({
  windowMs: CONFIG.RL_WINDOW_MS,
  limit: CONFIG.RL_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down" },
});

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[GATEWAY] ${req.method} ${req.url}`);
  next();
});

app.use((req, res, next) => {
  if (req.path === "/metrics" || req.path === "/health") return next();
  const end = httpLatency.startTimer();
  res.on("finish", () => {
    const route = req.route ? req.baseUrl + req.route.path : req.path;
    end({ route, status: res.statusCode });
  });
  next();
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// Метрики Prometheus
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

app.get("/breaker-status", (req, res) => {
  const s = breaker.stats;
  res.json({
    state: breaker.opened ? "open" : breaker.halfOpen ? "half-open" : "closed",
    fires: s.fires,
    successes: s.successes,
    failures: s.failures,
    timeouts: s.timeouts,
    rejects: s.rejects,
    fallbacks: s.fallbacks,
  });
});

app.use("/api", rateLimiter);

app.get("/api/posts", async (req, res) => {
  const r = await callPostService({
    method: "get",
    url: "/posts",
    params: req.query,
  });
  res.status(r.ok ? 200 : r.status).json(r.data);
});

//GET /api/posts/cursor (курсорная пагинация)
app.get("/api/posts/cursor", async (req, res) => {
  const r = await callPostService({
    method: "get",
    url: "/posts/cursor",
    params: req.query,
  });
  res.status(r.ok ? 200 : r.status).json(r.data);
});

//GET /api/posts/offset (OFFSET)
app.get("/api/posts/offset", async (req, res) => {
  const r = await callPostService({
    method: "get",
    url: "/posts/offset",
    params: { limit: req.query.limit || 20, offset: req.query.offset || 0 },
  });
  res.status(r.ok ? 200 : r.status).json(r.data);
});

//GET /api/posts/:id
app.get("/api/posts/:id", async (req, res) => {
  const r = await callPostService({
    method: "get",
    url: `/posts/${req.params.id}`,
  });
  res.status(r.ok ? 200 : r.status).json(r.data);
});

//POST /api/posts
app.post("/api/posts", async (req, res) => {
  const r = await callPostService({
    method: "post",
    url: "/posts",
    data: req.body,
  });
  res.status(r.ok ? r.status || 201 : r.status).json(r.data);
});

//PUT /api/posts/:id
app.put("/api/posts/:id", async (req, res) => {
  const r = await callPostService({
    method: "put",
    url: `/posts/${req.params.id}`,
    data: req.body,
  });
  res.status(r.ok ? 200 : r.status).json(r.data);
});

//DELETE /api/posts/:id
app.delete("/api/posts/:id", async (req, res) => {
  const r = await callPostService({
    method: "delete",
    url: `/posts/${req.params.id}`,
  });
  if (r.ok) return res.status(204).send();
  res.status(r.status).json(r.data);
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log("Gateway running on port 3000 (resilience + Prometheus enabled)");
});
