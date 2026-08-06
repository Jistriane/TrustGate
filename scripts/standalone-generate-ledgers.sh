#!/usr/bin/env bash
# scripts/standalone-generate-ledgers.sh
#
# ==============================================================================
# Utility: Advances ledger_sequence on Stellar Quickstart standalone via
# JSON-RPC method `generateLedger` (NOT available on real testnet/pubnet).
#
# Usage:
#   bash scripts/standalone-generate-ledgers.sh --target 260000 \
#       [--rpc-url http://localhost:8000/soroban/rpc] [--batch 500] [--sleep-ms 0]
#
# Example for claim_timeout: create escrow at ledger ~10000 → advance to 260000
# (10000 + 241920 = 251920 → safety margin ~8k → 260000):
#   bash scripts/standalone-generate-ledgers.sh --target 260000 --batch 500
#
# Requires: curl, jq (apt-get install jq).
# RC outputs: 0 = ok; 77 = tool/jq missing; 1 = RPC error; 2 = invalid args.
# ==============================================================================

set -euo pipefail

RPC_URL_DEFAULT="http://localhost:8000/soroban/rpc"
BATCH_SIZE_DEFAULT=500
SLEEP_MS_DEFAULT=0

RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[1;33m'
NC='\033[0m'
log_info()  { echo -e "[gen-ledgers ℹ️ ]  $*"; }
log_ok()    { echo -e "${GRN}[gen-ledgers ✅]${NC} $*"; }
log_warn()  { echo -e "${YEL}[gen-ledgers ⚠️ ]${NC} $*"; }
log_err()   { echo -e "${RED}[gen-ledgers ❌]${NC} $*" 1>&2; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

TARGET_SEQ=""
RPC_URL="$RPC_URL_DEFAULT"
BATCH_SIZE="$BATCH_SIZE_DEFAULT"
SLEEP_MS="$SLEEP_MS_DEFAULT"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target|-t)    TARGET_SEQ="${2:-}"; shift 2 ;;
    --rpc-url|-r)   RPC_URL="${2:-}";    shift 2 ;;
    --batch|-b)     BATCH_SIZE="${2:-}"; shift 2 ;;
    --sleep-ms|-s)  SLEEP_MS="${2:-}";   shift 2 ;;
    --help|-h)      usage ;;
    *)              log_err "Unknown arg: $1"; usage ;;
  esac
done

[[ -n "$TARGET_SEQ" ]] || { log_err "--target is required (ex: --target 260000)."; usage; }
[[ "$TARGET_SEQ" =~ ^[0-9]+$ ]] || { log_err "--target must be a positive integer (received: $TARGET_SEQ)."; exit 2; }
[[ "$BATCH_SIZE" =~ ^[0-9]+$  &&  "$BATCH_SIZE" -ge 1 ]] || { log_err "--batch must be >= 1."; exit 2; }
[[ "$SLEEP_MS"   =~ ^[0-9]+$ ]] || { log_err "--sleep-ms must be >= 0."; exit 2; }

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    log_err "Missing tool: $tool (apt-get install -y $tool). Exiting RC=77 (skipped)."
    exit 77
  }
done

get_current_seq() {
  local body
  body=$(curl -fsS -X POST "$RPC_URL" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":{}}' 2>/dev/null) || return 1
  local seq
  seq=$(jq -r '.result.sequence // empty' <<<"$body")
  [[ -n "$seq" ]] || return 1
  echo "$seq"
}

batch_generate_once() {
  # generateLedger returns only 1 ledger per call today (Soroban 22);
  # but we loop BATCH_SIZE times quickly in bash to simulate a batch.
  local i body seq
  for ((i = 0; i < BATCH_SIZE; i++)); do
    body=$(curl -fsS -X POST "$RPC_URL" \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"generateLedger","params":{}}' 2>/dev/null) || {
        log_err "RPC generateLedger failed on item $i of current batch."
        return 1
      }
    # Cheap sanity: if response has error → early exit.
    if jq -e '.error != null' <<<"$body" >/dev/null 2>&1; then
      log_err "RPC returned error in generateLedger: $(jq -c '.error' <<<"$body")."
      return 1
    fi
  done
  seq=$(get_current_seq) || return 1
  echo "$seq"
}

log_info "RPC_URL        = $RPC_URL"
log_info "TARGET_SEQ     = $TARGET_SEQ"
log_info "BATCH_SIZE     = $BATCH_SIZE (loops generateLedger per step)"
log_info "SLEEP_MS/step  = $SLEEP_MS"

CURRENT=$(get_current_seq) || {
  log_err "Could not read getLatestLedger. Check if docker/standalone is up at $RPC_URL."
  exit 77
}

log_info "Initial RPC sequence = $CURRENT."
if (( CURRENT >= TARGET_SEQ )); then
  log_ok "Current ledger $CURRENT is already >= target $TARGET_SEQ. Nothing to do. RC=0."
  exit 0
fi

TOTAL_NEEDED=$(( TARGET_SEQ - CURRENT ))
log_info "Ledgers to generate: $TOTAL_NEEDED (~$(( TOTAL_NEEDED / 60 / 12 )) min approx if batch=500 fast)."

START_TS=$(date +%s)
LAST_PRINTED_PCT=-1

while (( CURRENT < TARGET_SEQ )); do
  CURRENT=$(batch_generate_once) || exit 1
  DONE=$(( CURRENT < TARGET_SEQ ? CURRENT - (TARGET_SEQ - TOTAL_NEEDED) : TOTAL_NEEDED ))
  PCT=$(( DONE * 100 / TOTAL_NEEDED ))
  if (( PCT > LAST_PRINTED_PCT )); then
    NOW_TS=$(date +%s)
    ELAPSED=$(( NOW_TS - START_TS ))
    if (( PCT > 0 )); then
      ETA=$(( ELAPSED * (100 - PCT) / PCT ))
      log_info "progress: ${PCT}%  ledger=$CURRENT/$TARGET_SEQ  elapsed=${ELAPSED}s  eta~${ETA}s."
    else
      log_info "progress: ${PCT}%  ledger=$CURRENT/$TARGET_SEQ  warming up..."
    fi
    LAST_PRINTED_PCT=$PCT
  fi
  if (( SLEEP_MS > 0 )); then
    sleep "$(awk -v m="$SLEEP_MS" 'BEGIN{ printf "%.3f", m/1000 }')"
  fi
done

END_TS=$(date +%s)
log_ok "Done. ledger=$CURRENT (>= target $TARGET_SEQ). Total time: $(( END_TS - START_TS ))s. RC=0."
exit 0
