#!/usr/bin/env bash
# Installs the Live Wallpaper extension + sampler into GNOME Shell.
#
# Works from two layouts:
#   * a git checkout         -> builds from source first (needs cargo + node)
#   * a release tarball      -> installs the prebuilt artifacts (no toolchain)
#
# Usage:
#   bash scripts/install.sh            install (or update) and enable
#   bash scripts/install.sh uninstall  remove the extension
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="live-wallpaper@codeworks2"
EXTDIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

# Prebuilt artifacts (release tarball layout).
HAS_EXT_BUILT=$([ -f "$ROOT/extension/dist/extension.js" ] && echo 1 || echo 0)
HAS_SAMPLER=$([ -f "$ROOT/sampler/live-wallpaper-sampler" ] && echo 1 || echo 0)

if [ "${1:-}" = "uninstall" ]; then
    echo "==> Disabling and removing $UUID"
    gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
    rm -rf "$EXTDIR"
    echo "==> Removed. Log out/in to fully unload it from the shell."
    exit 0
fi

if [ "$HAS_EXT_BUILT" = 0 ] || [ "$HAS_SAMPLER" = 0 ]; then
    if [ "$HAS_EXT_BUILT" = 0 ] && [ -d "$ROOT/extension/src" ]; then
        echo "==> Source checkout detected — building from source"
        bash "$ROOT/scripts/build.sh"
    else
        echo "ERROR: no prebuilt artifacts and no source tree found."
        echo "  From a git checkout run: bash scripts/install.sh"
        echo "  From a release tarball the prebuilt files must be present."
        exit 1
    fi
    SAMPLER_BIN="$ROOT/sampler/target/release/live-wallpaper-sampler"
else
    SAMPLER_BIN="$ROOT/sampler/live-wallpaper-sampler"
fi

echo "==> Installing to $EXTDIR"
rm -rf "$EXTDIR"
mkdir -p "$EXTDIR/lib" "$EXTDIR/sampler" "$EXTDIR/schemas"
cp "$ROOT/extension/dist/extension.js" "$EXTDIR/"
cp "$ROOT/extension/dist/lib/"*.js "$EXTDIR/lib/"
cp "$ROOT/extension/src/metadata.json" "$EXTDIR/"
cp "$ROOT/extension/prefs.js" "$EXTDIR/"
cp "$ROOT/extension/schemas/"*.gschema.xml "$EXTDIR/schemas/"
glib-compile-schemas "$EXTDIR/schemas/"
cp "$SAMPLER_BIN" "$EXTDIR/sampler/"
chmod +x "$EXTDIR/sampler/live-wallpaper-sampler"

echo "==> Enabling extension"
gnome-extensions enable "$UUID"

echo "==> Done."
echo "    Restart GNOME Shell (log out/in) to load the extension."
echo "    Settings:  gnome-extensions prefs $UUID"
echo "    Uninstall: bash scripts/install.sh uninstall"