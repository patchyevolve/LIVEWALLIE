#!/usr/bin/env bash
# Builds the sampler and extension and installs both into GNOME Shell.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="live-wallpaper@codeworks2"
EXTDIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

echo "==> Building sampler (release)"
cargo build --release --manifest-path "$ROOT/sampler/Cargo.toml"

echo "==> Building extension (tsc)"
( cd "$ROOT/extension" && npx tsc -p tsconfig.json )

echo "==> Installing to $EXTDIR"
rm -rf "$EXTDIR"
mkdir -p "$EXTDIR/lib" "$EXTDIR/sampler" "$EXTDIR/schemas"
cp "$ROOT/extension/dist/extension.js" "$EXTDIR/"
cp "$ROOT/extension/dist/lib/"*.js "$EXTDIR/lib/"
cp "$ROOT/extension/src/metadata.json" "$EXTDIR/"
cp "$ROOT/extension/prefs.js" "$EXTDIR/"
cp "$ROOT/extension/schemas/"*.gschema.xml "$EXTDIR/schemas/"
glib-compile-schemas "$EXTDIR/schemas/"
cp "$ROOT/sampler/target/release/live-wallpaper-sampler" "$EXTDIR/sampler/"

echo "==> Done. Enable with: gnome-extensions enable $UUID"
echo "==> Settings: gnome-extensions prefs $UUID"