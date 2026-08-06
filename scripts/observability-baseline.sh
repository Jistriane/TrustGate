#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

usage() {
  cat <<'EOF'
Usage: scripts/observability-baseline.sh [OPTIONS]

Observability full-stack validation baseline:
  1/6 Spin Prometheus + Grafana + TrustGate via docker compose
  2/6 Wait healthy (app / Prom / Grafana)
  3/6 TypeScript smoke checks (signed requests + metrics scrape)
  4/6 Prom rule groups + targets sanity
  5/6 Grafana dashboards + datasource provision sanity
  6/6 RC=0 → success

Options:
  --keep      Keep docker compose stack running after baseline succeeds
              (useful for local development, manual exploration, debug).
              Default: stack is torn down on EXIT/ERR/INT/TERM traps.
  -h, --help  Show this help and exit.

Environment variables (optional overrides):
  APP_URL         Default http://127.0.0.1:3000
  PROM_URL        Default http://127.0.0.1:9090
  GRAFANA_URL     Default http://127.0.0.1:3001
  COMPOSE_FILE    Default compose/observability/docker-compose.yml
EOF
}

KEEP_STACK="0"
for arg in "${@:-}"; do
  case "${arg}" in
    --keep)
      KEEP_STACK="1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[baseline][ERR] Unknown argument: ${arg}" >&2
      echo "" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log() {
  echo "[baseline] $*"
}

fail() {
  echo "[baseline][FAIL] $*" >&2
  exit 1
}

for bin in docker node npm; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    fail "required binary missing: ${bin}"
  fi
done

if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose is required (docker compose version failed)"
fi

log "1/6: Preflight parse (YAML alerts + Grafana JSON dashboards)"
node -e '
const fs = require("fs");
const path = require("path");
const root = process.cwd();

function requireFile(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) throw new Error("missing file: " + rel);
  return p;
}

function parseDashboard(p) {
  const raw = fs.readFileSync(p, "utf8");
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { throw new Error("invalid JSON: " + p + " :: " + e.message); }
  if (!obj || typeof obj !== "object") throw new Error("dashboard not an object: " + p);
  if (!obj.title || typeof obj.title !== "string") throw new Error("dashboard missing title: " + p);
  const panels = Array.isArray(obj.panels) ? obj.panels : [];
  if (panels.length === 0) throw new Error("dashboard has no panels: " + p);
  for (const panel of panels) {
    if (!panel || typeof panel !== "object") throw new Error("panel not object in " + p);
    if (panel.id == null) throw new Error("panel missing id in " + p);
    const targets = Array.isArray(panel.targets) ? panel.targets : [];
    if (targets.length === 0) continue;
    for (const t of targets) {
      if (!t || typeof t.expr !== "string") {
        // Some panel types (stat/gauge) may have no expr; skip strictly only if datasource type is expected with targets.
        // To be safe, fail only if panel explicitly declares targets array but entry has no expr.
        if (Array.isArray(panel.targets)) {
          // allow empty; but if entry exists and has no expr when panel is a "timeseries/prom backed", require expr.
          const type = String(panel.type || "");
          if (/timeseries|graph|stat|gauge|table/.test(type) && typeof t === "object" && t && !("expr" in t)) {
            throw new Error("panel target missing expr: " + p + " panelId=" + panel.id);
          }
        }
      }
    }
  }
  return true;
}

