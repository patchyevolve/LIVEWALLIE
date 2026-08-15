import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { type SceneClient } from "./sceneClient.js";
import type { Pulse, Stream } from "./sceneState.js";
import type { PaletteAccent } from "./paletteManager.js";

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
}

interface StreakAccent {
    x: number;
    y: number;
    vx: number;
    vy: number;
    hue: number; // 190 (rx/pan_left) | 20 (tx/pan_right)
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

        // Particle budget: max(100, round(600 * (1 - 0.5*cpu))), recomputed
        // from the latest telemetry; applies in both modes.
        const cpu = state.system?.cpu ?? 0;
        const targetCount = Math.max(
            MIN_PARTICLES,
            Math.round(MAX_PARTICLES * (1 - 0.5 * cpu))
        );

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
        // change, not a different app). Eased, uniform — never per-particle.
        const targetAlpha = state.mode === "music" ? 1 : 0.85;
        this._fieldAlpha += (targetAlpha - this._fieldAlpha) * (1 - Math.exp(-dt / 400));
        this._breath *= Math.exp(-dt / 300);
        this._stepParticles(dt);
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
        });
    }

    private _stepParticles(dt: number) {
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
        const speedMul = (1 + this._intensity * 1.6 * musicMul) * idleMul;
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

        for (const p of this._particles) {
            // Grid-obscured cells: freeze (don't step) hidden particles.
            if (this._cellCovered(p.x, p.y)) continue;
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
        const sat = clamp(satBase, 40, 90);
        const lig = clamp(ligBase, 32, 60);

        for (const p of this._particles) {
            // Grid-obscured cells: don't render hidden particles.
            if (this._cellCovered(p.x, p.y)) continue;
            const hue = (baseHue + (p.seed - 0.5) * 14 + 360) % 360;
            let s = sat;
            let l = lig + (p.seed - 0.5) * 8;
            if (p.flashT > 0) {
                // Punctate flash: L=90, S=10 immediately, ease back 200ms.
                const e = easeOutCubic(p.flashT);
                s = s + (10 - s) * e;
                l = l + (90 - l) * e;
            }
            const [r, g, b] = hslToRgb(hue, s / 100, l / 100);
            // Depth twinkle (far stars pulse slowly), beat breath, and the
            // mode-driven ambient brightness — all uniform, no displacement.
            const twinkle = 0.85 + 0.15 * Math.sin(this._tMs * (0.001 + p.depth * 0.002) + p.seed * 6.283);
            const breath = 1 + 0.15 * this._breath;
            const alpha = (p.flashT > 0 ? 0.95 : 0.35 + p.depth * 0.55) * this._fieldAlpha * twinkle * breath;
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
            cr.arc(p.x, p.y, p.size, 0, 2 * Math.PI);
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
    }
}