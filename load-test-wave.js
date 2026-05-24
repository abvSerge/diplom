import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("errors");
const latency = new Trend("req_latency", true);

const BASE_URL = __ENV.BASE_URL || "http://gateway:3000";
const TARGET = __ENV.TARGET || "cursor";

const PATHS = {
  cached: "/api/posts?limit=20",
  cursor: "/api/posts/cursor?limit=20",
};
const REQUEST_PATH = PATHS[TARGET] || PATHS.cursor;

export const options = {
  stages: [
    { duration: "30s", target: 10 },

    { duration: "30s", target: 100 },
    { duration: "30s", target: 200 },

    { duration: "30s", target: 200 },

    { duration: "30s", target: 20 },

    { duration: "30s", target: 200 },

    { duration: "30s", target: 0 },
  ],
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  thresholds: {
    req_latency: ["p(95)<3000"],
    errors: ["rate<0.5"],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}${REQUEST_PATH}`);
  latency.add(res.timings.duration);
  errorRate.add(res.status !== 200);

  check(res, {
    "status is 200": (r) => r.status === 200,
  });
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify(
      {
        rps: data.metrics.iterations.values.rate,
        p95: data.metrics.req_latency.values["p(95)"],
        p99: data.metrics.req_latency.values["p(99)"],
        errorRate: data.metrics.errors.values.rate,
      },
      null,
      2,
    ),
    "/results/wave-summary.json": JSON.stringify(data, null, 2),
  };
}