// Minimal YAML parser supporting alert rules file format (groups/rules/expr).
function parseAlertYaml(p) {
  const raw = fs.readFileSync(p, "utf8");
  const lines = raw.split(/\r?\n/);
  const tokens = [];
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/,"");
    if (!trimmed || /^\s*#/.test(trimmed)) continue;
    const indent = (trimmed.match(/^(\s*)/)[1] || "").length;
    const rest = trimmed.slice(indent);
    tokens.push({ indent, rest });
  }
  // Root must have groups array
  const root = { groups: null };
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const key = t.rest.split(":")[0];
    if (key === "groups") {
      root.groups = [];
      // consume indent children
      const baseIndent = t.indent;
      i++;
      // Groups array items are "- name:" entries; each has rules array which has "- alert:" with expr.
      let group = null;
      let inRules = false;
      let rule = null;
      while (i < tokens.length && tokens[i].indent > baseIndent) {
        const it = tokens[i];
        if (it.indent === baseIndent + 2 && /^-\s+name:/.test(it.rest)) {
          const name = it.rest.replace(/^-\s+name:\s*/,"").trim();
          if (!name) throw new Error("group missing name in " + p);
          group = { name, rules: [] };
          root.groups.push(group);
          inRules = false;
          rule = null;
        } else if (group && it.indent === baseIndent + 4 && /^rules:/.test(it.rest)) {
          inRules = true;
        } else if (group && inRules && it.indent === baseIndent + 6 && /^-\s+alert:/.test(it.rest)) {
          const alertName = it.rest.replace(/^-\s+alert:\s*/,"").trim();
          if (!alertName) throw new Error("alert missing name in " + p);
          rule = { alert: alertName, expr: null };
          group.rules.push(rule);
        } else if (group && inRules && rule && it.indent === baseIndent + 8 && /^expr:/.test(it.rest)) {
          const expr = it.rest.replace(/^expr:\s*/,"").trim();
          if (!expr) throw new Error("expr empty in alert " + rule.alert + " (" + p + ")");
          rule.expr = expr;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  if (!Array.isArray(root.groups) || root.groups.length === 0) throw new Error("no groups in alerts file: " + p);
  for (const g of root.groups) {
    if (!g.rules || g.rules.length === 0) throw new Error("group \"" + g.name + "\" has no rules in " + p);
    for (const r of g.rules) {
      if (!r.expr) throw new Error("alert \"" + r.alert + "\" has no expr in " + p);
    }
  }
  return true;
}

const alerts = requireFile("prom/alerts/trustgate-alerts.yml");
parseAlertYaml(alerts);

const dashDir = path.join(root, "grafana", "dashboards");
const dashboards = fs.readdirSync(dashDir).filter(f => f.endsWith(".json"));
if (dashboards.length === 0) throw new Error("no dashboards found in " + dashDir);
for (const f of dashboards) parseDashboard(path.join(dashDir, f));

console.log("OK: parsed " + dashboards.length + " dashboard(s) and alerts groups");
'

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-trustgate-baseline-$(head -c 6 /dev/urandom | xxd -p -c 12)}"
export COMPOSE_PROJECT_NAME

COMPOSE_FILES=(-f docker-compose.yml)
if [[ -f docker-compose.observability.yml ]]; then
  COMPOSE_FILES+=(-f docker-compose.observability.yml)
fi
export COMPOSE_FILES

log "2/6: Starting stack with project=${COMPOSE_PROJECT_NAME}"
docker compose "${COMPOSE_FILES[@]}" up --build -d

cleanup() {
  local exit_code=$?
  if [[ "${KEEP_STACK}" == "1" ]]; then
    log "keep=1; skipping cleanup."
    log "to teardown later: COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME} docker compose ${COMPOSE_FILES[*]} down -v --remove-orphans"
  else
    log "cleanup: tearing down project=${COMPOSE_PROJECT_NAME}"
    docker compose "${COMPOSE_FILES[@]}" down -v --remove-orphans || true
  fi
  if [[ ${exit_code} -ne 0 ]]; then
    fail "baseline failed (exit=${exit_code})"
  fi
}
trap cleanup EXIT ERR INT TERM

log "3/6: Waiting for app/prom/grafana to become healthy"
APP_URL="${APP_URL:-http://127.0.0.1:3000}"
PROM_URL="${PROM_URL:-http://127.0.0.1:9090}"
GRAFANA_URL="${GRAFANA_URL:-http://127.0.0.1:3001}"

wait_for() {
  local name="$1"; local url="$2"; local expected_substr="$3"
  local tries=120; local delay=2
  for ((i=1;i<=tries;i++)); do
    local code
    code=$(curl -sS -o /tmp/baseline_last_body.$$ -w "%{http_code}" --max-time 10 "${url}" || echo "000")
    local body
    body=$(cat /tmp/baseline_last_body.$$ 2>/dev/null || echo "")
    rm -f /tmp/baseline_last_body.$$ || true
    if [[ "${code}" =~ ^2[0-9][0-9]$ ]]; then
      if [[ -z "${expected_substr}" || "${body}" == *"${expected_substr}"* ]]; then
        log "  ${name} ready (${url} -> ${code})"
        return 0
      fi
    fi
    sleep "${delay}"
  done
  fail "timed out waiting for ${name} (${url})"
}

wait_for "app" "${APP_URL}/health" '"status":"ok"'
wait_for "prometheus-ready" "${PROM_URL}/-/ready" "Prometheus Server is Ready"

# Grafana /api/health returns JSON whose spacing varies between versions
# ("database":"ok" vs "database": "ok" vs "database"  :  "ok"). Use a tolerant
# POSIX ERE regex via grep instead of a fixed substring, to avoid false timeouts.
# wait_for() does not take a regex natively, so Grafana is validated inline.
grafana_tries=120; grafana_delay=2
for ((i=1;i<=grafana_tries;i++)); do
  code=$(curl -sS -o /tmp/baseline_grafana_body.$$ -w "%{http_code}" --max-time 10 "${GRAFANA_URL}/api/health" || echo "000")
  body=$(cat /tmp/baseline_grafana_body.$$ 2>/dev/null || echo "")
  rm -f /tmp/baseline_grafana_body.$$ || true
  if [[ "${code}" =~ ^2[0-9][0-9]$ ]] && grep -qE '"database"[[:space:]]*:[[:space:]]*"ok"' <<<"${body}"; then
    log "  grafana-health ready (${GRAFANA_URL}/api/health -> ${code})"
    break
  fi
  if [[ "$i" -eq "$grafana_tries" ]]; then
    fail "timed out waiting for grafana-health (${GRAFANA_URL}/api/health)"
  fi
  sleep "${grafana_delay}"
done

log "4/6: Run TypeScript checks (signed smoke + metrics + prom + grafana)"
BASELINE_APP_URL="${APP_URL}" \
BASELINE_PROM_URL="${PROM_URL}" \
BASELINE_GRAFANA_URL="${GRAFANA_URL}" \
  npx ts-node --transpile-only scripts/observability-baseline-checks.ts

log "5/6: Prometheus rule groups + targets sanity (curl smoke)"
RULES_JSON="$(curl -sS --max-time 20 "${PROM_URL}/api/v1/rules")"
if ! grep -q '"status":"success"' <<<"${RULES_JSON}"; then fail "prometheus /api/v1/rules did not return success"; fi
if ! grep -q '"trustgate-worker"' <<<"${RULES_JSON}" && ! grep -q '"trustgate-auth"' <<<"${RULES_JSON}"; then fail "prometheus rules groups missing trustgate-*"; fi

log "6/6: Baseline passed"
echo "  project: ${COMPOSE_PROJECT_NAME}"
echo "  app: ${APP_URL}"
echo "  prom: ${PROM_URL}"
echo "  grafana: ${GRAFANA_URL}"
