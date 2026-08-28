#!/usr/bin/env bash
# Cloud Agent install script for Codeg.
#
# Idempotent by design: safe to run repeatedly and on top of a warm
# environment-build snapshot (system packages, toolchains, node_modules and the
# cargo registry are all no-ops on a second run).
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# 1. System libraries required by the Rust server / mcp build.
#    - libssl-dev + pkg-config: reqwest defaults to native-tls, which links
#      OpenSSL; pkg-config locates it at build time.
#    node:*-bookworm images ship pkg-config but not libssl-dev, so install both
#    when either is missing. No-op once present.
if ! dpkg -s libssl-dev >/dev/null 2>&1 || ! command -v pkg-config >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq --no-install-recommends pkg-config libssl-dev
fi

# 2. Rust toolchain. The vendored `src-tauri/vendor/sacp-tokio` crate declares
#    edition2024, which was stabilised in Rust 1.85; the image's pinned default
#    can be older. CI builds on `stable` (unpinned), so match that here.
rustup toolchain install stable --profile minimal --component clippy --no-self-update
rustup default stable

# 3. Frontend dependencies + generated assets. The `postinstall` hook copies the
#    Monaco editor assets into public/vs. --frozen-lockfile honours the committed
#    pnpm-lock.yaml (fails instead of silently updating it).
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

# 4. Pre-fetch the Rust crate graph so the first server build is offline-fast.
#    A full build is intentionally left to the developer / snapshot to keep the
#    install phase bounded.
(cd src-tauri && cargo fetch)

# 5. Warm the AI retrieval indexes (codegraph + ACE). fail-soft: this must never
#    fail the install, so it runs through the always-0 .cursor/index-warm.sh and
#    is additionally guarded with `|| true`. Dependency failures above already
#    short-circuit via `set -e`; only index warming is allowed to be best-effort.
#    A boot-time `index-warm` terminal (see .cursor/environment.json) re-warms on
#    every start to cover snapshot invisibility and code drift.
bash "$REPO_ROOT/.cursor/index-warm.sh" "$REPO_ROOT" || true

echo "[install] Codeg environment ready."
