use serde::Serialize;
use std::time::Instant;

pub const PROTOCOL_VERSION: u32 = 1;

use std::sync::LazyLock;

static START: LazyLock<Instant> = LazyLock::new(Instant::now);

pub fn monotonic_ms() -> u64 {
    START.elapsed().as_millis() as u64
}

pub fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    System,
    Music,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Telemetry,
    Audio,
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PulseKind {
    DiskIo,
    Beat,
}

#[derive(Serialize, Clone, Debug)]
pub struct Pulse {
    pub kind: PulseKind,
    pub strength: f32,
    pub timestamp_ms: u64,
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
pub enum StreamDirection {
    Rx,
    Tx,
    PanLeft,
    PanRight,
}

#[derive(Serialize, Clone, Debug)]
pub struct Stream {
    pub direction: StreamDirection,
    pub strength: f32,
}

/// Raw system metrics. Informational section carried on every message so
/// future consumers (Process City, Living Shell, ...) can reuse the telemetry
/// without the renderer touching these directly.
#[derive(Serialize, Clone, Debug, Default)]
pub struct SystemMetrics {
    pub cpu: f32,              // 0..1 global CPU usage
    pub memory: f32,           // 0..1 RAM used fraction
    pub disk_io: f32,          // normalized delta sectors read/written this window
    pub network_rx: f32,       // normalized rx bytes delta this window
    pub network_tx: f32,       // normalized tx bytes delta this window
    pub temperature: f32,      // 0..1 normalized CPU temp (Tctl/Tdie)
    pub gpu: Option<f32>,      // 0..1 gpu_busy_percent, None if no amdgpu node
    pub battery: Option<f32>,  // 0..1 capacity, None if no battery
    pub process_churn: f32,    // 0..1 process spawn+death rate this window
}

/// Raw audio metrics. Informational section carried on every message.
#[derive(Serialize, Clone, Debug, Default)]
pub struct AudioMetrics {
    pub active: bool,   // true while the mode FSM is in Music
    pub rms: f32,       // normalized full-band RMS
    pub peak: f32,      // normalized peak level
    pub bass: f32,      // normalized bass-band energy
    pub mid: f32,       // normalized mid-band energy
    pub treble: f32,    // normalized treble-band energy
    pub centroid: f32,  // 0..1 spectral centroid position across 20..16000 Hz
    pub beat: bool,     // beat fired this hop
    pub pan: f32,       // -1 (left) .. 1 (right), 0 = centered
}

/// The single shared data contract between the sampler and any renderer.
/// Every field is clamped to its documented range before publishing.
#[derive(Serialize, Clone, Debug)]
pub struct SceneState {
    pub version: u32,
    pub timestamp_ms: u64,
    pub mode: Mode,         // current FSM mode (computed in the sampler)
    pub source: Source,     // which pipeline produced this message

    // Derived render fields — the only thing the renderer consumes.
    pub intensity: f32,     // telemetry: 0.6*cpu + 0.4*ram | audio: RMS
    pub population: f32,    // telemetry: RAM | audio: mid-band energy
    pub heat: f32,          // telemetry: temp | audio: spectral centroid
    pub spawn_rate: f32,    // telemetry: process churn | audio: treble energy
    pub gravity_bias: f32,  // telemetry: 0.0 | audio: bass energy
    pub pulses: Vec<Pulse>, // events since last publish, cleared each publish
    pub streams: Vec<Stream>, // current directional state, replaces previous

    // Raw sections for reuse/debugging.
    pub system: SystemMetrics,
    pub audio: AudioMetrics,
}

impl SceneState {
    pub fn new(mode: Mode, source: Source) -> Self {
        SceneState {
            version: PROTOCOL_VERSION,
            timestamp_ms: monotonic_ms(),
            mode,
            source,
            intensity: 0.0,
            population: 0.0,
            heat: 0.0,
            spawn_rate: 0.0,
            gravity_bias: 0.0,
            pulses: Vec::new(),
            streams: Vec::new(),
            system: SystemMetrics::default(),
            audio: AudioMetrics::default(),
        }
    }
}
