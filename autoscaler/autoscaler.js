/**
 * Назначение: автоматически менять число реплик post-service в зависимости
 * от текущей нагрузки. Прототип Kubernetes HPA (Horizontal Pod Autoscaler)
 * для Docker Compose окружения.
 * Алгоритм работы (главный цикл):
 *   1. Каждые EVALUATION_INTERVAL_MS опросить Prometheus
 *      и получить значение метрики p95 latency шлюза за последние 30 секунд.
 *   2. Сравнить с порогами (SCALE_UP_THRESHOLD, SCALE_DOWN_THRESHOLD).
 *   3. Если порог превышен / занижен заданное число раз подряд
 *      (SCALE_UP_AFTER_N, SCALE_DOWN_AFTER_N) — принять решение скейлить.
 *   4. Применить решение через Docker API + соблюсти cooldown.
 * 
 * 
 *   PROMETHEUS_URL          — URL Prometheus (по умолчанию http://prometheus:9090)
 *   DOCKER_SOCKET           — путь к Docker socket (/var/run/docker.sock)
 *   SERVICE_NAME            — имя сервиса в docker compose (post-service)
 *   PROJECT_NAME            — имя проекта compose (берётся из переменной)
 *   MIN_REPLICAS            — минимальное число реплик (по умолч. 1)
 *   MAX_REPLICAS            — максимальное число реплик (по умолч. 10)
 *   SCALE_UP_THRESHOLD_MS   — p95 latency, выше которого скейлим вверх (500)
 *   SCALE_DOWN_THRESHOLD_MS — p95 latency, ниже которого скейлим вниз (100)
 *   SCALE_UP_AFTER_N        — порог должен держаться N циклов подряд (3)
 *   SCALE_DOWN_AFTER_N      — порог должен держаться N циклов подряд (12)
 *   COOLDOWN_AFTER_SCALE_MS — пауза после действия (30000)
 *   EVALUATION_INTERVAL_MS  — частота опроса метрик (10000)
 */

const Docker = require("dockerode");
const axios = require("axios");


const CONFIG = {
  PROMETHEUS_URL: process.env.PROMETHEUS_URL || "http://prometheus:9090",
  DOCKER_SOCKET: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
  SERVICE_NAME: process.env.SERVICE_NAME || "post-service",
  PROJECT_NAME: process.env.PROJECT_NAME || "diplom",

  MIN_REPLICAS: parseInt(process.env.MIN_REPLICAS) || 1,
  MAX_REPLICAS: parseInt(process.env.MAX_REPLICAS) || 10,

 
  SCALE_UP_THRESHOLD_MS: parseInt(process.env.SCALE_UP_THRESHOLD_MS) || 500,
  SCALE_DOWN_THRESHOLD_MS: parseInt(process.env.SCALE_DOWN_THRESHOLD_MS) || 100,
  SCALE_UP_AFTER_N: parseInt(process.env.SCALE_UP_AFTER_N) || 3, 
  SCALE_DOWN_AFTER_N: parseInt(process.env.SCALE_DOWN_AFTER_N) || 12, 

  COOLDOWN_AFTER_SCALE_MS:
    parseInt(process.env.COOLDOWN_AFTER_SCALE_MS) || 30000,
  EVALUATION_INTERVAL_MS:
    parseInt(process.env.EVALUATION_INTERVAL_MS) || 10000,

 
  METRIC_WINDOW: process.env.METRIC_WINDOW || "30s",
};


const state = {
  consecutiveHigh: 0, 
  consecutiveLow: 0, 
  lastScaleAt: 0, 
  currentReplicas: null, 
};


const docker = new Docker({ socketPath: CONFIG.DOCKER_SOCKET });


async function listServiceContainers() {
  const containers = await docker.listContainers({
    all: false, 
    filters: {
      label: [
        `com.docker.compose.project=${CONFIG.PROJECT_NAME}`,
        `com.docker.compose.service=${CONFIG.SERVICE_NAME}`,
      ],
    },
  });
  return containers;
}


async function getCurrentReplicas() {
  const containers = await listServiceContainers();
  return containers.length;
}


