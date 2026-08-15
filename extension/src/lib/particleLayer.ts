import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { type SceneClient } from "./sceneClient.js";
import type { Pulse, Stream } from "./sceneState.js";
import type { PaletteAccent } from "./paletteManager.js";
import { SystemMood } from "./systemMood.js";

const FLASH_DURATION_MS = 200; // ease-out-cubic back to ambient
const EASE_TAU_MS = 180; // field interpolation time constant
const DRIFT_TAU_MS = 250;
const MAX_PARTICLES = 600;
const MIN_PARTICLES = 100;
const FRAME_MS = 16; // ~60fps step cadence (GLib timer)

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    depth: number; // 0 (far/slow/dim) .. 1 (near/fast/bright) — parallax layer
    seed: number; // 0..1, per-particle phase
    size: number;
    flashT: number; // 1 = full flash, decays to 0 over 200ms
    emberVx: number; // wandering-ember velocity override (0 = not an ember)
    emberVy: number;
    emberT: number; // 1 → 0 ember lifetime
}

interface StreakAccent {
    x: number;
    y: number;
    vx: number;
    vy: number;
    hue: number; // 190 (rx/pan_left) | 20 (tx/pan_right)
    life: number; // 1 → 0; mood accents fade and vanish (never persist)
}

function clamp(v: number, lo: number, hi: number) {
    return Math.min(hi, Math.max(lo, v));
}

function easeOutCubic(t: number) {
    return 1 - Math.pow(1 - t, 3);
}

/** §9 two-segment hue arc: 235 -> 300 on [0,0.5], 300 -> 375 mod 360 on [0.5,1]. */
function hueArc(t: number): number {
    if (t <= 0.5) {
        return 235 + (300 - 235) * (t * 2);
    }
    return (300 + (375 - 300) * ((t - 0.5) * 2)) % 360;
}

/** Shortest-path hue interpolation (handles the 340→25 wrap). */
function lerpHue(a: number, b: number, t: number): number {
    let d = ((b - a + 540) % 360) - 180;
    return (a + d * t + 360) % 360;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let [r1, g1, b1] = [0, 0, 0];
    if (hp < 1) [r1, g1, b1] = [c, x, 0];
    else if (hp < 2) [r1, g1, b1] = [x, c, 0];
    else if (hp < 3) [r1, g1, b1] = [0, c, x];
    else if (hp < 4) [r1, g1, b1] = [0, x, c];
    else if (hp < 5) [r1, g1, b1] = [x, 0, c];
    else [r1, g1, b1] = [c, 0, x];
    const m = l - c / 2;
    return [r1 + m, g1 + m, b1 + m];
}

/**
 * One particle field per monitor. Consumes SceneState from the shared client
 * at its own 60fps cadence; the 3.3Hz telemetry stream and the ~47Hz audio
 * stream are interpolated here so neither cadence drives the frame rate.
 */
export class ParticleLayer {
    private _client: SceneClient;
    private _settings: Gio.Settings | null;
    private _getAccent: () => PaletteAccent | null;
    private _accent: PaletteAccent | null;
    private _area: St.DrawingArea;
    private _width: number;
    private _height: number;

    private _particles: Particle[] = [];
    private _accents: StreakAccent[] = [];
    private _phase = Math.random(); // per-monitor independent phase
    private _tMs = 0; // wall-clock for idle shimmer sine
    private _lastPulseBatchId = -1; // per-layer cursor into shared pulse batches
    private _surge = 0; // 1 = beat just fired; multiplies drift speed, decays ~250ms
    private _breath = 0; // beat "breath": whole-field brightness bump, decays ~300ms
    private _fieldAlpha = 0.85; // eased ambient brightness (music brightens the field)

    // Mood pipeline (System mode): telemetry → slow visual mood. Consumed
    // each frame; events (tide wave, GPU accents, embers) are rate-limited
    // and fire on changes, not absolute levels.
    private _mood = new SystemMood(Date.now());
    private _waveX = -1; // traveling brightness wave position, -1 = inactive
    private _waveSpeed = 0;
    private _emberNextMs = 8000 + Math.random() * 12000; // first ember soon-ish
    private _eventAccents: StreakAccent[] = [];

