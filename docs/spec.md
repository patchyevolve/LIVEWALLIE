> Historical implementation contract for the Live Wallpaper sampler/extension. See [`README.md`](../README.md) for current installation, usage and configuration.

# Live System Wallpaper — Agent Implementation Contract
**Companion to:** `gnome-live-wallpaper-design-doc.md` (read that first for rationale — this document is for implementation, not motivation)

## 0. How to read this document

This document uses **MUST / MUST NOT / SHOULD / MAY** in the RFC 2119 sense. Every numeric constant below is a decision, not an example — implement the exact value given. If a value is genuinely unspecified for a case you hit, stop and ask rather than inventing one; do not silently pick a "reasonable" default for anything covered by this contract. Section 18 lists things you MUST NOT build regardless of how naturally they'd extend the design.

## 1. Scope & non-goals (read before starting)

In scope: the telemetry sampler, the audio analyzer, the IPC layer between them and the Shell extension, the GNOME Shell extension itself (particle rendering, placement, fullscreen/multi-monitor handling), the color system, and the wallpaper layering + palette-matching feature.

Explicitly out of scope for the first implementation pass (see §18 for the full list): X11 support, any non-GNOME compositor, a DMA-BUF zero-copy render path, an external Rust/wgpu renderer bridged via GStreamer ("Path B" in the design doc).

## 2. Environment

- Target: GNOME Shell **50.x**, Wayland session only. GNOME Shell 50 removed X11 support — do not add an X11 code path, do not guard for `XDG_SESSION_TYPE=x11`.
- Telemetry sampler + audio analyzer: Rust, stable toolchain.
- GNOME Shell extension: TypeScript compiled to GJS-compatible JS (matching the toolchain used by the `weather-effect` reference extension), targeting the GNOME Shell 50 extension API.
- Hardware assumption for GPU telemetry: AMD `amdgpu` driver (iGPU). Do not add an NVML/NVIDIA code path unless explicitly asked.

## 3. Repository layout

```
live-wallpaper/
  sampler/                      # Rust binary — telemetry + audio + IPC server + image ops
    src/main.rs
    src/telemetry.rs
    src/audio.rs
    src/scene_state.rs
    src/ipc.rs
    src/layering.rs             # cutout generation + palette extraction
  extension/                    # GNOME Shell extension
    src/extension.ts
    src/lib/sceneClient.ts       # IPC socket client
    src/lib/sceneState.ts        # type defs + defaults, mirrors scene_state.rs
    src/lib/monitorManager.ts
    src/lib/obscurationManager.ts
    src/lib/particleLayer.ts
    src/lib/wallpaperConfig.ts   # per-wallpaper JSON store
    src/prefs.ts                 # GTK4/Adwaita prefs window, incl. cutout picker
    schemas/                     # GSettings schema
    metadata.json
```

Do not deviate from this layout without flagging it — file names are referenced by exact path elsewhere in this document.

## 4. Data contract: `SceneState`

Both the sampler's telemetry path and its audio path MUST publish this exact shape. All floats are normalized to `[0.0, 1.0]` unless stated otherwise; values MUST be clamped to range before publishing.

```ts
interface Pulse {
  kind: "disk_io" | "beat";
  strength: number;       // 0.0–1.0
  timestamp_ms: number;   // monotonic clock, ms
}

interface Stream {
  direction: "rx" | "tx" | "pan_left" | "pan_right";
  strength: number;       // 0.0–1.0
}

interface SceneState {
  source: "telemetry" | "audio";
  intensity: number;      // system: blended CPU+RAM load | audio: RMS
  population: number;     // system: RAM used fraction | audio: mid-band energy
  heat: number;            // system: normalized temp | audio: spectral centroid position
  pulses: Pulse[];         // events since last publish, MUST be cleared each publish
  streams: Stream[];       // current directional/pan state, replaces previous value
  spawn_rate: number;      // system: process churn | audio: treble density
  gravity_bias: number;    // system: 0 at idle | audio: bass-driven
  timestamp_ms: number;    // monotonic clock, ms, when this state was computed
}
```

`intensity` for the system source MUST be computed as `0.6 * cpu_load + 0.4 * ram_load`, both already normalized 0–1. This weighting is a decision, not a placeholder — do not rebalance it without flagging.

