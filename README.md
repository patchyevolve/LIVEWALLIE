# Live Wallpaper

A system- and music-reactive live wallpaper for **GNOME Shell 50**. A field of
particles flows over your desktop; it is driven by two independent "modes":

| Mode | Driven by | What you see |
|---|---|---|
| **System** | CPU, temperature, GPU, battery, memory | A slow **temperature hue journey** (indigo idle → amber under load), a **tide wave** that sweeps the field when CPU load jumps, occasional **GPU sparks**, rare wandering **embers**, battery-aware brightness, idle breathing |
| **Music** | Live audio from PulseAudio/PipeWire | **Bass pulls particles down**, **beats surge** the field and flash particles, stereo **pan drifts** the field sideways |

The mode switches automatically: audio intensity sustained above threshold
switches to Music; silence for ~3s returns to System.

The wallpaper is **reactive, not a meter** — no readouts, no graphs. Every
telemetry value goes through a slow "mood" layer (seconds-to-minutes time
constants) before it touches the renderer, so the field breathes with the
machine instead of twitching with it.

## Features

- **Mood pipeline**: telemetry → normalization → slow mood → events → renderer.
  Nothing drives particle positions directly.
- **Grid-based hiding**: the field renders nothing behind windows (48&nbsp;px
  cells, polled); hidden particles keep flowing invisibly and emerge on the
  other side. When a screen is 100% covered the layer pauses entirely (real
  CPU savings).
- **Fullscreen pause**: an optional hard pause when a window goes fullscreen.
- **Palette sources**: built-in hue arc, a fixed hue of your choice, or the
  **accent color extracted from your wallpaper** (with an optional hue shift).
- **Depth layering (§6)**: particles fade out behind the wallpaper's
  silhouette (brightness-split or edge masks), so they appear to pass behind
  objects in the image.
- **Pointer interaction**: particles part and swirl around the mouse.
- **Multi-monitor**: per-monitor wallpaper, per-screen rotation overrides,
  and a list of screens to keep dark.
- **Scenes**: one-click looks (Deep Space, Aurora, Ember, Rain) that are just
  presets over the individual settings — every knob stays tweakable after.
- **Two processes, one socket**: a Rust sampler collects telemetry and audio
  and publishes JSON over a Unix socket; the shell extension renders. If the
  sampler dies, the extension falls back to a static idle field and respawns
  it (up to 3 times per session).

## Requirements

- **GNOME Shell 50** (checked in `metadata.json`)
- `glib2` (`glib-compile-schemas`) — needed by the installer
- The sampler links against PulseAudio (`libpulse`) — works with PipeWire's
  PulseAudio compatibility, which is the default on modern distros
- Installing **from source** additionally needs: Rust (`cargo`), Node.js +
  npm (extension TypeScript build)

Installing from a **release tarball** needs none of the build toolchains.

## Installation

### From a release tarball (no toolchains)

```sh
tar -xzf live-wallpaper-v3.tar.gz
bash scripts/install.sh
```

That builds nothing — it copies the prebuilt extension, compiles the settings
schema, installs the prebuilt sampler, and enables the extension. Then
**log out and back in** (GNOME Shell extensions load at login).

### From source

```sh
git clone https://github.com/patchyevolve/LIVEWALLIE.git
cd LIVEWALLIE
bash scripts/install.sh
```

The installer detects the source checkout and runs the build first
(`scripts/build.sh`: `cargo build --release` for the sampler, `npm install`
+ `tsc` for the extension). Log out/in to load it.

### Uninstall

```sh
bash scripts/install.sh uninstall
```

(or `gnome-extensions disable live-wallpaper@codeworks2` + delete
`~/.local/share/gnome-shell/extensions/live-wallpaper@codeworks2`).

### Making a release tarball

```sh
bash scripts/package.sh   # → deploy/live-wallpaper-v3.tar.gz
```

## Configuration

Open the GNOME Extensions app → **Live Wallpaper** → gear icon (or
`gnome-extensions prefs live-wallpaper@codeworks2`). All settings live in
GSettings under `org.gnome.shell.extensions.live-wallpaper@codeworks2` and
apply live.

| Setting | Default | What it does |
|---|---|---|
| `master-enabled` | `true` | Master switch |
| `pause-fullscreen` | `true` | Hard pause when a window is fullscreen |
| `pause-obscured` | `true` | Grid-based hiding behind windows (see Features) |
| `idle-speed` | `0.7` | System-mode drift speed multiplier |
| `shimmer` | `true` | Subtle vertical shimmer in System mode |
| `music-speed` | `1.0` | Music-mode speed multiplier |
| `bass-gravity` / `bass-strength` | `true` / `1.0` | Bass pulls particles down |
| `beat-surge` / `beat-strength` | `true` / `1.0` | Beats surge the field along the drift axis |
| `beat-flash` | `true` | Beats flash particles white |
| `stream-drift` / `stream-strength` | `true` / `1.0` | Stereo pan pushes the field sideways |
| `palette-mode` | `arc` | `arc` (built-in hue journey) · `fixed` (your hue) · `wallpaper` (accent from the wallpaper image) |
| `fixed-hue` | `300` | Hue when `palette-mode=fixed` |
| `accent-shift` | `0` | Hue offset on top of the wallpaper accent |
| `scene-preset` | `deepspace` | One-click looks (`deepspace`, `aurora`, `ember`, `rain`) |
| `pointer-effect` / `pointer-radius` / `pointer-strength` | `true` / `180` / `1.0` | Pointer swirl |
| `wallpaper-layering` | `false` | §6 depth layering behind the wallpaper silhouette |
| `layering-threshold` | `0.5` | Luminance cutoff for the silhouette mask |
| `layering-invert` | `false` | Treat bright areas as foreground (dark wallpapers) |
| `layering-mode` | `luminance` | `luminance` · `edges` · `auto` (brightness first, edges fallback) |
| `disabled-screens` | `[]` | Connector names of screens where the wallpaper stays hidden |
| `screen-orientations` | `[]` | Per-screen rotation overrides: `connector=0/90/180/270` |

