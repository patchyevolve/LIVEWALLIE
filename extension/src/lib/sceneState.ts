/**
 * SceneState protocol types, mirroring sampler/src/scene_state.rs exactly.
 * The sampler is the only producer of these values; the renderer only reads.
 */

export const PROTOCOL_VERSION = 1;

export type Mode = "system" | "music";
export type Source = "telemetry" | "audio";
export type PulseKind = "disk_io" | "beat";
export type StreamDirection = "rx" | "tx" | "pan_left" | "pan_right";

export interface Pulse {
    kind: PulseKind;
    strength: number; // 0.0-1.0
    timestamp_ms: number;
}

export interface Stream {
    direction: StreamDirection;
    strength: number; // 0.0-1.0
}

export interface SystemMetrics {
    cpu: number; // 0..1
    memory: number; // 0..1
    disk_io: number; // 0..1
    network_rx: number; // 0..1
    network_tx: number; // 0..1
    temperature: number; // 0..1
    gpu: number | null;
    battery: number | null;
    process_churn: number; // 0..1
}

export interface AudioMetrics {
    active: boolean;
    rms: number; // 0..1
    peak: number; // 0..1
    bass: number; // 0..1
    mid: number; // 0..1
    treble: number; // 0..1
    centroid: number; // 0..1
    beat: boolean;
    pan: number; // -1..1
}

export interface SceneState {
    version: number;
    timestamp_ms: number;
    mode: Mode;
    source: Source;

    // Derived render fields — the only thing the renderer consumes.
    intensity: number; // telemetry: 0.6*cpu+0.4*ram | audio: RMS
    population: number; // telemetry: RAM | audio: mid-band energy
    heat: number; // telemetry: temp | audio: spectral centroid
    spawn_rate: number; // telemetry: process churn | audio: treble energy
    gravity_bias: number; // telemetry: 0.0 | audio: bass energy
    pulses: Pulse[];
    streams: Stream[];

    // Raw sections for reuse/debugging.
    system: SystemMetrics;
    audio: AudioMetrics;
}

export const EMPTY_SYSTEM: SystemMetrics = {
    cpu: 0,
    memory: 0,
    disk_io: 0,
    network_rx: 0,
    network_tx: 0,
    temperature: 0,
    gpu: null,
    battery: null,
    process_churn: 0,
};

export const EMPTY_AUDIO: AudioMetrics = {
    active: false,
    rms: 0,
    peak: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    centroid: 0,
    beat: false,
    pan: 0,
};

export const EMPTY_STATE: SceneState = {
    version: PROTOCOL_VERSION,
    timestamp_ms: 0,
    mode: "system",
    source: "telemetry",
    intensity: 0,
    population: 0,
    heat: 0,
    spawn_rate: 0,
    gravity_bias: 0,
    pulses: [],
    streams: [],
    system: EMPTY_SYSTEM,
    audio: EMPTY_AUDIO,
};

export function isSceneState(x: any): x is SceneState {
    return (
        typeof x === "object" &&
        x !== null &&
        x.version === PROTOCOL_VERSION &&
        typeof x.timestamp_ms === "number" &&
        (x.mode === "system" || x.mode === "music") &&
        (x.source === "telemetry" || x.source === "audio") &&
        typeof x.intensity === "number" &&
        typeof x.population === "number" &&
        typeof x.heat === "number" &&
        typeof x.spawn_rate === "number" &&
        typeof x.gravity_bias === "number" &&
        Array.isArray(x.pulses) &&
        Array.isArray(x.streams) &&
        typeof x.system === "object" &&
        typeof x.audio === "object"
    );
}