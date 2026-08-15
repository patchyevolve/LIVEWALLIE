/**
 * SystemMood — telemetry → slow visual mood (renderer side of the mood
 * pipeline).
 *
 * The sampler publishes raw, normalized SystemMetrics over IPC; this class
 * is the only consumer. It applies exponential smoothing with per-signal
 * time constants (temperature ~25s, CPU ~6s, battery ~minutes, GPU ~10s)
 * and produces:
 *
 *   - hue:          normalized temperature → cool indigo → cyan → violet →
 *                   amber → warm (piecewise, wrap-aware)
 *   - brightness:   battery curve (nonlinear, long-smoothed; charging +3%,
 *                   low battery → ~70%; None on desktop → 1.0)
 *   - tide:         CPU ±10% velocity multiplier (τ 6s)
 *   - breath:       telemetry-independent 60–90s sine, ±5% (both modes)
 *   - tideWave:     rising-edge event — raw CPU rising >12% above its mood,
 *                   rate-limited to one per 20s
 *   - accentEvent:  GPU-driven accent probability (~30s mean at full load),
 *                   rate-limited to one per 12s
 *
 * Nothing here drives particle positions directly — the renderer maps these
 * calm values into speed/hue/alpha. Events fire on changes, not absolute
 * levels, and are rate-limited so sustained load never twitches the field.
 */

interface MoodSystemMetrics {
    cpu?: number;
    temperature?: number;
    battery?: number | null;
    gpu?: number | null;
}

const TAU_TEMP_MS = 25000;
const TAU_CPU_MS = 6000;
const TAU_BATT_MS = 120000;
const TAU_GPU_MS = 10000;
const WAVE_MIN_GAP_MS = 12000;
const ACCENT_MIN_GAP_MS = 12000;
const ACCENT_MEAN_MS = 20000;
const WAVE_RISE = 0.06;

/** Hue waypoints on normalized temperature (hardware-independent 0..1):
 *  cool indigo → cyan → violet → amber → warm. */
const TEMP_HUE: Array<[number, number]> = [
    [0.0, 265],
    [0.3, 265],
    [0.5, 200],
    [0.7, 290],
    [0.85, 340],
    [1.0, 25],
];

function lerpHue(a: number, b: number, t: number): number {
    // Shortest-path hue interpolation (handles the 340→25 wrap).
    let d = ((b - a + 540) % 360) - 180;
    return (a + d * t + 360) % 360;
}

function ease(dt: number, tau: number): number {
    return 1 - Math.exp(-dt / tau);
}

export class SystemMood {
    private _cpu = 0;
    private _temp = 0;
    private _batt = 0.5;
    private _battKnown = false;
    private _charging = false;
    private _gpu = 0;
    private _gpuKnown = false;

    private _breathPeriodMs: number;
    private _t0Ms: number;
    private _lastWaveMs = -1e9;
    private _lastAccentMs = -1e9;
    private _accentProb = 0;

    constructor(nowMs: number) {
        this._t0Ms = nowMs;
        this._breathPeriodMs = 60000 + Math.random() * 30000;
    }

    /** Feed one telemetry update (dt = renderer frame time in ms). */
    update(sys: MoodSystemMetrics | null | undefined, dt: number) {
        if (!sys) return;
        const kT = ease(dt, TAU_TEMP_MS);
        const kC = ease(dt, TAU_CPU_MS);
        const kB = ease(dt, TAU_BATT_MS);
        const kG = ease(dt, TAU_GPU_MS);
        if (sys.temperature !== undefined && sys.temperature > 0.001) {
            this._temp += (sys.temperature - this._temp) * kT;
        }
        if (sys.cpu !== undefined) {
            this._cpu += (sys.cpu - this._cpu) * kC;
        }
        if (sys.battery !== undefined && sys.battery !== null) {
            this._battKnown = true;
            this._batt += (sys.battery - this._batt) * kB;
        }
        if (sys.gpu !== undefined && sys.gpu !== null) {
            this._gpuKnown = true;
            this._gpu += (sys.gpu - this._gpu) * kG;
        }
    }

    setCharging(charging: boolean) {
        this._charging = charging;
    }

    /** Temperature → hue, wrap-aware, smoothed at τ≈25s. */
    getHue(): number {
        const t = this._temp;
        for (let i = 0; i < TEMP_HUE.length - 1; i++) {
            const [t0, h0] = TEMP_HUE[i];
            const [t1, h1] = TEMP_HUE[i + 1];
            if (t <= t1) {
                const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
                return lerpHue(h0, h1, f);
            }
        }
        return TEMP_HUE[TEMP_HUE.length - 1][1];
    }

    /** Smoothed normalized temperature (0..1), for palette-relative leans. */
    getTemp(): number {
        return this._temp;
    }

    /** Battery → ambient brightness multiplier (0.70..1.03). Desktop: 1.0. */
    getBrightness(): number {
        if (!this._battKnown) return 1;
        if (this._charging) return 1.03;
        // Nonlinear: 1% steps are invisible; low battery dims toward 70%.
        return 0.7 + 0.3 * Math.pow(Math.max(0, this._batt), 0.7);
    }

    /** CPU → velocity multiplier, ±10% around 50% (τ≈6s). */
    getTide(): number {
        return 1 + (this._cpu - 0.5) * 0.2;
    }

    /** Idle breathing, independent of telemetry: 1 + 5% over 60–90s. */
    getBreath(nowMs: number): number {
        const phase = ((nowMs - this._t0Ms) % this._breathPeriodMs) / this._breathPeriodMs;
        return 1 + 0.05 * Math.sin(phase * 2 * Math.PI);
    }

    /** Rising-edge tide wave: raw CPU >12% above its mood, ≥20s apart. */
    consumeTideWave(sys: MoodSystemMetrics | null | undefined, nowMs: number): boolean {
        if (!sys || sys.cpu === undefined) return false;
        const rising = sys.cpu - this._cpu > WAVE_RISE;
        if (!rising) return false;
        if (nowMs - this._lastWaveMs < WAVE_MIN_GAP_MS) return false;
        this._lastWaveMs = nowMs;
        console.log(
            `[live-wallpaper] mood: tide wave (cpu ${(sys.cpu * 100).toFixed(0)}%, mood ${(this._cpu * 100).toFixed(0)}%)`
        );
        return true;
    }

    /** GPU-driven accent event: probability ∝ smoothed GPU, ≥12s apart. */
    consumeAccentEvent(dt: number, nowMs: number): boolean {
        if (!this._gpuKnown) return false;
        this._accentProb += (this._gpu * dt) / ACCENT_MEAN_MS;
        if (this._accentProb < 1) return false;
        this._accentProb = 0;
        if (nowMs - this._lastAccentMs < ACCENT_MIN_GAP_MS) return false;
        this._lastAccentMs = nowMs;
        console.log(
            `[live-wallpaper] mood: gpu spark (gpu ${(this._gpu * 100).toFixed(0)}%)`
        );
        return true;
    }
}