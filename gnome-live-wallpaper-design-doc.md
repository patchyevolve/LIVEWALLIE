# Live System Wallpaper — Design Document
**Target platform:** GNOME 50 (Wayland-only — GNOME Shell 50 removed X11 support entirely, so this doc doesn't consider an X11 fallback)

## 1. Vision

A GNOME desktop wallpaper with two states of consciousness:

- **System Mode** — when there's no meaningful audio playing, the wallpaper reflects the real state of the machine: CPU, RAM, GPU, temperatures, disk I/O, network, process activity, battery. An idle machine looks dormant. A compile job looks like a storm.
- **Music Mode** — as soon as meaningful playback starts, the same particle field becomes audio-reactive: bass, mids, treble, RMS, beat, and stereo position drive the same physics that telemetry drove a moment ago.

The core design constraint, discovered while scoping this: **the renderer should never know which mode is active.** Both telemetry and audio are reduced to one shared vocabulary before they ever reach a particle.

## 2. The `SceneState` abstraction

Both the telemetry sampler and the audio analyzer publish the same struct on their own cadence. The renderer only ever reads this:

```rust
struct SceneState {
    intensity: f32,      // RMS / overall CPU-RAM load
    population: f32,     // RAM used / mid-band energy
    heat: f32,            // temps / spectral centroid
    pulses: Vec<Pulse>,  // disk I/O / detected beats
    streams: Vec<Stream>, // net RX/TX direction / stereo pan
    spawn_rate: f32,      // process churn / treble density
    gravity_bias: f32,    // idle=flat / bass-driven
}
```

This is what decouples the (hard, fun) graphics work from either data source, and it's what makes the mode switch cheap later — switching modes just means switching who's writing the struct.

## 3. Data pipeline

### Telemetry sampler (Rust, polling every 250–500ms)

| Signal | Source |
|---|---|
| CPU / RAM | `sysinfo` crate |
| Disk I/O | delta of `/proc/diskstats` |
| Network RX/TX | delta of `/proc/net/dev` |
| CPU temp | `/sys/class/hwmon` (lm-sensors) |
| GPU usage/temp | `amdgpu` sysfs — `gpu_busy_percent` + hwmon node under `/sys/class/drm/card0/device/` (Radeon iGPU, no NVML needed) |
| Process spawn/death | PID-set diff each poll (proc connector/netlink is the "elegant" option but needs `CAP_NET_ADMIN`; skip it) |
| Battery | `/sys/class/power_supply/BAT*`, no-op if absent (desktop) |

Don't poll faster than the visual needs — the system doesn't change fast, and this budget also protects requirement #6 below (don't overload the PC).

### Audio analyzer (PipeWire)

Capture the default sink's monitor stream (`cpal` over PipeWire's Pulse-compat layer, or `pipewire-rs` directly for lower latency). `rustfft` over Hann-windowed 1024–2048 sample frames, bucketed into bass/mid/treble by bin range. RMS and peak straight off the PCM buffer. Beat detection: spectral flux against a rolling average, fire an impulse past a threshold — no need for a full beat-tracking algorithm.

### Mode FSM — hysteresis, not a boolean

"Is audio playing" flickers on notification dings and video-call beeps if polled raw. Debounce it:
- Enter Music Mode after RMS sits above a floor for ~300–500ms.
- Linger a few seconds after audio drops before falling back to System Mode, so song gaps don't flip the whole wallpaper.

## 4. Rendering & GNOME hosting

GNOME 50 dropped X11 entirely, and GNOME Shell doesn't implement `wlr-layer-shell` (that's wlroots-compositor-only, e.g. Hyprland/Sway). The only real path in is a **GNOME Shell extension**.

**Chosen approach — GJS/TypeScript, Clutter actors, in-Shell.** Rendering logic lives in the Shell process itself, using the same pattern as existing extensions:
- Reference: **Weather Effect** (github.com/quinsaiz/weather-effect) — a real, shipping extension that renders desktop-background particles (snow/rain), split into `ParticleManager`, `MonitorManager`, `ObscurationManager`. Read this before writing anything; it's solving the exact placement/lifecycle problems below.
- Alternative considered and deferred: an external Rust/wgpu process feeding a GStreamer pipeline into a video-sink extension like **Hanabi** (github.com/jeffshee/gnome-ext-hanabi). This keeps the renderer in Rust/wgpu but adds a GPU→CPU→GPU frame round-trip and its own IPC plumbing, and still needs Shell access for fullscreen/monitor state anyway. Revisit only if Clutter's particle ceiling (Weather Effect caps around 50) turns out to be a real, demonstrated visual limit — not a hypothetical one.

Telemetry and audio sampling stay in Rust regardless of which rendering path wins; only the renderer's language is in question.

### Placement
Insert one actor per monitor into `Main.layoutManager._backgroundGroup`, sized to that monitor's geometry (`Main.layoutManager.monitors[i]`). That group sits below the window group and above the static background — particles are naturally hidden behind normal windows and only show through where desktop is visible, without writing any occlusion logic by hand.

### Fullscreen — stop, don't just hide
`Main.layoutManager.monitors[i].inFullscreen` is maintained by the Shell itself. When it flips true for a monitor, **disconnect that monitor's animation timeline entirely** (stop the ticker, drop the handler) — don't just set opacity/visibility to 0, or the tick loop keeps burning CPU on invisible frames.

### Multi-monitor
Loop `Main.layoutManager.monitors`, one independent actor + particle state per entry, each with its own animation phase/seed even though all read the same `SceneState` — same data, staggered visual phase, so two screens don't look like a mirrored clone. Watch the Shell's monitor-changed signal to rebuild the actor set on dock/undock.