    // Eased/interpolated field targets.
    private _intensity = 0;
    private _population = 0;
    private _heat = 0;
    private _spawnRate = 0;
    private _gravityBias = 0;
    private _drift = 0; // net horizontal drift velocity bias, eased
    private _accentDrift = 0;
    private _accentActive = false;

    private _timerId: number | null = null;
    private _lastFrameUs = 0;
    private _running = false;
    private _destroyed = false;

    // §6 layering: optional foreground alpha in layer coordinates. Particles
    // over foreground pixels fade out — the wallpaper is never repainted.
    private _foreground: { alpha: number[]; w: number; h: number } | null =
        null;

    // Pointer interaction: cursor position in layer coordinates (null when
    // the compositor can't report it). Read once per frame in _stepParticles.
    private _getPointer: (() => { x: number; y: number } | null) | null =
        null;

    // Obscured-window grid: cellSize cells marked 1 are covered by a window.
    // Covered particles are neither stepped nor drawn — the field is frozen
    // and unrendered behind windows of any size.
    private _covered: {
        grid: Uint8Array;
        cols: number;
        cell: number;
    } | null = null;

    setCoveredGrid(grid: Uint8Array | null, cols: number, cell: number) {
        this._covered = grid ? { grid, cols, cell } : null;
    }

    private _cellCovered(x: number, y: number): boolean {
        const c = this._covered;
        if (!c) return false;
        return c.grid[((y / c.cell) | 0) * c.cols + ((x / c.cell) | 0)] === 1;
    }

    constructor(
        client: SceneClient,
        width: number,
        height: number,
        settings: Gio.Settings | null,
        getAccent: () => PaletteAccent | null,
        getPointer: (() => { x: number; y: number } | null) | null = null
    ) {
        this._client = client;
        this._width = width;
        this._height = height;
        this._settings = settings;
        this._getAccent = getAccent;
        this._getPointer = getPointer;
        this._accent = getAccent();

        this._area = new St.DrawingArea({ reactive: false });
        this._area.set_size(width, height);
        this._area.connect("repaint", () => {
            this._draw(this._area.get_context());
        });
    }

    getActor(): St.DrawingArea {
        return this._area;
    }

    /** §6 layering: foreground alpha grid in layer coordinates (row-major,
     *  w*h entries). null disables. Called on mask changes, not per frame —
     *  the draw loop only reads it. */
    setForegroundMask(alpha: number[] | null, w: number, h: number) {
        this._foreground = alpha ? { alpha, w, h } : null;
    }

    /** Rebuild the actor/content for a new monitor geometry. */
    resize(width: number, height: number) {
        this._width = width;
        this._height = height;
        this._area.set_size(width, height);
    }

    start() {
        if (this._running || this._destroyed) return;
        this._running = true;
        this._startTimer();
    }

    /** Fullscreen: stop the timer entirely (not hide). State is preserved. */
    pause() {
        this._running = false;
        this._stopTimer();
    }

    resume() {
        if (this._destroyed) return;
        this.start();
    }

    destroy() {
        this._destroyed = true;
        this._running = false;
        this._stopTimer();
        try {
            this._area.destroy();
        } catch (e) {}
        this._particles = [];
        this._accents = [];
    }

