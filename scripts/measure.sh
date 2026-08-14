#!/usr/bin/env bash
# v1 baseline resource measurement: sampler (CPU/RSS) and gnome-shell delta
# (extension enabled vs disabled). Idle desktop, no music playing.
set -u

SAMPLE_S=30
WARMUP_S=10
TICK_S=2

sample_pid() { # pid -> "cpu_pct rss_kb" over one tick
    local pid=$1
    local s1 s2 r1 r2 wall
    read -r _ _ s1 _ <<< "$(awk '{print $14, $15}' "/proc/$pid/stat" 2>/dev/null)" 2>/dev/null || return
    s1=$(awk '{print $14+$15}' "/proc/$pid/stat" 2>/dev/null) || return
    r1=$(awk '/VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null) || return
    sleep "$TICK_S"
    s2=$(awk '{print $14+$15}' "/proc/$pid/stat" 2>/dev/null) || return
    r2=$(awk '/VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null) || return
    local d=$(( s2 - s1 ))
    local cpu
    cpu=$(awk -v d="$d" -v t="$TICK_S" 'BEGIN { printf "%.1f", d / 100 / t }')
    echo "$cpu $r2"
}

run_phase() { # name, [sampler:0|1] -> lines
    local name=$1 want_sampler=$2
    local ticks=$(( SAMPLE_S / TICK_S ))
    local shell_pid
    shell_pid=$(pgrep -x gnome-shell | head -1)
    [ -n "$shell_pid" ] || { echo "gnome-shell not found"; return 1; }
    local s_pid=""
    if [ "$want_sampler" = 1 ]; then
        s_pid=$(pgrep -f "live-wallpaper@codeworks2/sampler/live-wallpaper-sampler" | head -1)
    fi
    sleep "$WARMUP_S"
    local cpu_sum=0 rss_sum=0 n=0
    local s_cpu_sum=0 s_rss_sum=0 s_n=0
    local i
    for (( i=0; i<ticks; i++ )); do
        local out
        out=$(sample_pid "$shell_pid") || continue
        local cpu rss
        read -r cpu rss <<< "$out"
        cpu_sum=$(awk -v a="$cpu_sum" -v b="$cpu" 'BEGIN{printf "%.2f", a+b}')
        rss_sum=$(( rss_sum + rss ))
        n=$(( n + 1 ))
        if [ -n "$s_pid" ] && [ -d "/proc/$s_pid" ]; then
            local sout
            sout=$(sample_pid "$s_pid") || continue
            read -r s_cpu s_rss <<< "$sout"
            s_cpu_sum=$(awk -v a="$s_cpu_sum" -v b="$s_cpu" 'BEGIN{printf "%.2f", a+b}')
            s_rss_sum=$(( s_rss_sum + s_rss ))
            s_n=$(( s_n + 1 ))
        fi
    done
    awk -v name="$name" -v n="$n" -v c="$cpu_sum" -v r="$rss_sum" \
        -v sn="$s_n" -v sc="$s_cpu_sum" -v sr="$s_rss_sum" 'BEGIN {
        printf "  %-10s shell: cpu %5.1f%%   rss %6.0f MB\n", name, c/n, r/1024;
        if (sn > 0)
            printf "  %-10s sampler: cpu %5.1f%%   rss %6.0f MB\n", "", sc/sn, sr/1024;
    }'
}

EXTDIR="$HOME/.local/share/gnome-shell/extensions/live-wallpaper@codeworks2"
EXTNAME=live-wallpaper@codeworks2

echo "== v1 resource measurement (idle desktop) =="
echo "phase A: extension enabled"
run_phase enabled 1
echo "phase B: extension disabled"
gnome-extensions disable "$EXTNAME" >/dev/null 2>&1
sleep 2
run_phase disabled 0
echo "phase C: restoring"
gnome-extensions enable "$EXTNAME" >/dev/null 2>&1
sleep 5
pgrep -f "live-wallpaper@codeworks2/sampler/live-wallpaper-sampler" >/dev/null \
    && echo "  extension + sampler restored" || echo "  WARNING: sampler not running"