#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PACKAGE_ROOT="$WORKER_DIR"

PORT=${VAULT_TEST_PORT:-18788}
OUTPUT_FILE="${1:-$WORKER_DIR/.sisyphus/evidence/task-19-vault-crud.txt}"
mkdir -p "$(dirname "$OUTPUT_FILE")"

echo "Starting Wrangler dev on port $PORT..."

wrangler dev --local --ip 127.0.0.1 --port "$PORT" \
  test/vault-crud-e2e.worker.ts \
  --var EMAIL_VERIFY_ON_SIGNUP:false \
  &> /tmp/wrangler-vault-test.log &
WRANGLER_PID=$!

trap 'kill $WRANGLER_PID 2>/dev/null' EXIT

wait_for_worker() {
  for i in $(seq 1 60); do
    if curl -s "http://127.0.0.1:$PORT/healthcheck" > /dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Timed out waiting for worker"
  cat /tmp/wrangler-vault-test.log
  return 1
}

wait_for_worker

echo "Worker ready. Running vault CRUD tests..."

{
  echo "=== Vault CRUD E2E Test Results ==="
  echo "Date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "Worker: http://127.0.0.1:$PORT"
  echo "====================================="
  echo ""

  curl -s "http://127.0.0.1:$PORT/vault-crud-tests"
} | tee "$OUTPUT_FILE"

echo ""
echo "Evidence written to: $OUTPUT_FILE"
