#!/usr/bin/env bash
set -euo pipefail

RPC_URL="${STELLAR_RPC_URL:-http://localhost:8000/soroban/rpc}"
MAX_ATTEMPTS=30
DELAY=2

echo "Checking Stellar Quickstart at ${RPC_URL}..."

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  if curl -s -f "http://localhost:8000/health" > /dev/null 2>&1; then
    echo "Stellar Quickstart is healthy (attempt ${attempt}/${MAX_ATTEMPTS})."
    exit 0
  fi
  echo "Attempt ${attempt}/${MAX_ATTEMPTS}: not ready yet, retrying in ${DELAY}s..."
  sleep "$DELAY"
done

echo "Stellar Quickstart failed health check after ${MAX_ATTEMPTS} attempts." >&2
exit 1
