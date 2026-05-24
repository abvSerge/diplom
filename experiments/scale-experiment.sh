#!/bin/bash
# Эксперимент: зависимость пропускной способности от числа реплик post-service.
#
# Гипотеза: пропускная способность системы растёт линейно с числом реплик
# stateless-сервиса до точки, в которой узким местом становится shared
# resource (БД или сеть). Закон Амдала.
#
# Метод: серия нагрузочных тестов k6 (профиль stress) при N реплик.
# Результаты сохраняются в results/scale-N/summary.json и сводную таблицу.
#
# Использование:
#   chmod +x experiments/scale-experiment.sh
#   ./experiments/scale-experiment.sh


set -e

REPLICAS_LIST=(1 2 3 5 7 10)
RESULTS_DIR="results/scale-experiment-$(date +%Y%m%d-%H%M%S)"
SUMMARY_FILE="$RESULTS_DIR/summary.csv"

mkdir -p "$RESULTS_DIR"


echo "replicas,rps,p95_ms,p99_ms,errors_pct,total_requests" > "$SUMMARY_FILE"

echo "=============================================="
echo "Эксперимент: RPS vs число реплик post-service"
echo "Результаты: $RESULTS_DIR"
echo "=============================================="

for N in "${REPLICAS_LIST[@]}"; do
  echo ""
  echo ">>> Прогон с N=$N репликами"
  echo ""

  
  docker compose up -d --scale post-service=$N postgres redis nginx gateway

  
  echo "Ожидание готовности реплик..."
  sleep 30

  
  echo "Прогрев кеша..."
  for i in {1..10}; do
    curl -s http://localhost:3000/api/posts?limit=20 > /dev/null
  done

 
  echo "Запуск нагрузочного теста k6 (профиль stress)..."
  docker compose run --rm \
    -e TARGET=cursor \
    -e MODE=stress \
    -v "$(pwd)/$RESULTS_DIR:/results" \
    k6 run /load-test.js --summary-export=/results/run-N$N.json

 
  if command -v jq &> /dev/null; then
    RPS=$(jq -r '.metrics.iterations.rate // "n/a"' "$RESULTS_DIR/run-N$N.json")
    P95=$(jq -r '.metrics.req_latency["p(95)"] // "n/a"' "$RESULTS_DIR/run-N$N.json")
    P99=$(jq -r '.metrics.req_latency["p(99)"] // "n/a"' "$RESULTS_DIR/run-N$N.json")
    ERRORS=$(jq -r '(.metrics.errors.rate * 100) // "n/a"' "$RESULTS_DIR/run-N$N.json")
    TOTAL=$(jq -r '.metrics.iterations.count // "n/a"' "$RESULTS_DIR/run-N$N.json")

    echo "$N,$RPS,$P95,$P99,$ERRORS,$TOTAL" >> "$SUMMARY_FILE"
    echo ">>> N=$N: RPS=$RPS, p95=${P95}мс, p99=${P99}мс, errors=${ERRORS}%"
  else
    echo "ВНИМАНИЕ: jq не установлен — пропуск автоматического сбора метрик"
    echo "Установите: sudo apt install jq"
  fi


  sleep 10
done

echo ""
echo "=============================================="
echo "Эксперимент завершён"
echo "Сводная таблица: $SUMMARY_FILE"
echo "=============================================="
cat "$SUMMARY_FILE"


docker compose down
