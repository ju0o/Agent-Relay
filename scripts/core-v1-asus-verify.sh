#!/usr/bin/env bash
set -euo pipefail

PRIMARY_REPO="${AGENT_RELAY_PRIMARY_REPO:-/home/skkse12/Desktop/Projects/Core/Agent-Relay}"
VERIFY_ROOT="${AGENT_RELAY_VERIFY_ROOT:-/home/skkse12/Desktop/Projects/Core/Agent-Relay-core-v1-pr8}"
VERIFY_BRANCH="${AGENT_RELAY_VERIFY_BRANCH:-feat/core-v1-auto-dev-team-01}"
DATA_ROOT="${AGENT_RELAY_VERIFY_DATA_ROOT:-$HOME/.local/share/AgentRelay/data/core-v1-pr8-verify}"
FOUNDER_OUTBOX="${AGENT_RELAY_VERIFY_FOUNDER_OUTBOX:-$HOME/.local/share/AgentRelay/data/founder-outbox/core-v1-pr8-verify}"

log() {
  printf '\n==> %s\n' "$*"
}

if ! git -C "$PRIMARY_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: Agent-Relay primary checkout not found: $PRIMARY_REPO" >&2
  exit 2
fi

log "Fetch PR #8 branch without touching the primary checkout"
git -C "$PRIMARY_REPO" fetch origin "$VERIFY_BRANCH"

log "Recreate isolated verification worktree"
git -C "$PRIMARY_REPO" worktree remove --force "$VERIFY_ROOT" >/dev/null 2>&1 || true
rm -rf "$VERIFY_ROOT"
git -C "$PRIMARY_REPO" worktree prune
git -C "$PRIMARY_REPO" worktree add --detach "$VERIFY_ROOT" "origin/$VERIFY_BRANCH"

cd "$VERIFY_ROOT"

log "Verification target"
printf 'repo: %s\nbranch: %s\nhead: %s\n' "$VERIFY_ROOT" "$VERIFY_BRANCH" "$(git rev-parse HEAD)"

log "Install exact dependencies"
npm ci

log "Run focused CORE V1 tests"
npm run test:core-v1

log "Run full test suite"
npm test

export AGENT_RELAY_DATA_ROOT="$DATA_ROOT"
export AGENT_RELAY_FOUNDER_OUTBOX="$FOUNDER_OUTBOX"

log "Reset verification-only CORE V1 state"
rm -rf "$DATA_ROOT" "$FOUNDER_OUTBOX"

log "Check initial CORE V1 status"
npm exec -- agent-relay core-v1 status

log "Run one real PM -> Worker -> QA -> promotion -> NEXT cycle"
npm exec -- agent-relay core-v1 once

log "Founder-readable result inbox"
npm exec -- agent-relay core-v1 results

log "Machine-readable result inbox"
npm exec -- agent-relay core-v1 results --json | tee /tmp/agent-relay-core-v1-pr8-results.json

log "Verification finished"
echo "RESULT_JSON=/tmp/agent-relay-core-v1-pr8-results.json"
echo "VERIFY_WORKTREE=$VERIFY_ROOT"