## 5. Color design

Two independent axes, shared by both modes so the mode switch reads as a mood change, not a different app:

- **Hue = "temperature" (what kind of activity).** Arc through indigo → violet/magenta → red-orange (avoid a straight lerp through green — reads as a thermal camera, not intentional). System Mode: idle=blue, compiling=red-orange, driven by load/temp. Music Mode: treble-heavy=cool blue, bass-heavy=warm red — reuses the same arc, and "heavy bass = warm" already matches most people's intuition.
- **Saturation/brightness = intensity (how much).** Idle/quiet = desaturated and dim. Loud/busy = fully saturated and bright. Independent of hue so "quiet but hot" and "loud but cool" are both representable.

**Punctate events share one grammar regardless of source:** disk I/O pulses and detected beats both flash toward near-white for one frame, decay back to ambient color over 150–300ms on an ease-out curve.

**Directional accents** (network RX/TX) get their own small palette offset from the main arc — RX cool cyan-leaning, TX warm coral-leaning, both slightly desaturated so they read as annotations, not competing with the ambient field. Process birth flashes in at full brightness before settling; death fades to gray then out.

## 6. Wallpaper layering system

### Per-wallpaper configuration
Watch `org.gnome.desktop.background` (`picture-uri`) via GSettings. Keep a small local config keyed by the wallpaper's URI:

```
{ enabled, mode: flat | layered | replace | disabled, palette: default | custom | match-wallpaper }
```

On wallpaper change, look up the config for the new URI. If none exists, default to `flat` + `match-wallpaper` rather than doing nothing, and let the user override from there.

### Depth-layered mode (optional, auto-selected when the image supports it)
Instead of particles floating flatly over the whole image, split the wallpaper into three actors:

1. **Back** — the original image, untouched (no processing needed — it's occluded by layer 3 anyway).
2. **Middle** — the particle layer.
3. **Front** — a masked cutout of the foreground silhouette (mountains, skyline, etc.), painted on top so particles appear to sit *behind* the foreground.

**Generating the cutout:** for a bright-sky/dark-silhouette photo, a luminance threshold gets most of the way — flag below-cutoff pixels as foreground, clean up with a morphological close/open pass, feather the edge with a small blur so the silhouette line isn't jagged. Runs once per wallpaper change, so it can afford to be a little expensive.

**Sanity check → fallback:** after generating the mask, check its coverage. If it flags almost none or almost all of the image, the split failed (daytime photo, portrait, abstract pattern — no clean separation to find). Fall back to flat overlay automatically, don't force a broken cutout.

**Cutout picker UI:** generate 2–3 threshold variants at once (cheap, one-time cost) and present them as a small picker instead of a fiddly live slider — the user picks one, or rejects all of them in favor of flat overlay. On hover, enlarge the candidate and trace its mask boundary as an overlay line (`Gtk.EventControllerMotion` + `Gtk.Overlay` with a drawn boundary path) so the person can actually see where the algorithm drew the line before committing. Whatever they pick — including "none of these" — gets written to the per-wallpaper config and isn't asked again for that image.

### Palette extraction reuses the same mask
For `match-wallpaper` mode, restrict the k-means palette sampling (downsample to ~100×100, cluster in HSL weighted by saturation, sort by lightness to build the idle→peak arc) to background-only pixels using the mask already computed for layering. Solves the "80% of the image is dark mountain, so the palette is just dark gray" problem for free — one preprocessing pass, two problems solved. (Same general idea as Android's Material You deriving a theme from wallpaper — proven pattern, not a novel risk.) When the source image has no warm hues at all, don't force the default red/amber peak — let intensity read through brightness/saturation shifts within the extracted hue family instead. The punctate-event flash-to-white treatment stays palette-independent either way.

## 7. Resource discipline (don't overload the PC)

Three separate throttles — don't conflate them:
- **Telemetry poll:** 250–500ms, ease the visual toward each new sample rather than snapping.
- **Render tick:** drive off Clutter's own frame clock (actor transitions / `Clutter.Timeline`, and GNOME Shell 50 adds `easeAsync()` for this), not a bare JS interval.
- **Particle budget:** feed back from the CPU load you're already sampling — above a threshold, shrink particle count instead of growing it. The wallpaper shouldn't be what tips a compile job over the edge.
- **Fullscreen:** disconnect timelines, don't just hide actors (see §4).

## 8. Build order

1. Telemetry sampler only — log `SceneState` output, sanity-check against `htop`/`sensors`.
2. Particle renderer against a mocked/static `SceneState`, in a normal window — de-risk the graphics before touching desktop embedding.
3. Wire live telemetry in — System Mode complete, still windowed.
4. Audio pipeline in — Music Mode complete, still windowed.
5. Mode FSM with hysteresis.
6. GNOME Shell extension: per-monitor actors in `_backgroundGroup`, fullscreen obscuration, multi-monitor.
7. Wallpaper layering: cutout generation, per-wallpaper config, picker UI.
8. Performance pass: adaptive particle budget, idle throttling.

## 9. Open risks

- Clutter/GJS particle ceiling (~50 in the Weather Effect reference) may not be enough for a "compiling storm" — the Path B (Rust/wgpu + GStreamer bridge) escape hatch exists for this, but only pursue it if §4's chosen path demonstrably hits the wall.
- GNOME Shell APIs shift release to release — re-verify against the actual GNOME 50 source/`gjs.guide` porting notes before relying on any specific method name.
- Multi-monitor add/remove (docking) is a known rough edge on GNOME/Wayland generally; budget real time for it, not an afterthought.
