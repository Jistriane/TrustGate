#!/usr/bin/env bash
# scripts/contract-security-check.sh
#
# MINIMUM security gate for smart contracts (L2 of ADR 0003).
#
# Behavior:
#   • IDEMPOTENT and NON-DESTRUCTIVE. Never alters files.
#   • RC = 0  → ALL available gates PASSED. Can deploy (as long as
#               L1 manual checklist of ADR 0003 §3 is also APPROVED
#               by 2 devs and L3 (audits) is OK for pubnet).
#   • RC = 77 → MISSING TOOLCHAIN. Not a "real failure" — it's absence of
#               evidence. In TODAY's CI, DON'T break the build. In a near
#               future (ADR 0003 §2 3B), RC=77 becomes a pubnet block.
#   • RC = any other value → REAL GATE FAILED. Fails build immediately.
#
# Usage:
#   ./scripts/contract-security-check.sh
#
# Levels:
#   L2.1  cargo build --release target wasm32-unknown-unknown (registry + escrow)
#   L2.2  cargo clippy -- -D warnings (registry + escrow)
#   L2.3  cargo test --workspace (registry + escrow)
#   L2.4  slither analysis  (runs IF and ONLY IF slither is installed;
#                             does NOT cause RC != 0 if slither missing, only logs WARN)
#
# ADR: docs/adr/0003-contract-security-analysis.md

set -euo pipefail

RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[1;33m'
BLU='\033[0;34m'
NC='\033[0m'

log_info()  { printf "${BLU}[contract-security]${NC}  %s\n" "$*"; }
log_ok()    { printf "${GRN}[contract-security ✅]${NC} %s\n" "$*"; }
log_warn()  { printf "${YEL}[contract-security ⚠️]${NC}  %s\n" "$*"; }
log_err()   { printf "${RED}[contract-security ❌]${NC}  %s\n" "$*" 1>&2; }

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd )"
cd "${REPO_ROOT}"

if [[ ! -f "${REPO_ROOT}/contracts/registry/Cargo.toml" ]]; then
  log_err "Not at the root of the TrustGate monorepo. Expected contracts/registry/Cargo.toml at ${REPO_ROOT}/contracts/registry/Cargo.toml — stopping RC=2"
  exit 2
fi

RUST_VERSION="${RUST_VERSION:-1.84.0}"
WASM_TARGET="wasm32-unknown-unknown"

log_info "REPO_ROOT=${REPO_ROOT}"
log_info "RUST_VERSION=${RUST_VERSION}. WASM_TARGET=${WASM_TARGET}."

if ! command -v rustup >/dev/null 2>&1; then
  log_warn "rustup is not installed on this machine (sandbox without Rust toolchain)."
  log_warn "  → skipping L2 build/clippy/test. This is NOT a FAIL (RC !=77), it's MISSING TOOLCHAIN."
  log_warn "  → To run this script for real, install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain=${RUST_VERSION}"
  log_warn "  → Then: rustup target add ${WASM_TARGET} && cargo install cargo-soroban --version=22.0.1 (version aligned with registry)."
  exit 77
fi

TOOLCHAIN="+${RUST_VERSION}"
if ! rustup toolchain list 2>/dev/null | grep -q "^${RUST_VERSION}"; then
  log_warn "rustup exists, but toolchain ${RUST_VERSION} is not installed."
  log_warn "  → To install: rustup toolchain install ${RUST_VERSION} && rustup target add --toolchain ${RUST_VERSION} ${WASM_TARGET}"
  exit 77
fi

if ! rustup target list --toolchain "${RUST_VERSION}" --installed 2>/dev/null | grep -q "^${WASM_TARGET}"; then
  log_warn "Toolchain ${RUST_VERSION} exists, but target ${WASM_TARGET} is not installed."
  log_warn "  → rustup target add --toolchain ${RUST_VERSION} ${WASM_TARGET}"
  exit 77
fi

run_per_contract() {
  local label="$1"; shift
  local phase="$1"; shift
  for contract_dir in contracts/registry contracts/escrow; do
    local contract_name; contract_name="$(basename "${contract_dir}")"
    log_info "[${phase} / ${contract_name}] ${label}"
    ( cd "${contract_dir}" && "$@" ) || {
      local rc=$?
      log_err "[${phase} / ${contract_name}] FAILED (RC=${rc})."
      exit "${rc}"
    }
  done
}

log_info "--- L2.1 cargo build release (WASM) ---"
run_per_contract "build release wasm" "L2.1" \
  cargo "${TOOLCHAIN}" build --target "${WASM_TARGET}" --release
log_ok "L2.1 build passed (registry + escrow)."

log_info "--- L2.2 cargo clippy -- -D warnings ---"
run_per_contract "clippy deny warnings" "L2.2" \
  cargo "${TOOLCHAIN}" clippy --all-targets -- -D warnings
log_ok "L2.2 clippy passed (registry + escrow)."

log_info "--- L2.3 cargo test --workspace ---"
run_per_contract "cargo test workspace" "L2.3" \
  cargo "${TOOLCHAIN}" test --workspace
log_ok "L2.3 tests passed (registry + escrow)."

log_info "--- L2.4 slither (best effort) ---"
if command -v slither >/dev/null 2>&1; then
  for contract_dir in contracts/registry contracts/escrow; do
    contract_name="$(basename "${contract_dir}")"
    if [[ -f "${contract_dir}/slither.config.json" || -f "${contract_dir}/foundry.toml" ]]; then
      log_info "[L2.4 / ${contract_name}] slither detected — running..."
      ( cd "${contract_dir}" && slither . --json - > "slither-report-${contract_name}.json" 2>slither-stderr-${contract_name}.log || true )
      log_warn "[L2.4 / ${contract_name}] slither ran. JSON report at slither-report-${contract_name}.json. We do NOT block the build on findings today (future ADR 0003 L2). Review manually."
    else
      log_warn "[L2.4 / ${contract_name}] slither installed, but there is NO slither.config.json nor foundry.toml in the contract (Soroban/Rust, not Solidity). Skipping with no RC."
    fi
  done
else
  log_warn "slither is not installed. To run: pip3 install slither-analyzer==0.10, install solc 0.8.28 via solc-select (if analyzing Solidity). TODAY it does NOT BLOCK the build."
fi

log_ok "=== ALL available L2 gates PASSED ==="
log_info "Next steps (BEFORE pubnet deploy, ADR 0003 §6):"
log_info "  → Ensure L1 §3 human approval (2 devs, signature + date)."
log_info "  → Run L3 fuzz (echidna / cargo-fuzz) and external audits (≥2)."
log_info "  → Validate RC=0 of this script on build machine / Docker image with toolchain."

exit 0