async function scaleUp() {
  const existing = await listServiceContainers();
  if (existing.length === 0) {
    throw new Error(
      "Нет ни одной реплики post-service — не от чего копировать конфигурацию. " +
        "Запустите хотя бы одну через docker compose up.",
    );
  }

  
  const template = await docker.getContainer(existing[0].Id).inspect();

  // Compose нумерует реплики post-service-1, post-service-2, ...
  // Находим первое свободное число
  const usedNumbers = new Set(
    existing.map((c) => {
      const m = c.Names[0].match(/-(\d+)$/);
      return m ? parseInt(m[1]) : 0;
    }),
  );
  let nextNumber = 1;
  while (usedNumbers.has(nextNumber)) nextNumber++;

  const newName = `${CONFIG.PROJECT_NAME}-${CONFIG.SERVICE_NAME}-${nextNumber}`;

  console.log(`[ACTION] Создание реплики: ${newName}`);

  const container = await docker.createContainer({
    Image: template.Config.Image,
    Env: template.Config.Env,
    Labels: {
      "com.docker.compose.project": CONFIG.PROJECT_NAME,
      "com.docker.compose.service": CONFIG.SERVICE_NAME,
      "com.docker.compose.container-number": String(nextNumber),
      "managed-by": "autoscaler",
    },
    HostConfig: {
      NetworkMode: template.HostConfig.NetworkMode,
      RestartPolicy: { Name: "always" },
    },
    name: newName,
  });

  
  const networkName = Object.keys(template.NetworkSettings.Networks)[0];
  if (networkName) {
    const network = docker.getNetwork(networkName);
    try {
      
      await network.connect({
        Container: container.id,
        EndpointConfig: { Aliases: [CONFIG.SERVICE_NAME] },
      });
    } catch (e) {
      
    }
  }

  await container.start();
  console.log(`[ACTION] Реплика ${newName} запущена`);
}


async function scaleDown() {
  const existing = await listServiceContainers();
  if (existing.length <= CONFIG.MIN_REPLICAS) {
    console.log(`[ACTION] Уже на минимуме (${existing.length}), пропуск`);
    return;
  }

 
  const sorted = existing.sort((a, b) => {
    const numA = parseInt((a.Names[0].match(/-(\d+)$/) || [0, 0])[1]);
    const numB = parseInt((b.Names[0].match(/-(\d+)$/) || [0, 0])[1]);
    return numB - numA; 
  });

  const toRemove = sorted[0];
  console.log(`[ACTION] Остановка реплики: ${toRemove.Names[0]}`);

  const container = docker.getContainer(toRemove.Id);

  
  try {
    await container.stop({ t: 10 }); 
  } catch (e) {
   
  }
  await container.remove({ force: true });

  console.log(`[ACTION] Реплика ${toRemove.Names[0]} удалена`);
}


async function getP95LatencyMs() {
  const query =
    `histogram_quantile(0.95, ` +
    `sum(rate(gateway_request_duration_seconds_bucket[${CONFIG.METRIC_WINDOW}])) ` +
    `by (le))`;

  try {
    const response = await axios.get(`${CONFIG.PROMETHEUS_URL}/api/v1/query`, {
      params: { query },
      timeout: 5000,
    });

    const result = response.data.data.result;
    if (!result || result.length === 0) return null;

    const value = parseFloat(result[0].value[1]);
    if (isNaN(value)) return null;

    return value * 1000; 
  } catch (err) {
    console.error(`[METRICS] Ошибка опроса Prometheus: ${err.message}`);
    return null;
  }
}


