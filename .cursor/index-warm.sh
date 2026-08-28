#!/usr/bin/env bash
# Warm the AI retrieval indexes so a Cloud Agent can use semantic search from
# the first turn instead of degrading to grep/Read.
#
# Two independent indexes (they do NOT share data):
#   - codegraph : local code graph in <repo>/.codegraph (SQLite, no token).
#   - ACE       : uploaded to the team backend, cached in <repo>/.ace-tool.
#
# Warming is done via each tool's own CLI index mode (NOT an MCP call): the
# first cold `search_context` would try to upload the whole repo inside one MCP
# request and the host kills it with `MCP error -32001 Request timed out`.
# `--index-only` / `init|sync` scan, upload, and exit without starting a server.
#
# fail-soft by contract: every path returns 0, so a failed/absent index never
# blocks dependency install or a dev server. Idempotent: codegraph `sync` when
# an index already exists, else `init`.
#
# NOTE: intentionally NOT `set -e` — failures are handled explicitly to stay
# fail-soft. The token is only ever passed as "$ACE_TOKEN"; never echo argv
# (no `set -x`) so it cannot leak into logs.
set -uo pipefail

REPO="${1:-/workspace}"
# Deterministic + no network telemetry call during warm.
export CODEGRAPH_TELEMETRY=0

CODEGRAPH_PKG="@colbymchenry/codegraph"
ACE_PKG="@7iook/ace-tool-rs@0.1.17"

warm_codegraph() {
  if [ -d "$REPO/.codegraph" ]; then
    npx -y "$CODEGRAPH_PKG" sync "$REPO"
  else
    npx -y "$CODEGRAPH_PKG" init "$REPO"
  fi
}

warm_ace() {
  if [ -z "${ACE_TOKEN:-}" ] || [ -z "${ACE_BASE_URL:-}" ]; then
    echo "[index-warm] ACE_TOKEN/ACE_BASE_URL not set; skipping ACE index"
    return 0
  fi
  # --index-only indexes the CURRENT directory, so run from the repo root.
  ( cd "$REPO" && npx -y "$ACE_PKG" \
      --base-url "$ACE_BASE_URL" --token "$ACE_TOKEN" \
      --index-only --no-webbrowser-enhance-prompt )
}

echo "[index-warm] codegraph ($REPO)"
if warm_codegraph > /tmp/codegraph-index.log 2>&1; then
  echo "[index-warm] codegraph OK"
else
  echo "[index-warm] codegraph skipped/failed; see /tmp/codegraph-index.log"
fi

echo "[index-warm] ACE ($REPO)"
if warm_ace > /tmp/ace-index.log 2>&1; then
  echo "[index-warm] ACE OK"
else
  echo "[index-warm] ACE skipped/failed; see /tmp/ace-index.log"
fi

echo "[index-warm] done"
exit 0
