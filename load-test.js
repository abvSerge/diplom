import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

/**
 * Нагрузочный тест устойчивости и пропускной способности шлюза.
 *
 *
 * Эндпоинт выбирается переменной TARGET:
 *   TARGET=cached → /api/posts        (с кешем Redis)
 *   TARGET=cursor → /api/posts/cursor (без кеша)
 *
 * Запуск:
 *   docker compose run --rm -e TARGET=cursor                k6
 *   docker compose run --rm -e TARGET=cursor -e MODE=stress k6
 */

const errorRate = new Rate("errors");
const latency = new Trend("req_latency", true);
const status503 = new Counter("status_503");
const status429 = new Counter("status_429");
const status200 = new Counter("status_200");

const BASE_URL = __ENV.BASE_URL || "http://gateway:3000";

const TARGET = __ENV.TARGET || "cursor";
const PATHS = {
  cached: "/api/posts?limit=20",
  cursor: "/api/posts/cursor?limit=20",
};
const REQUEST_PATH = PATHS[TARGET] || PATHS.cursor;

const MODE = __ENV.MODE || "normal";

const PROFILES = {
  normal: {
    stages: [
      { duration: "15s", target: 20 },
      { duration: "30s", target: 50 },
      { duration: "30s", target: 100 },
      { duration: "15s", target: 0 },
    ],
    sleepSec: 1,
  },

  stress: {
    stages: [
      { duration: "20s", target: 100 },
      { duration: "60s", target: 300 },
      { duration: "30s", target: 300 },
      { duration: "10s", target: 0 },
    ],
    sleepSec: 0,
  },
};
const PROFILE = PROFILES[MODE] || PROFILES.normal;

export const options = {
  stages: PROFILE.stages,
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  thresholds: {
    req_latency: ["p(95)<5000"],
    errors: ["rate<0.95"],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}${REQUEST_PATH}`);

  latency.add(res.timings.duration);

  const ok = res.status === 200;
  errorRate.add(!ok);

  if (res.status === 200) status200.add(1);
  else if (res.status === 503) status503.add(1);
  else if (res.status === 429) status429.add(1);

  check(res, {
    "status is 200": (r) => r.status === 200,
    "responds fast under failure": (r) => r.timings.duration < 5000,
  });

  if (PROFILE.sleepSec > 0) sleep(PROFILE.sleepSec);
}

export function handleSummary(data) {
  const m = data.metrics;
  const line = (label, v) => `  ${label}: ${v}`;

  const val = (metric, key, digits) => {
    if (!metric || !metric.values || metric.values[key] == null) return "n/a";
    const v = metric.values[key];
    return digits != null ? v.toFixed(digits) : v;
  };

  const rps =
    m.iterations && m.iterations.values && m.iterations.values.rate != null
      ? m.iterations.values.rate.toFixed(1)
      : "n/a";

  const lat = m.req_latency;
  const summary = [
    "",
    "РЕЗУЛЬТАТЫ ЭКСПЕРИМЕНТА",
    line("Режим", MODE),
    line("Эндпоинт", `${TARGET} (${REQUEST_PATH})`),
    line("Всего запросов", val(m.iterations, "count")),
    line("Пропускная способность, RPS", rps),
    line("Ответов 200", m.status_200 ? val(m.status_200, "count") : 0),
    line(
      "Ответов 503 (деградация)",
      m.status_503 ? val(m.status_503, "count") : 0,
    ),
    line(
      "Ответов 429 (rate limit)",
      m.status_429 ? val(m.status_429, "count") : 0,
    ),
    line(
      "Доля ошибок, %",
      m.errors && m.errors.values && m.errors.values.rate != null
        ? (m.errors.values.rate * 100).toFixed(2)
        : "n/a",
    ),
    line("Latency avg, мс", val(lat, "avg", 1)),
    line("Latency med, мс", val(lat, "med", 1)),
    line("Latency p95, мс", val(lat, "p(95)", 1)),
    line("Latency p99, мс", val(lat, "p(99)", 1)),
    line("Latency max, мс", val(lat, "max", 1)),
    "=================",
    "",
  ].join("\n");

  return {
    stdout: summary,
    "summary.json": JSON.stringify(data, null, 2),
  };
}