    private _startTimer() {
        if (this._timerId !== null) return;
        this._lastFrameUs = GLib.get_monotonic_time();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            const nowUs = GLib.get_monotonic_time();
            const dt = clamp((nowUs - this._lastFrameUs) / 1000, 0, 100);
            this._lastFrameUs = nowUs;
            this._step(dt);
            this._area.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    private _stopTimer() {
        if (this._timerId === null) return;
        GLib.source_remove(this._timerId);
        this._timerId = null;
    }

    // ------------------------------------------------------------------
    // Frame stepping (60fps, independent of IPC cadence)
    // ------------------------------------------------------------------

    private _step(dt: number) {
        const state = this._client.getState();
        const stale = this._client.isStale();

        // Targets. When disconnected, decay toward idle (no fabricated data).
        const targetIntensity = stale ? 0 : state.intensity;
        const targetPopulation = stale ? 0 : state.population;
        const targetHeat = stale ? 0 : state.heat;
        const targetSpawn = stale ? 0 : state.spawn_rate;
        const targetGravity = stale ? 0 : state.gravity_bias;

        const k = 1 - Math.exp(-dt / EASE_TAU_MS);
        this._intensity += (targetIntensity - this._intensity) * k;
        this._population += (targetPopulation - this._population) * k;
        this._heat += (targetHeat - this._heat) * k;
        this._spawnRate += (targetSpawn - this._spawnRate) * k;
        this._gravityBias += (targetGravity - this._gravityBias) * k;

        // Streams -> directional drift (eased so per-publish churn is smooth).
        const streams: Stream[] = stale ? [] : this._client.getStreams();
        let driftTarget = 0;
        let accentDriftTarget = 0;
        let accentActive = false;
        for (const s of streams) {
            const dir = s.direction === "rx" || s.direction === "pan_left" ? -1 : 1;
            driftTarget += dir * s.strength;
            if (s.strength > 0.02) {
                accentActive = true;
                accentDriftTarget += dir * s.strength;
            }
        }
        this._drift += (driftTarget - this._drift) * (1 - Math.exp(-dt / DRIFT_TAU_MS));
        this._accentDrift +=
            (accentDriftTarget - this._accentDrift) * (1 - Math.exp(-dt / DRIFT_TAU_MS));
        this._accentActive = accentActive;

        // Particle budget: fixed 600. The old CPU->count coupling (600 * (1-0.5*cpu))
        // caused instant mass spawn/despawn pops — the tide/wave/hue mood
        // carries CPU representation now.
        const targetCount = MAX_PARTICLES;

        // Pulse events: flash + a directional speed surge along the drift axis —
// a "warp pulse" that never displaces particles out of the field. No radial
// push: a center-origin burst would drain the middle of the field, because
// edge-wrap can only refill from the edges. All monitors get the same batch.
        if (state.mode === "music") {
            const batch = this._client.getPulseBatch(this._lastPulseBatchId);
            if (batch.id !== this._lastPulseBatchId) {
                this._lastPulseBatchId = batch.id;
                for (const pulse of batch.pulses) {
                    const n = Math.max(1, Math.round(this._particles.length * 0.3));
                    for (let i = 0; i < n; i++) {
                        const p = this._particles[Math.floor(Math.random() * this._particles.length)];
                        if (p) p.flashT = 1;
                    }
                    this._surge = Math.min(1.4, 0.6 + pulse.strength);
                    this._breath = 1;
                }
            }
        }

        this._adjustCount(targetCount);
        // Ambient brightness: music lifts the whole field (mode change = mood
        // change, not a different app). System mode: battery mood dims/boosts
        // slowly (minutes-scale, nonlinear). Eased, uniform — never
        // per-particle.
        const nowMs = Date.now();
        this._mood.update(state.system, dt);
        const moodBright =
            state.mode === "system" ? this._mood.getBrightness() : 1;
        const targetAlpha = (state.mode === "music" ? 1 : 0.85) * moodBright;
        this._fieldAlpha += (targetAlpha - this._fieldAlpha) * (1 - Math.exp(-dt / 400));
        this._breath *= Math.exp(-dt / 300);
        this._stepParticles(dt, state, nowMs);
        this._stepAccents(dt);
    }

    private _adjustCount(target: number) {
        while (this._particles.length < target) {
            this._spawnParticle(true);
        }
        while (this._particles.length > target) {
            this._particles.pop();
        }
    }

    private _spawnParticle(anywhere: boolean) {
        const depth = Math.random();
        this._particles.push({
            x: Math.random() * this._width,
            y: anywhere ? Math.random() * this._height : -20,
            vx: 0,
            vy: 0,
            depth,
            seed: Math.random(),
            size: 1.2 + depth * 2.2,
            flashT: 0,
            emberVx: 0,
            emberVy: 0,
            emberT: 0,
        });
    }

    private _stepParticles(dt: number, state: any, nowMs: number) {
        const w = this._width;
        const h = this._height;
        this._tMs += dt;
        const s = dt / 1000; // seconds per frame — all velocities are px/s

        // Parallax starfield: every particle drifts horizontally, near ones
        // faster than far ones (layered speeds). Velocities are SET directly
        // every frame — never accumulated — so the motion is perfectly smooth
        // and coherent, no twitching. Music scales the base drift, bass pulls
        // down, pan/network streams push sideways, beats surge along the drift.
        // Speeds: 6..40 px/s idle, up to ~2.6x under loud music, brief
        // ~1.4x surge on beats (decays over ~250ms) — a warp pulse in the
        // drift direction, never displacing particles out of the field.
        // All multipliers come from user settings (per-frame GSettings reads
        // are cheap: compiled-schema lookups, not D-Bus).
        const s0 = this._settings;
        const idleMul = s0 ? s0.get_double("idle-speed") : 1;
        const musicMul = s0 ? s0.get_double("music-speed") : 1;
        const shimmer = s0 ? s0.get_boolean("shimmer") : true;
        const bassOn = s0 ? s0.get_boolean("bass-gravity") : true;
        const bassMul = s0 ? s0.get_double("bass-strength") : 1;
        const surgeOn = s0 ? s0.get_boolean("beat-surge") : true;
        const surgeMul = s0 ? s0.get_double("beat-strength") : 1;
        const streamOn = s0 ? s0.get_boolean("stream-drift") : true;
        const streamMul = s0 ? s0.get_double("stream-strength") : 1;
        let speedMul = (1 + this._intensity * 1.6 * musicMul) * idleMul;
        // Mood multipliers: idle breathing (±5%, telemetry-independent, both
        // modes) and the CPU tide (±10%, System mode only, τ≈6s).
        const inSystem = state.mode === "system";
        speedMul *= this._mood.getBreath(nowMs) * (inSystem ? this._mood.getTide() : 1);
        const surge = surgeOn ? this._surge * surgeMul : 0;
        this._surge *= Math.exp(-dt / 250);
        const gravity = bassOn ? this._gravityBias * 90 * bassMul : 0; // px/s, bass rain
        const drift = streamOn ? this._drift * 60 * streamMul : 0; // px/s, net horizontal push
        const churnP = this._spawnRate * 0.00035 * dt; // respawn probability

        // Pointer interaction: one read per frame; impulse applied below.
        let ptrX = 0;
        let ptrY = 0;
        let ptrR = 0;
        let ptrStr = 0;
        const ptrOn = s0 ? s0.get_boolean("pointer-effect") : true;
        if (ptrOn && this._getPointer) {
            const ptr = this._getPointer();
            if (ptr) {
                ptrX = ptr.x;
                ptrY = ptr.y;
                ptrR = s0 ? s0.get_double("pointer-radius") : 180;
                ptrStr = s0 ? s0.get_double("pointer-strength") : 1;
            }
        }
        const ptrR2 = ptrR * ptrR;

        // Mood events (System mode, rate-limited, change-driven):
        //   - tide wave: CPU rising >12% above its mood → a soft brightness
        //     band sweeps across the field once.
        //   - GPU accent: smoothed GPU load accumulates a probability; each
        //     hit spawns one short streak, never a meter.
        //   - Embers: telemetry-independent rare clusters that drift through
        //     diagonally — life even on a fully idle machine.
        if (inSystem && this._mood.consumeTideWave(state.system, nowMs)) {
            this._waveX = -160;
            this._waveSpeed = w / 4500; // ~4.5s to cross the field
        }
        if (this._waveX >= 0) {
            this._waveX += this._waveSpeed * dt;
            if (this._waveX > w + 120) this._waveX = -1;
        }
        if (inSystem && this._mood.consumeAccentEvent(dt, nowMs)) {
            if (this._eventAccents.length < 4) {
                this._eventAccents.push({
                    x: Math.random() * w,
                    y: Math.random() * h,
                    vx: (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 60),
                    vy: 0,
                    hue: Math.random() < 0.5 ? 190 : 20,
                    life: 1,
                });
            }
        }
        this._emberNextMs -= dt;
        if (this._emberNextMs <= 0) {
            this._emberNextMs = 8000 + Math.random() * 12000;
            const cx = w * (0.1 + Math.random() * 0.8);
            const cy = h * (0.1 + Math.random() * 0.8);
            // Near-horizontal drift (within ±34° of the x axis) so embers
            // always read as something crossing the field — never as a
            // random group going up/down.
            const ang =
                (Math.random() < 0.5 ? 0 : Math.PI) +
                (Math.random() - 0.5) * 1.2;
            const spd = 80 + Math.random() * 60;
            const evx = Math.cos(ang) * spd;
            const evy = Math.sin(ang) * spd;
            let n = 0;
            for (const p of this._particles) {
                const dx = p.x - cx;
                const dy = p.y - cy;
                if (dx * dx + dy * dy < 90 * 90) {
                    p.emberVx = evx;
                    p.emberVy = evy;
                    p.emberT = 1;
                    if (++n >= 8) break;
                }
            }
        }

        for (const p of this._particles) {
            // Covered cells skip RENDERING (in _draw), never stepping —
            // the field keeps flowing invisibly behind windows so particles
            // emerge on the other side.
            const baseSpeed = (6 + p.depth * 34) * speedMul * (1 + surge);
            p.vx = baseSpeed + drift;
            // All velocities are px/s; the single *s below converts to px per
            // frame. (A double multiply here used to kill gravity/shimmer —
            // respawned particles piled up at the top and never fell.)
            p.vy =
                gravity +
                (shimmer
                    ? Math.sin(this._tMs * 0.0015 + p.seed * 6.283) * 30 * speedMul * (1 + surge)
                    : 0);
            // Pointer interaction: radial push away from the cursor plus a
            // small tangential swirl — particles "part" around it like water.
            // Force falls off linearly to zero at the radius edge.
            if (ptrR2 > 0) {
                const dxp = p.x - ptrX;
                const dyp = p.y - ptrY;
                const d2 = dxp * dxp + dyp * dyp;
                if (d2 < ptrR2 && d2 > 0.01) {
                    const d = Math.sqrt(d2);
                    const f = (1 - d / ptrR) * ptrStr;
                    const push = f * 260;
                    const swirl = f * 90;
                    p.vx += (dxp / d) * push + (-dyp / d) * swirl;
                    p.vy += (dyp / d) * push + (dxp / d) * swirl;
                }
            }
            // Ember override: drifting embers steer themselves for their
            // lifetime (≈4s), then hand control back to the field.
            if (p.emberT > 0) {
                p.vx = p.emberVx;
                p.vy = p.emberVy;
                p.emberT = Math.max(0, p.emberT - dt / 4000);
            }
            p.x += p.vx * s;
            p.y += p.vy * s;

            if (Math.random() < churnP) {
                p.x = Math.random() * w;
                p.y = Math.random() * h; // recycle anywhere — never the top edge
            }

            if (p.y > h + 30) {
                p.y = -10;
                p.x = Math.random() * w;
            } else if (p.y < -30) {
                p.y = h + 20;
            }
            if (p.x > w + 20) p.x = -20;
            else if (p.x < -20) p.x = w + 20;

            if (p.flashT > 0) {
                p.flashT = Math.max(0, p.flashT - dt / FLASH_DURATION_MS);
            }
        }
    }

    private _stepAccents(dt: number) {
        const target = this._accentActive ? 24 : 0;
        while (this._accents.length < target) {
            this._accents.push({
                x: Math.random() * this._width,
                y: Math.random() * this._height,
                vx: 0,
                vy: 0,
                hue: this._accents.length % 2 === 0 ? 190 : 20,
                life: 1,
            });
        }
        while (this._accents.length > target) this._accents.pop();
        const force = 0.00018 * Math.abs(this._accentDrift) * dt;
        const dir = Math.sign(this._accentDrift) || 1;
        for (const a of this._accents) {
            a.vx += dir * force;
            a.vx *= Math.exp(-dt / 300);
            a.vy *= Math.exp(-dt / 300);
            a.x += a.vx * dt;
            a.y += a.vy * dt;
            if (a.x < -30) a.x = this._width + 20;
            if (a.x > this._width + 30) a.x = -20;
            if (a.y < -30) a.y = this._height + 20;
            if (a.y > this._height + 30) a.y = -20;
        }
        // Mood event accents (GPU-driven): constant-velocity sparks with a
        // ~1.5s life — they fade and vanish, never persist or accumulate.
        for (let i = this._eventAccents.length - 1; i >= 0; i--) {
            const a = this._eventAccents[i];
            a.life -= dt / 1500;
            if (a.life <= 0) {
                this._eventAccents.splice(i, 1);
                continue;
            }
            a.x += a.vx * dt;
            if (a.x < -30) a.x = this._width + 20;
            if (a.x > this._width + 30) a.x = -20;
        }
    }

    // ------------------------------------------------------------------
    // Rendering (§9 color system)
    // ------------------------------------------------------------------

    private _draw(cr: any) {
        const state = this._client.getState();
        this._accent = this._getAccent();

        // Hue arc input: heat (system) | bass/treble balance (audio).
        let t: number;
        if (state.mode === "music") {
            t = clamp((state.gravity_bias - state.spawn_rate + 1) / 2, 0, 1);
        } else {
            t = clamp(state.heat, 0, 1);
        }

        // Palette source: built-in arc | fixed user hue | wallpaper accent.
        // "fixed"/"wallpaper" sweep a +/-35° span around the chosen base hue
        // as activity rises, so both modes still read as a mood change.
        let baseHue = hueArc(t);
        let satBase = 40 + 70 * this._intensity;
        let ligBase = 32 + 45 * this._intensity;
        const s0 = this._settings;
        const mode = s0 ? s0.get_string("palette-mode") : "arc";
        if (mode === "fixed") {
            const h = s0 ? s0.get_double("fixed-hue") : 300;
            baseHue = (h + (t - 0.5) * 70 + 360) % 360;
        } else if (mode === "wallpaper") {
            const accent = this._accent;
            if (accent) {
                const shift = s0 ? s0.get_double("accent-shift") : 0;
                baseHue = (accent.hue + shift + (t - 0.5) * 70 + 360) % 360;
                satBase = 25 + accent.sat * 0.5 + 35 * this._intensity;
                ligBase = 25 + accent.lig * 0.4 + 30 * this._intensity;
            }
        }
        // System mode: temperature owns the hue when the user is on the default
        // "arc" palette (cool idle = indigo/cyan, load = amber). With an
        // explicit palette (fixed/wallpaper accent) the chosen hue stays the
        // base — temperature only leans it toward amber (hot) or indigo
        // (cool), at most 40% of the way, so the user's color still rules.
        // A tiny ±4° wobble keeps it alive without ever twitching.
        const inSystem = state.mode === "system";
        if (inSystem) {
            const wob = 4 * Math.sin(this._tMs * 0.0003);
            if (mode === "arc") {
                baseHue = (this._mood.getHue() + wob + 360) % 360;
            } else {
                const temp = this._mood.getTemp();
                if (temp > 0.4) {
                    baseHue = lerpHue(baseHue, 35, clamp((temp - 0.4) / 0.6, 0, 1) * 0.4);
                    // Warm accents don't change hue much — lean sat/lightness
                    // so heat still visibly warms the field.
                    ligBase += (temp - 0.4) * 25;
                    satBase += (temp - 0.4) * 12;
                } else {
                    baseHue = lerpHue(baseHue, 255, clamp((0.4 - temp) / 0.4, 0, 1) * 0.4);
                    ligBase += (temp - 0.4) * 25;
                }
                baseHue = (baseHue + wob + 360) % 360;
            }
        }
        const sat = clamp(satBase, 40, 90);
        const lig = clamp(ligBase, 32, 60);

        for (const p of this._particles) {
            // Grid-obscured cells: don't render hidden particles.
            if (this._cellCovered(p.x, p.y)) continue;
            let hue = (baseHue + (p.seed - 0.5) * 14 + 360) % 360;
            let s = sat;
            let l = lig + (p.seed - 0.5) * 8;
            if (p.flashT > 0) {
                // Punctate flash: L=90, S=10 immediately, ease back 200ms.
                const e = easeOutCubic(p.flashT);
                s = s + (10 - s) * e;
                l = l + (90 - l) * e;
            }
            // Traveling tide wave: a soft brightness band sweeping across —
            // CPU load rising, not sustained. Lifts lightness too, so it
            // shows against busy dark wallpapers.
            let waveLift = 0;
            if (this._waveX >= 0) {
                const wd = Math.abs(p.x - this._waveX);
                if (wd < 240) waveLift = 1 - wd / 240;
            }
            if (waveLift > 0) l = Math.min(95, l + waveLift * 20);
            // Wandering embers: fixed warm amber, big and bright — they must
            // pop against the cool field, not blend into it.
            const ember = p.emberT > 0;
            if (ember) {
                hue = 45 + p.seed * 15;
                l = Math.min(95, l + 28 * p.emberT);
                waveLift = Math.max(waveLift, 0.6 * p.emberT);
            }
            const [r, g, b] = hslToRgb(hue, s / 100, l / 100);
            // Depth twinkle (far stars pulse slowly), beat breath, and the
            // mode-driven ambient brightness — all uniform, no displacement.
            const twinkle = 0.85 + 0.15 * Math.sin(this._tMs * (0.001 + p.depth * 0.002) + p.seed * 6.283);
            const breath = 1 + 0.15 * this._breath;
            const lift = 1 + waveLift * 1.1;
            const alpha = (p.flashT > 0 ? 0.95 : 0.35 + p.depth * 0.55) * this._fieldAlpha * twinkle * breath * lift;
            let a = Math.min(1, alpha);
            // §6 layering: fade particles out over foreground pixels.
            const fg = this._foreground;
            if (fg) {
                const sx = Math.floor(p.x);
                const sy = Math.floor(p.y);
                if (sx >= 0 && sy >= 0 && sx < fg.w && sy < fg.h) {
                    a *= 1 - fg.alpha[sy * fg.w + sx];
                }
            }
            if (a <= 0.003) continue;
            cr.setSourceRGBA(r, g, b, a);
            const radius = ember ? p.size * (1 + 0.8 * p.emberT) : p.size;
            cr.arc(p.x, p.y, radius, 0, 2 * Math.PI);
            cr.fill();
        }

        // Directional accents: 190° cyan (rx/pan_left), 20° coral (tx/pan_right),
        // flat S=50 annotations drawn as motion streaks.
        for (const a of this._accents) {
            if (this._cellCovered(a.x, a.y)) continue;
            const [r, g, b] = hslToRgb(a.hue, 0.5, 0.55);
            cr.setSourceRGBA(r, g, b, 0.7);
            cr.moveTo(a.x, a.y);
            cr.lineTo(a.x - a.vx * 30, a.y - a.vy * 30);
            cr.setLineWidth(2);
            cr.stroke();
        }
        // GPU-driven mood accents: occasional short sparks, rate-limited,
        // fading and shrinking over their ~1.5s life. Trail = 0.3s of
        // travel (vx is px/s — multiplying by 20 drew screen-length lines).
        for (const a of this._eventAccents) {
            if (this._cellCovered(a.x, a.y)) continue;
            const [r, g, b] = hslToRgb(a.hue, 0.55, 0.65);
            const life = Math.max(0, a.life);
            cr.setSourceRGBA(r, g, b, 0.55 * life);
            cr.moveTo(a.x, a.y);
            cr.lineTo(a.x - a.vx * 0.3 * life, a.y - a.vy * 0.3 * life);
            cr.setLineWidth(2);
            cr.stroke();
        }
    }
}