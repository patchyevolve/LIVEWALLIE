#!/usr/bin/env bash
# v1 acceptance / regression suite.
# Usage: bash scripts/acceptance.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"
EXTDIR="$HOME/.local/share/gnome-shell/extensions/live-wallpaper@codeworks2"
PASS=0
FAIL=0

report() { # name, ok
    if [ "$2" = 0 ]; then PASS=$((PASS + 1)); echo "  [PASS] $1";
    else FAIL=$((FAIL + 1)); echo "  [FAIL] $1"; fi
}

echo "== v1 acceptance suite =="
echo "-- 1. Sampler unit tests (cargo test) --"
if (cd "$ROOT/sampler" && cargo test --release --quiet 2>&1 | grep -E "test result"); then
    report "cargo test: sampler unit tests" 0
else
    report "cargo test: sampler unit tests" 1
fi

echo "-- 2. Extension typecheck (tsc) --"
if npx --prefix "$EXT" tsc -p "$EXT/tsconfig.json" >/dev/null 2>&1; then
    report "tsc: extension typechecks" 0
else
    report "tsc: extension typechecks" 1
fi

echo "-- 3. GJS module load + palette extraction --"
convert -size 64x64 xc:red /tmp/opencode/test_red.png 2>/dev/null || true
convert -size 64x64 gradient:black-white -colorspace Gray /tmp/opencode/test_bw.png 2>/dev/null || true
if gjs "$ROOT/scripts/tests/palette_check.js" "$EXTDIR" 2>&1 | tee /tmp/opencode/palette_out.txt | grep -qE "all checks passed"; then
    report "gjs: modules load, palette extraction (incl. B&W)" 0
else
    report "gjs: modules load, palette extraction (incl. B&W)" 1
fi

echo "-- 4. IPC functional test (sampler under test) --"
gnome-extensions disable live-wallpaper@codeworks2 >/dev/null 2>&1
sleep 1
pkill -f "live-wallpaper@codeworks2/sampler/live-wallpaper-sampler" 2>/dev/null
sleep 1
"$EXTDIR/sampler/live-wallpaper-sampler" >/tmp/opencode/sampler_test.log 2>&1 &
SAM_PID=$!
sleep 2
if python3 "$ROOT/scripts/tests/ipc_check.py" > /tmp/opencode/ipc_out.txt 2>&1; then
    report "IPC: sampler stream acceptance" 0
else
    report "IPC: sampler stream acceptance" 1
fi
kill "$SAM_PID" 2>/dev/null
sleep 1
gnome-extensions enable live-wallpaper@codeworks2 >/dev/null 2>&1
sleep 2

echo "-- 5. Extension state restored --"
if gnome-extensions info live-wallpaper@codeworks2 2>/dev/null | grep -q "State: ACTIVE"; then
    report "extension ACTIVE after suite" 0
else
    report "extension ACTIVE after suite" 1
fi
if pgrep -f "live-wallpaper@codeworks2/sampler/live-wallpaper-sampler" >/dev/null; then
    report "sampler respawned by extension" 0
else
    report "sampler respawned by extension" 1
fi

echo
echo "== v1 acceptance: $PASS passed, $FAIL failed =="
[ "$FAIL" = 0 ]