## 5. IPC protocol (sampler ↔ extension)

- Transport: Unix domain socket at `$XDG_RUNTIME_DIR/live-wallpaper/scene.sock`. The sampler binary is the **server** (creates and binds the socket on startup, removes it on clean shutdown). The extension is the **client**.
- Framing: newline-delimited JSON. Each message is one JSON object followed by `\n`. No length prefix.
- Message types, `type` field required on every message:
  - `scene_update` — body is a `SceneState` object as above. Sampler pushes this continuously; no request needed.
  - `generate_layers` (extension → sampler) — `{ "type": "generate_layers", "wallpaper_uri": string, "output_dir": string }`.
  - `layers_result` (sampler → extension) — `{ "type": "layers_result", "candidates": [{ "id": "low"|"balanced"|"high", "coverage": number, "path": string }] }`. Candidates whose coverage fails the sanity check in §11 MUST be omitted from this array, not included with a flag.
  - `error` — `{ "type": "error", "code": string, "message": string }`.
- Reconnect policy (extension side): on disconnect or connect failure, retry with backoff `1s, 2s, 4s, 8s, 10s`, then hold at 10s intervals indefinitely. MUST NOT crash the extension or throw an uncaught error on any connection failure — log via `console.warn` and continue rendering the last known `SceneState`, degrading toward the idle end of the color/intensity range if no update has arrived in 5 seconds.

## 6. Telemetry sampler

Poll interval: **300ms**, fixed. Do not make this configurable in the first pass.

| Field | Exact source | Notes |
|---|---|---|
| CPU load | `sysinfo` crate, global CPU usage | normalize 0–100% → 0.0–1.0 |
| RAM load | `sysinfo` crate, used/total | 0.0–1.0 |
| Disk I/O → `pulses` | delta of `/proc/diskstats`, fields 6 and 10 (sectors read/written) between polls | emit a `disk_io` pulse when delta exceeds a fixed threshold of 512 sectors between polls; strength = `min(1.0, delta_sectors / 8192)` |
| Network → `streams` | delta of `/proc/net/dev`, RX and TX bytes | emit one `rx` and one `tx` stream entry every publish (not just on change), strength = `min(1.0, delta_bytes / 5_000_000)` per 300ms window |
| CPU temp → `heat` | first `temp*_input` under `/sys/class/hwmon/hwmon*/` whose `temp*_label` matches `Tctl` or `Tdie` (AMD) | normalize: `heat = clamp((temp_c - 30) / 70, 0, 1)` — 30°C floor, 100°C ceiling |
| GPU load | `/sys/class/drm/card0/device/gpu_busy_percent` | 0–100 → 0.0–1.0 |
| Process spawn/death → `spawn_rate` | PID set diff between polls (list `/proc/[0-9]*`) | `spawn_rate = min(1.0, (spawned + died) / 20)` per 300ms window |
| Battery | `/sys/class/power_supply/BAT0/capacity` if present, else omit from computation entirely (do not synthesize a value) | not currently wired into any `SceneState` field — reserved for future use, MUST be sampled and logged but MUST NOT affect rendering yet |

`population` (system) = RAM load directly (no separate formula). `gravity_bias` (system) = `0.0` always in this version — it is a Music Mode concept; do not invent a system-mode meaning for it.

## 7. Audio analyzer

- Capture: default sink monitor stream via PipeWire's Pulse-compatible API (`cpal`, Pulse backend).
- Sample rate: use whatever the default sink reports (commonly 48000 Hz) — do not resample.
- FFT size: 2048 samples, Hann window, hop size 1024 (50% overlap).
- Band boundaries (Hz): bass = 20–250, mid = 250–4000, treble = 4000–16000. Bin-to-Hz mapping uses the actual sample rate reported by the sink, not a hardcoded 44100/48000 assumption.
- `intensity` = normalized RMS of the full-band signal: `floor = -60 dBFS → 0.0`, `ceiling = -6 dBFS → 1.0`, clamp outside this range.
- `population` = normalized mid-band energy, same dBFS floor/ceiling as above applied to the mid band only.
- `heat` = spectral centroid position mapped into 0–1 across the analyzed range (20 Hz → 0.0, 16000 Hz → 1.0).
- `spawn_rate` = normalized treble-band energy, same dBFS floor/ceiling.
- `gravity_bias` = normalized bass-band energy, same dBFS floor/ceiling.
- Beat detection (→ `pulses`): spectral flux of the bass+mid bands against a rolling average of the last 43 frames (~1s at this hop size). Fire a `beat` pulse when current flux exceeds `1.5 × rolling_average` AND at least 120ms have passed since the last fired beat (debounce). `strength = min(1.0, flux / (2 × rolling_average))`.
- Stereo → `streams`: compare L/R channel RMS; emit one `pan_left` or `pan_right` entry (whichever channel is louder) with `strength = abs(L_rms - R_rms) / (L_rms + R_rms)`, omit entirely if the two are within 5% of each other.

