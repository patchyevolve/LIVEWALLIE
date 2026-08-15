#!/usr/bin/env bash
# Builds the sampler (Rust, release) and the extension (TypeScript) from source.
# Requires: cargo + rustc, node + npm (deps: extension/package-lock.json),
# glib2 (glib-compile-schemas). Output: extension/dist/ and sampler/target/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Building sampler (release)"
cargo build --release --manifest-path "$ROOT/sampler/Cargo.toml"

if [ ! -d "$ROOT/extension/node_modules" ]; then
    echo "==> Installing extension npm dependencies"
    ( cd "$ROOT/extension" && npm install --no-audit --no-fund )
fi

echo "==> Building extension (tsc)"
( cd "$ROOT/extension" && npx tsc -p tsconfig.json )

echo "==> Build complete"