async function evaluationCycle() {
  
  let replicas;
  try {
    replicas = await getCurrentReplicas();
    state.currentReplicas = replicas;
  } catch (err) {
    console.error(`[DOCKER] Ошибка получения числа реплик: ${err.message}`);
    return;
  }

 
  const p95 = await getP95LatencyMs();
  if (p95 === null) {
    console.log(`[CYCLE] replicas=${replicas}, p95=нет данных`);
    return;
  }

  console.log(
    `[CYCLE] replicas=${replicas}, p95=${p95.toFixed(1)}мс, ` +
      `up_count=${state.consecutiveHigh}/${CONFIG.SCALE_UP_AFTER_N}, ` +
      `down_count=${state.consecutiveLow}/${CONFIG.SCALE_DOWN_AFTER_N}`,
  );

  
  if (p95 > CONFIG.SCALE_UP_THRESHOLD_MS) {
    state.consecutiveHigh++;
    state.consecutiveLow = 0;
  } else if (p95 < CONFIG.SCALE_DOWN_THRESHOLD_MS) {
    state.consecutiveLow++;
    state.consecutiveHigh = 0;
  } else {
    
    state.consecutiveHigh = 0;
    state.consecutiveLow = 0;
  }

  
  const sinceLastScale = Date.now() - state.lastScaleAt;
  if (sinceLastScale < CONFIG.COOLDOWN_AFTER_SCALE_MS) {
    return; 
  }

  
  if (
    state.consecutiveHigh >= CONFIG.SCALE_UP_AFTER_N &&
    replicas < CONFIG.MAX_REPLICAS
  ) {
    console.log(
      `[DECISION] SCALE UP: p95=${p95.toFixed(1)}мс > ${CONFIG.SCALE_UP_THRESHOLD_MS}мс ` +
        `(${state.consecutiveHigh} циклов подряд), реплик ${replicas} -> ${replicas + 1}`,
    );
    try {
      await scaleUp();
      state.lastScaleAt = Date.now();
      state.consecutiveHigh = 0;
    } catch (err) {
      console.error(`[ACTION] Ошибка scale up: ${err.message}`);
    }
  } else if (
    state.consecutiveLow >= CONFIG.SCALE_DOWN_AFTER_N &&
    replicas > CONFIG.MIN_REPLICAS
  ) {
    console.log(
      `[DECISION] SCALE DOWN: p95=${p95.toFixed(1)}мс < ${CONFIG.SCALE_DOWN_THRESHOLD_MS}мс ` +
        `(${state.consecutiveLow} циклов подряд), реплик ${replicas} -> ${replicas - 1}`,
    );
    try {
      await scaleDown();
      state.lastScaleAt = Date.now();
      state.consecutiveLow = 0;
    } catch (err) {
      console.error(`[ACTION] Ошибка scale down: ${err.message}`);
    }
  }
}


const express = require("express");
const app = express();

app.get("/health", (req, res) => res.status(200).send("OK"));

app.get("/status", async (req, res) => {
  res.json({
    config: {
      min: CONFIG.MIN_REPLICAS,
      max: CONFIG.MAX_REPLICAS,
      scaleUpThresholdMs: CONFIG.SCALE_UP_THRESHOLD_MS,
      scaleDownThresholdMs: CONFIG.SCALE_DOWN_THRESHOLD_MS,
      cooldownMs: CONFIG.COOLDOWN_AFTER_SCALE_MS,
    },
    state: {
      currentReplicas: state.currentReplicas,
      consecutiveHigh: state.consecutiveHigh,
      consecutiveLow: state.consecutiveLow,
      msSinceLastScale: Date.now() - state.lastScaleAt,
    },
  });
});

const PORT = 9100;
app.listen(PORT, () => {
  console.log(
    `[AUTOSCALER] Запущен. HTTP интерфейс на :${PORT}, опрос метрик каждые ${CONFIG.EVALUATION_INTERVAL_MS}мс`,
  );
  console.log(
    `[AUTOSCALER] Политика: scale up if p95 > ${CONFIG.SCALE_UP_THRESHOLD_MS}мс ` +
      `(${CONFIG.SCALE_UP_AFTER_N} циклов), scale down if p95 < ${CONFIG.SCALE_DOWN_THRESHOLD_MS}мс ` +
      `(${CONFIG.SCALE_DOWN_AFTER_N} циклов)`,
  );
  console.log(
    `[AUTOSCALER] Границы: ${CONFIG.MIN_REPLICAS} <= replicas <= ${CONFIG.MAX_REPLICAS}`,
  );
});


setInterval(evaluationCycle, CONFIG.EVALUATION_INTERVAL_MS);


process.on("SIGTERM", () => {
  console.log("[AUTOSCALER] SIGTERM — завершение работы");
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("[AUTOSCALER] SIGINT — завершение работы");
  process.exit(0);
});
