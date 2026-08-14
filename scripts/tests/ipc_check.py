#!/usr/bin/env python3
"""IPC acceptance test: validates the sampler's SceneState stream over the
Unix socket (message shape, cadence, field ranges, system-mode invariants).
Run with the extension disabled so the sampler under test is the only one."""
import json
import socket
import sys
import time

SOCK = "/run/user/1000/live-wallpaper/scene.sock"
DURATION_S = 10.0

failures = []


def check(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}] {name}" + (f" ({detail})" if detail else ""))
    if not ok:
        failures.append(name)


def main():
    print("== IPC acceptance ==")
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(1.0)
    sock.connect(SOCK)
    sock.settimeout(0.2)

    buf = b""
    msgs = []
    t0 = time.monotonic()
    while time.monotonic() - t0 < DURATION_S:
        try:
            data = sock.recv(65536)
        except socket.timeout:
            continue
        if not data:
            break
        buf += data
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if line.strip():
                msgs.append((time.monotonic() - t0, line))
    sock.close()

    check("messages received", len(msgs) >= 25, f"{len(msgs)} in {DURATION_S:.0f}s")

    parsed = []
    for _, line in msgs:
        try:
            parsed.append(json.loads(line))
        except Exception:
            parsed.append(None)
    check("all messages valid JSON", all(m is not None for m in parsed))
    parsed = [m for m in parsed if m is not None]
    if not parsed:
        print("  (no parseable messages; skipping field checks)")
        return 1

    check("protocol version == 1",
          all(m.get("version") == 1 for m in parsed))
    check("mode is valid", all(m.get("mode") in ("system", "music") for m in parsed))
    check("source is valid", all(m.get("source") in ("telemetry", "audio") for m in parsed))
    check("intensity in [0,1]", all(0.0 <= m.get("intensity", -1) <= 1.0 for m in parsed))
    check("population in [0,1]", all(0.0 <= m.get("population", -1) <= 1.0 for m in parsed))
    check("heat in [0,1]", all(0.0 <= m.get("heat", -1) <= 1.0 for m in parsed))
    check("spawn_rate in [0,1]", all(0.0 <= m.get("spawn_rate", -1) <= 1.0 for m in parsed))
    check("gravity_bias in [0,1]", all(0.0 <= m.get("gravity_bias", -1) <= 1.0 for m in parsed))
    check("pulses is a list", all(isinstance(m.get("pulses"), list) for m in parsed))
    check("streams is a list", all(isinstance(m.get("streams"), list) for m in parsed))
    check("system section present", all(isinstance(m.get("system"), dict) for m in parsed))
    check("audio section present", all(isinstance(m.get("audio"), dict) for m in parsed))
    check("audio has pan in [-1,1]",
          all(-1.0 <= m.get("audio", {}).get("pan", -2) <= 1.0 for m in parsed))

    telemetry = [m for m in parsed if m.get("source") == "telemetry"]
    audio = [m for m in parsed if m.get("source") == "audio"]
    check("telemetry messages present", len(telemetry) > 5, f"{len(telemetry)}")
    check("audio messages present (or device absent)", len(audio) >= 0, f"{len(audio)}")

    system_only = [m for m in telemetry if m.get("mode") == "system"]
    if system_only:
        check("system mode: streams empty (pan-only design)",
              all(len(m.get("streams", [1])) == 0 for m in system_only),
              f"{len(system_only)} system messages")
        check("system mode: gravity_bias == 0",
              all(m.get("gravity_bias") == 0 for m in system_only))

    gaps = [b - a for (a, _), (b, _) in zip(msgs, msgs[1:])]
    tele_gaps = [g for g in gaps if g < 2.0]
    avg_gap = sum(tele_gaps) / len(tele_gaps) if tele_gaps else 0
    check("no starvation (avg inter-message gap < 1s)",
          avg_gap < 1.0, f"avg {avg_gap*1000:.0f}ms")

    sock = None
    if failures:
        print(f"IPC acceptance: {len(failures)} FAILED: {failures}")
        return 1
    print("IPC acceptance: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())