### What to expect, per mode

**System mode** (no music playing):

- Idle: a slow, calm drift in cool indigo/cyan tones (temperature mood).
- Heat up: the field leans amber (hue, saturation *and* lightness), the whole
  screen briefly tints, and when CPU load jumps sharply a **tide wave** —
  a soft light band whose particles physically rise — sweeps left→right once
  (min 45s between waves).
- GPU activity: occasional short **sparks** (glow + core + streak, ~1.5s).
- Every 1–2 minutes one small cluster of warm **embers** drifts across.
- On battery: the field slowly dims (down to 70%) as the battery drains.

To demo it: `yes > /dev/null &` a few times for ~30s and watch the wave fire,
then `kill` them.

**Music mode** (audio playing, sustained >400ms):

- Bass: particles are pulled downward; beats surge the field and flash.
- Stereo pan: the field drifts toward the louder channel.
- Nothing from the System mode leaks in here (no waves, sparks, embers or
  temperature colors) — the palette stays on the mode's own mood.

## Troubleshooting

- **Nothing animates**: check the extension is active
  (`gnome-extensions info live-wallpaper@codeworks2`), then
  `journalctl --user -f | grep live-wallpaper`. Look for
  `sampler binary not found` (broken install), `failed repeatedly` (sampler
  crash, see below) or JS errors.
- **Sampler keeps exiting / respawning**: run it manually and read the
  stderr: `~/.local/share/gnome-shell/extensions/live-wallpaper@codeworks2/sampler/live-wallpaper-sampler`.
  Common causes: missing `libpulse`, or the runtime socket directory
  `$XDG_RUNTIME_DIR/live-wallpaper` being unwritable. After 3 failed spawns
  the extension renders a static idle field (and logs it) until the next
  login.
- **Music mode never activates**: the mode FSM needs sustained audio
  intensity >0.15 for 400ms. If your audio runs through a device PulseAudio
  doesn't see (e.g. Bluetooth in some setups), check with `pactl list
  sources`. The sampler logs its mode: `[telemetry] ... mode=Music`.
- **Everything froze**: a fully covered screen pauses its layer by design —
  move/resize a window, or disable `pause-obscured`.
- **After installing/updating**: log out and in. GNOME Shell 50 loads
  extension code at login; the settings UI updates instantly, the renderer
  does not.
- **Permissions/tracing**: shell-side logs are in
  `journalctl --user` (look for `[live-wallpaper]`); sampler diagnostics are
  on the extension's stderr only when run manually.

## Architecture

```
┌────────────────────────────┐        unix socket         ┌──────────────────────────────┐
│  sampler (Rust, 1 proc)    │   /run/user/$UID/          │  gnome-shell extension (JS)  │
│  telemetry: sysinfo, 300ms │   live-wallpaper/          │  SceneClient (reconnect)     │
│  audio: libpulse FFT       │   scene.sock  (JSON,       │  MonitorManager              │
│  mode FSM (System↔Music)   │   protocol v1, ~300ms)     │   └ ParticleLayer per screen │
│  disk/process churn        │ ─────────────────────────► │       SystemMood (smoothing) │
└────────────────────────────┘                            │       grid hiding, pointer   │
                                                          │  PaletteManager (wallpaper   │
                                                          │   accent, §6 masks)          │
                                                          └──────────────────────────────┘
```

- `sampler/` — Rust: `telemetry.rs` (sysinfo), `audio.rs` (PulseAudio
  spectrum), `fsm.rs` (mode switching), `ipc.rs` (socket server),
  `scene_state.rs` (the protocol contract).
- `extension/` — TypeScript compiled with `tsc`: `extension.ts` (lifecycle,
  sampler spawn/respawn), `lib/monitorManager.ts` (per-screen layers, grid
  hiding, pause), `lib/particleLayer.ts` (renderer + mood events),
  `lib/systemMood.ts` (the smoothing layer), `lib/paletteManager.ts`
  (accent extraction), `lib/wallpaperMask.ts` (§6 masks), `prefs.js`
  (settings UI).
- `scripts/` — `build.sh`, `install.sh`, `package.sh`, `acceptance.sh`
  (regression suite: cargo tests, typecheck, gjs module load, IPC test),
  `measure.sh` (CPU/RSS measurement harness).

Design rationale and the IPC protocol spec live in
[`docs/design.md`](docs/design.md) and [`docs/spec.md`](docs/spec.md).

## Development

```sh
cd extension && npm install     # once
cd .. && bash scripts/build.sh  # sampler + extension
bash scripts/acceptance.sh      # regression suite (needs the extension installed)
```

Extension JS only reloads on login; the sampler can be rebuilt and killed —
the extension respawns it.