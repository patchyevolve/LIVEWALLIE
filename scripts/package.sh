#!/usr/bin/env bash
# Builds a self-contained release tarball: prebuilt extension JS, prebuilt
# sampler binary, install script and docs — no Rust/Node toolchain needed on
# the target machine. Output: deploy/live-wallpaper-<version>.tar.gz
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n 's/.*"version": \([0-9]*\).*/\1/p' "$ROOT/extension/src/metadata.json")"
OUT="deploy/live-wallpaper-v$VERSION.tar.gz"
STAGE="deploy/staging"

echo "==> Building release artifacts"
bash "$ROOT/scripts/build.sh"

echo "==> Staging release tarball (mirrors the repo layout)"
rm -rf "$STAGE"
mkdir -p "$STAGE/extension/dist/lib" "$STAGE/extension/src" "$STAGE/extension/schemas"
mkdir -p "$STAGE/sampler" "$STAGE/scripts"
cp "$ROOT/extension/dist/extension.js" "$STAGE/extension/dist/"
cp "$ROOT/extension/dist/lib/"*.js "$STAGE/extension/dist/lib/"
cp "$ROOT/extension/prefs.js" "$STAGE/extension/"
cp "$ROOT/extension/src/metadata.json" "$STAGE/extension/src/"
cp "$ROOT/extension/schemas/"*.gschema.xml "$STAGE/extension/schemas/"
cp "$ROOT/sampler/target/release/live-wallpaper-sampler" "$STAGE/sampler/"
cp "$ROOT/scripts/install.sh" "$STAGE/scripts/"
cp "$ROOT/README.md" "$STAGE/"

mkdir -p "$ROOT/deploy"
tar -czf "$OUT" -C "$STAGE" .
rm -rf "$STAGE"

echo "==> Release: $OUT"
echo "    On the target machine:"
echo "      tar -xzf $(basename "$OUT") && bash scripts/install.sh"