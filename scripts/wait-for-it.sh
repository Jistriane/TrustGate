#!/usr/bin/env bash
# wait-for-it.sh — block until a TCP host:port is accepting connections,
# then exec the given command. Chain multiple targets via repeated `--`:
#   wait-for-it.sh host1:port1 -- wait-for-it.sh host2:port2 -- cmd args...
#
# Internal variables are prefixed WFI_ so they can't shadow an inherited
# environment variable like PORT — a plain reassignment of an
# already-exported shell variable keeps it exported, which would otherwise
# leak into the final exec'd command with the wrong value.
set -e

WFI_TIMEOUT=30
WFI_QUIET=0

wfi_usage() {
  echo "Usage: $0 host:port [-t timeout] [-q] -- command args..." >&2
  exit 1
}

if [ "$#" -lt 1 ]; then
  wfi_usage
fi

WFI_HOSTPORT="$1"
shift

WFI_HOST="${WFI_HOSTPORT%%:*}"
WFI_PORT="${WFI_HOSTPORT##*:}"

if [ -z "$WFI_HOST" ] || [ -z "$WFI_PORT" ] || [ "$WFI_HOST" = "$WFI_PORT" ]; then
  echo "Error: invalid host:port \"$WFI_HOSTPORT\"" >&2
  wfi_usage
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    -t)
      WFI_TIMEOUT="$2"
      shift 2
      ;;
    -q)
      WFI_QUIET=1
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      wfi_usage
      ;;
  esac
done

wfi_wait_for() {
  local wfi_start
  wfi_start=$(date +%s)
  while true; do
    if (exec 3<>"/dev/tcp/$WFI_HOST/$WFI_PORT") 2>/dev/null; then
      exec 3>&- 3<&-
      return 0
    fi
    if [ "$(($(date +%s) - wfi_start))" -ge "$WFI_TIMEOUT" ]; then
      return 1
    fi
    sleep 1
  done
}

if [ "$WFI_QUIET" -ne 1 ]; then
  echo "wait-for-it: waiting up to ${WFI_TIMEOUT}s for $WFI_HOST:$WFI_PORT..."
fi

if wfi_wait_for; then
  if [ "$WFI_QUIET" -ne 1 ]; then
    echo "wait-for-it: $WFI_HOST:$WFI_PORT is available."
  fi
  if [ "$#" -gt 0 ]; then
    exec "$@"
  fi
  exit 0
else
  echo "wait-for-it: timed out waiting for $WFI_HOST:$WFI_PORT after ${WFI_TIMEOUT}s." >&2
  exit 1
fi
