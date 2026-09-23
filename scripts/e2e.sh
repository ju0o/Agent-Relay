#!/usr/bin/env bash
# Offline temp-directory E2E: build:server, build:client, portfolio-runner tests.
# Stdout contract: exactly one JSON line {"ok":bool,"steps":[{name,ok}],"ms":num}.
# All progress/logs go to stderr or temp files, never stdout.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E_TMP="$(mktemp -d "${TMPDIR:-/tmp}/agent-relay-e2e-XXXXXX")"
trap 'rm -rf "$E2E_TMP"' EXIT
mkdir -p "$E2E_TMP/data"

now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local t="${EPOCHREALTIME/./}"
    printf '%s' "${t:0:13}"
  else
    printf '%s000' "$(date +%s)"
  fi
}

START_MS="$(now_ms)"
STEPS="build:server build:client test:v2:runner typecheck"
RESULTS=""
OVERALL_OK=1

echo "[e2e] root=$ROOT tmp=$E2E_TMP" >&2

for step in $STEPS; do
  log="$E2E_TMP/${step//:/_}.log"
  echo "[e2e] run: npm run $step (log: $log)" >&2
  if (cd "$ROOT" && npm_config_offline=true AGENT_RELAY_DATA_ROOT="$E2E_TMP/data" npm run "$step" >"$log" 2>&1); then
    ok="true"
    echo "[e2e] ok: $step" >&2
  else
    code=$?
    ok="false"
    OVERALL_OK=0
    echo "[e2e] FAIL: $step (exit $code, tail of $log):" >&2
    tail -n 20 "$log" >&2 || true
  fi
  entry="{\"name\":\"$step\",\"ok\":$ok}"
  if [ -z "$RESULTS" ]; then
    RESULTS="$entry"
  else
    RESULTS="$RESULTS,$entry"
  fi
done

END_MS="$(now_ms)"
MS=$((END_MS - START_MS))
if [ "$OVERALL_OK" -eq 1 ]; then OK="true"; else OK="false"; fi

printf '{"ok":%s,"steps":[%s],"ms":%s}\n' "$OK" "$RESULTS" "$MS"
