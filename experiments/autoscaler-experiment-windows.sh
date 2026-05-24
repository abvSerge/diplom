#!/bin/bash

# Эксперимент 2: реакция автоскейлера на пилообразную нагрузку.

set -e


export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

RESULTS_DIR="results/autoscaler-experiment-$(date +%Y%m%d-%H%M%S)"
TIMESERIES_FILE="$RESULTS_DIR/timeseries.csv"
LOG_FILE="$RESULTS_DIR/autoscaler.log"

mkdir -p "$RESULTS_DIR"


HAS_JQ=1
if ! command -v jq &> /dev/null; then
  HAS_JQ=0
  echo "ВНИМАНИЕ: jq не установлен — сбор временных рядов будет упрощённый."
  echo "Установка jq для Windows: https://stedolan.github.io/jq/download/"
  echo "Или: choco install jq  (если есть Chocolatey)"
  echo ""
fi

echo "=============================================="
echo "Эксперимент: реакция автоскейлера"
echo "Длительность нагрузки: ~3.5 минуты"
echo "Результаты: $RESULTS_DIR"
echo "=============================================="

# 1. Поднимаем стенд (без k6) с одной репликой
echo ""
echo ">>> Подъём стенда (postgres, redis, gateway, nginx, autoscaler, prometheus)"
docker compose up -d postgres redis nginx gateway prometheus grafana autoscaler

echo ">>> Ожидание готовности (45 сек: инициализация БД, прогрев)"
sleep 45

# 2. Прогрев кеша
echo ">>> Прогрев кеша"
for i in $(seq 1 20); do
  curl -s http://localhost:3000/api/posts?limit=20 > /dev/null
done

# 3. Запускаем сбор временных рядов в фоне
echo ">>> Запуск сбора метрик в фоне (раз в 3 сек)"
echo "timestamp,replicas,p95_ms,consecutive_high,consecutive_low" > "$TIMESERIES_FILE"

(
  while true; do
    TS=$(date +%s)
    STATUS=$(curl -s http://localhost:9100/status 2>/dev/null || echo '')

    if [ -n "$STATUS" ]; then
      if [ "$HAS_JQ" -eq 1 ]; then
        REPLICAS=$(echo "$STATUS" | jq -r '.state.currentReplicas // "n/a"')
        UP=$(echo "$STATUS" | jq -r '.state.consecutiveHigh // 0')
        DOWN=$(echo "$STATUS" | jq -r '.state.consecutiveLow // 0')

        
        PROM_QUERY='histogram_quantile(0.95, sum(rate(gateway_request_duration_seconds_bucket[15s])) by (le))'
        P95=$(curl -s "http://localhost:9090/api/v1/query" \
          --data-urlencode "query=$PROM_QUERY" \
          | jq -r '.data.result[0].value[1] // "0"')
        P95_MS=$(awk "BEGIN{printf \"%.1f\", $P95 * 1000}" 2>/dev/null || echo "0")
      else
       
        REPLICAS=$(echo "$STATUS" | grep -o '"currentReplicas":[^,}]*' | grep -o '[0-9]*' | head -1)
        UP=$(echo "$STATUS" | grep -o '"consecutiveHigh":[^,}]*' | grep -o '[0-9]*' | head -1)
        DOWN=$(echo "$STATUS" | grep -o '"consecutiveLow":[^,}]*' | grep -o '[0-9]*' | head -1)
        P95_MS="n/a"
      fi

      echo "$TS,${REPLICAS:-n/a},${P95_MS:-0},${UP:-0},${DOWN:-0}" >> "$TIMESERIES_FILE"
    fi
    sleep 3
  done
) &
COLLECTOR_PID=$!


docker compose logs -f autoscaler > "$LOG_FILE" 2>&1 &
LOGGER_PID=$!

# 5. Запуск нагрузочного теста
echo ""
echo ">>> Запуск k6 (пилообразная нагрузка, ~3.5 минуты)"
echo ""


docker compose run --rm \
  -e TARGET=cursor \
  -v "$(pwd)/$RESULTS_DIR:/results" \
  k6 run //load-test-wave.js


echo ""
echo ">>> Завершение сбора метрик"
kill $COLLECTOR_PID 2>/dev/null || true
kill $LOGGER_PID 2>/dev/null || true


echo ""
echo "=============================================="
echo "Эксперимент завершён"
echo ""
echo "Файлы:"
echo "  $TIMESERIES_FILE       — временной ряд (для графика)"
echo "  $LOG_FILE              — журнал решений автоскейлера"
echo "  $RESULTS_DIR/wave-summary.json — итоги k6"
echo ""
echo "Сводка действий автоскейлера:"
grep -E '\[DECISION\]|\[ACTION\]' "$LOG_FILE" | head -30 || echo "(нет решений в логе)"
echo ""
echo "Финальное число реплик:"
docker ps --filter "label=com.docker.compose.service=post-service" --format "table {{.Names}}\t{{.Status}}"
echo "=============================================="