## 8. Mode FSM

States: `System`, `Music`. Start state: `System`.

- `System → Music`: audio-source `intensity` (§7) stays `> 0.15` continuously for `>= 400ms`.
- `Music → System`: audio-source `intensity` stays `< 0.05` continuously for `>= 3000ms`.
- While in `System`, the extension renders from the most recent `scene_update` where `source == "telemetry"`. While in `Music`, from the most recent where `source == "audio"`. The sampler MUST publish both continuously regardless of which mode is currently displayed — mode switching is a rendering-side decision, not something the sampler needs to know about.
- Transition MUST NOT reset particle positions/state — only the data source driving them changes.

## 9. Color system

Two independent axes computed per-particle from the current `SceneState`, both fed by different fields depending on mode as described in the design doc.

**Hue arc**, input `t` (a 0–1 value — `heat` for system-sourced state, or the bass/treble balance `gravity_bias - spawn_rate` remapped to 0–1 for audio-sourced state):
- Two-segment piecewise interpolation. Segment A, `t` in `[0.0, 0.5]`: hue goes 235° → 300°. Segment B, `t` in `[0.5, 1.0]`: hue goes 300° → 375°, **then take the result `mod 360`**. This wrap handling is required — interpolating segment B directly toward 15° instead of 375° will route the gradient through green, which is wrong.
- Saturation: `S = clamp(20 + 70 * intensity, 20, 90)` (percent).
- Lightness: `L = clamp(15 + 45 * intensity, 15, 60)` (percent).

**Punctate event flash** (on any `pulses` entry, regardless of `kind`): set that particle's `L = 90%, S = 10%` immediately, then ease back to its ambient `S`/`L` (computed above) over 200ms using `ease-out-cubic`. This is the same treatment for `disk_io` and `beat` pulses — do not give them different curves.

**Directional accents** (`streams` entries): `rx` and `pan_left/pan_right`-favoring-left render at hue 190° (cyan-leaning); `tx` and right-favoring pan at hue 20° (coral-leaning); both at `S = 50%` flat (not intensity-driven), regardless of the ambient hue arc — these are annotations, not part of the main population.

## 10. GNOME Shell extension

