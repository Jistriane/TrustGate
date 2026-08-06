#!/usr/bin/env bash
# scripts/soroban-healthcheck.sh
# ================================
# P3 V16 sanity smoke check.
# Validates 4 pillars in <5s:
#   (1) basic rustup/cargo toolchain (rustc, cargo, wasm32 target)
#   (2) soroban CLI 22.x installed and working
#   (3) docker + standalone Soroban containers are UP (if docker exists)
#   (4) local RPC (http://localhost:8000/soroban/rpc) responding (if it exists)
#
# Will exit RC=0 on WORKING MACHINE. RC!=0 with messages indicating what's missing
# (doesn't break build; ideal for CI pre-deploy stage before anything else).
#
# Usage:
#   npm run health:soroban
#   OR bash scripts/soroban-healthcheck.sh

set -uo pipefail

GRN='\033[0;32m' ; RED='\033[0;31m' ; YEL='\033[1;33m' ; NC='\033[0m'
pass(){ printf "${GRN}[PASS]${NC}  %s\n" "$*"; ((OK++)) || true; }
warn(){ printf "${YEL}[WARN]${NC}  %s\n" "$*"; ((WARN++)) || true; }
fail(){ printf "${RED}[FAIL]${NC}  %s\n" "$*" 1>&2; ((FAIL++)) || true; }

OK=0
FAIL=0
WARN=0

echo "==> Soroban Healthcheck (V16) <=="

# 1) Basic Rust toolchain
echo
echo "--- 1. Rust toolchain ---"
if command -v rustc >/dev/null 2>&1; then
  rv=$(rustc --version 2>/dev/null | head -1)
  pass "rustc: ${rv}"
else
  fail "rustc NOT installed. Install: https://rustup.rs"
  ((FAIL++))
fi
if command -v cargo >/dev/null 2>&1; then
  pass "cargo: $(cargo --version 2>/dev/null | head -1)"
  if rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
    pass "target: wasm32-unknown-unknown installed"
  else
    warn "target wasm32-unknown-unknown NOT installed. You can run: rustup target add wasm32-unknown-unknown"
    ((WARN++))
  fi
else
  fail "cargo NOT installed."
  ((FAIL++))
fi

# 2) Soroban CLI
echo
echo "--- 2. Soroban CLI 22.x ---"
if command -v soroban >/dev/null 2>&1; then
  sv=$(soroban --version 2>/dev/null | head -1)
  echo "$sv" | grep -qE "^soroban [@/ ]?22\." 2>/dev/null \
    && pass "soroban: ${sv} (expected major 22.x match)" \
    || { warn "soroban version does not appear to be 22.x: ${sv}. Update (e.g.: cargo install soroban-cli --locked --version 22.0.1)"; ((WARN++)); }
else
  fail "soroban CLI NOT installed. Install: cargo install soroban-cli --locked --version 22.0.1"
  ((FAIL++))
fi

# 3) Docker + standalone Soroban containers (optional — only warn if docker exists but containers down)
echo
echo "--- 3. Docker + standalone Soroban (optional) ---"
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    pass "docker daemon accessible"
    n_soroban=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -ciE "soroban|stellar" || true)
    if [[ "$n_soroban" -ge 1 ]]; then
      pass "containers Soroban/Stellar UP: ${n_soroban}"
    else
      warn "No Soroban containers running (npm run services:up to start standalone)."
      ((WARN++))
    fi
  else
    warn "docker installed but daemon is NOT running (maybe needs sudo?)."
    ((WARN++))
  fi
else
  warn "docker not installed (ok, testnet/pubnet deploy does not need local docker)."
  ((WARN++))
fi

# 4) Local RPC (optional)
echo
echo "--- 4. Local RPC http://localhost:8000/soroban/rpc (optional) ---"
if command -v curl >/dev/null 2>&1; then
  if curl -sf -X POST http://localhost:8000/soroban/rpc \
       -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
       --max-time 2 2>/dev/null | grep -qE '"status"|"healthy"'; then
    pass "Soroban standalone RPC (8000) is healthy."
  else
    warn "Local Soroban RPC did NOT respond in 2s (standalone off? or just using testnet/pubnet remote RPC?)"
    ((WARN++))
  fi
else
  warn "curl not available (skipping RPC check)."
  ((WARN++))
fi

echo
echo "==> Summary: ${GRN}PASS=$OK${NC} ${YEL}WARN=$WARN${NC} ${RED}FAIL=$FAIL${NC} <=="
if [[ "$FAIL" -gt 0 ]]; then
  echo -e "Result: ${RED}WITH FAILURES (RC=2)${NC} — fix FAILs before standalone deploy."
  exit 2
fi
if [[ "$WARN" -gt 0 ]]; then
  echo -e "Result: ${YEL}WARNINGS (RC=1)${NC} — toolchain OK but optional items missing (ok for pubnet/testnet remote RPC)."
  exit 1
fi
echo -e "Result: ${GRN}HEALTHY (RC=0)${NC} — ready for local standalone + deploy contracts."
exit 0