- On `enable()`: spawn the sampler binary via `Gio.Subprocess` (path resolved relative to the extension's own install directory), then connect to the IPC socket per §5. On `disable()`: disconnect, then terminate the subprocess.
- Actor placement: one actor per entry in `Main.layoutManager.monitors`, inserted into `Main.layoutManager._backgroundGroup`, geometry matching that monitor exactly.
- Fullscreen: watch `Main.layoutManager.monitors[i].inFullscreen` per monitor. On transition to `true`, stop and disconnect that monitor's `Clutter.Timeline` — do not merely set `visible = false`. Reconnect and restart on transition back to `false`.
- Multi-monitor churn: on the layout manager's monitors-changed signal, fully rebuild the actor set (destroy all, recreate from the current `Main.layoutManager.monitors`) rather than trying to diff and patch it.
- Per-monitor desync: each monitor's particle system MUST seed its own local animation phase independently (e.g. `Math.random()` at actor creation) even though every monitor consumes the identical `SceneState`.
- Render tick: driven by `Clutter.Timeline` / `actor.easeAsync()` (GNOME Shell 50's async ease helper), not a JS `setInterval`.
- Particle budget: base cap 600 particles at `intensity == 0`. Scale as `count = max(100, round(600 * (1 - 0.5 * system_cpu_load)))`, recomputed every telemetry publish. This applies in both modes — Music Mode does not get a separate budget.

## 11. Wallpaper layering

- Trigger: watch `org.gnome.desktop.background`'s `picture-uri` (and `picture-uri-dark`) for changes.
- On change, look up `$XDG_CONFIG_HOME/live-wallpaper/wallpapers.json`, keyed by `sha256(picture_uri)` (hex string). If no entry exists, request cutout generation (below) before deciding a default.
- Cutout generation (sampler-side, via `generate_layers` IPC message): compute per-pixel luma via `Y = 0.2126R + 0.7152G + 0.0722B` on the full-resolution image. Build the luminance histogram; take three threshold candidates at the 25th, 50th, and 75th percentile of that histogram — these correspond to `low`/`balanced`/`high` sensitivity respectively. For each candidate: threshold below the cutoff = foreground, apply one morphological open (5×5 kernel) then one morphological close (5×5 kernel), then feather the resulting mask edge with a 3px-radius Gaussian blur. Export as RGBA PNG (original pixels where foreground, transparent elsewhere) to `output_dir`.
- Sanity check, per candidate independently: compute foreground coverage as a fraction of total pixels. Discard the candidate if coverage is below `0.0005` (a genuinely small object — an icon, a boat — is still a valid foreground) or above `0.95` (hiding particles behind virtually the whole screen is pointless). The mask is faded toward transparent as coverage approaches either bound (`0.002` fade on the low side so small objects get the full effect, `0.02` on the high side so the effect disappears gracefully). Only surviving candidates are returned in `layers_result`. If zero candidates survive, `layers_result.candidates` MUST be an empty array — the extension then applies `flat` overlay mode automatically and MUST NOT show the picker UI for that wallpaper.
- Picker UI (`prefs.ts`): render surviving candidates as selectable cards. On hover (`Gtk.EventControllerMotion` enter), scale the preview and draw the mask boundary via `Gtk.Overlay`. Selecting a candidate, or explicitly choosing "none of these," writes the result to `wallpapers.json` for that wallpaper's hash and MUST NOT prompt again for that same hash.

## 12. Palette extraction (`match-wallpaper` mode)

- Downsample the source image (or, in layered mode, only its background pixels — i.e. everywhere the accepted cutout mask is *not* foreground) to 100×100 using nearest-neighbor.
- Convert to HSL. Discard any pixel with `S < 0.08` (near-neutral) before clustering.
- If fewer than 40 pixels remain after filtering, abort match-wallpaper extraction and fall back to the `default` palette for this wallpaper — do not cluster on an under-populated set.
- Otherwise run k-means with `k = 4` on the remaining pixels in HSL space.
- Sort the 4 resulting centroids by `L` ascending. Centroid 0 (lowest L) becomes the idle-end hue for §9's arc; centroid 3 (highest L) becomes the peak-end hue; the median of centroids 1 and 2 becomes the midpoint used in place of the fixed 300° default. The two-segment interpolation logic in §9 is otherwise unchanged, including the wrap-around handling — apply it with these derived hues instead of the default 235°/300°/375° stops.

## 13. Config & storage

- Global settings: GSettings schema `org.gnome.shell.extensions.live-wallpaper`, keys: `enabled` (boolean, default `true`), `default-palette-mode` (enum `default|custom|match-wallpaper`, default `match-wallpaper`).
- Per-wallpaper settings: **not** in GSettings — stored as JSON at `$XDG_CONFIG_HOME/live-wallpaper/wallpapers.json`, structure:
```json
{
  "<sha256-hex-of-picture-uri>": {
    "mode": "flat | layered | replace | disabled",
    "palette": "default | custom | match-wallpaper",
    "cutout_id": "low | balanced | high | null",
    "custom_colors": null
  }
}
```
- Cutout PNGs cached at `$XDG_CACHE_HOME/live-wallpaper/cutouts/<sha256-hex>/{low,balanced,high}.png`. These MAY be regenerated (overwritten) if missing; the extension MUST NOT treat a missing cached file as an error requiring user intervention — it should silently regenerate via `generate_layers`.

## 14. Resource budgets (targets, not hard guarantees — design toward these)

- Sampler process: average CPU `< 3%` on the reference AMD Ryzen 7 / Radeon iGPU system, RSS `< 40MB`.
- Extension (Shell process contribution): average CPU `< 3%` at `System` mode idle, `< 8%` at peak particle budget; do not exceed these without flagging the specific mechanism causing it.
- No component may poll faster than the intervals specified in §6/§7 "to be safe" — that inflates both these budgets and is explicitly against the resource-discipline goal in the design doc.

## 15. Error handling & degradation

| Failure | Required behavior |
|---|---|
| Sampler binary missing/fails to start | Extension logs via `console.error` once, does not retry-spawn more than 3 times per session, renders a static minimal-idle particle field with no data-driven behavior |
| IPC socket unreachable | Reconnect per §5 backoff; render last known `SceneState`, decaying toward idle after 5s of silence (§5) |
| PipeWire unavailable / no default sink | Sampler continues publishing telemetry-sourced `SceneState` only; Mode FSM MUST remain in `System` permanently (never transitions to `Music`) rather than erroring |
| hwmon temp node not found | `heat` for system source defaults to `0.0`; do not crash the sampler |
| No battery present | Skip battery sampling silently (§6); this is not an error condition |
| Wallpaper image unreadable (permissions, missing file) | `generate_layers` returns an `error` message; extension treats this identically to "zero surviving candidates" (§11) — falls back to `flat`, no picker shown |
| GNOME Shell version mismatch at runtime | Extension MUST declare `shell-version: ["50"]` in `metadata.json` and rely on GNOME's own compatibility gating — do not add internal version-branching logic for other Shell versions |

## 16. Build order & acceptance per phase

Follow the phase order in the design doc §8. Each phase's acceptance criterion:

1. Sampler logs valid `SceneState` JSON matching §4's schema at 300ms cadence; values sanity-checked by hand against `htop`/`sensors` output.
2. A windowed (non-wallpaper) renderer displays particles driven by a hand-written mock `SceneState`, with the color system from §9 visibly correct (verify the hue wrap in segment B specifically — this is the easiest part of the spec to get subtly wrong).
3. Same windowed renderer, now driven live by the sampler's telemetry-sourced `scene_update` messages over the real IPC socket.
4. Same window, audio-sourced `scene_update` messages correctly producing band-driven behavior; verify beat detection debounce (§7) actually prevents double-fires on sustained bass.
5. Mode FSM transitions verified against §8's exact thresholds using a stopwatch, not by eye.
6. Extension running as an actual GNOME 50 wallpaper: verify per-monitor placement, verify fullscreen stop (not hide) via a system CPU monitor during a fullscreened window, verify multi-monitor desync is visibly not synchronized.
7. Wallpaper layering end-to-end on at least one bright-sky/dark-silhouette image and at least one image expected to fail the sanity check (e.g. a flat-color or portrait image) — confirm the latter skips the picker automatically per §11.
8. Resource budgets in §14 measured with `top`/`ps` under both idle and heavy-load (e.g. a `make -j$(nproc)` build) conditions.

## 17. Glossary

- **SceneState**: the single shared data contract in §4 — the only thing the renderer reads.
- **Source**: whether a given `SceneState` was produced by the telemetry path or the audio path; not the same as the current Mode FSM state.
- **Layered mode**: the three-actor depth compositing described in §11, as opposed to **flat** overlay (particles over the whole image, no depth split) or **replace** (no underlying image at all).
- **Candidate**: one of the (up to three) auto-generated cutout mask options presented in the picker UI.

## 18. Non-goals — do not implement without explicit new instruction

- X11 support of any kind.
- Support for compositors other than GNOME Shell (no `wlr-layer-shell` path).
- The external Rust/wgpu + GStreamer bridge ("Path B") — the in-Shell GJS/Clutter renderer (§10) is the only renderer in scope for this contract.
- DMA-BUF zero-copy texture sharing.
- NVIDIA/NVML GPU telemetry.
- Any telemetry field, color rule, or threshold not listed in this document — if the design doc's prose suggests something this contract doesn't pin down numerically, treat the absence as intentional and ask rather than filling the gap.
- Making any of the fixed constants in this document (poll intervals, thresholds, particle budget formula, hue stops) user-configurable in the first implementation pass, unless explicitly asked.
