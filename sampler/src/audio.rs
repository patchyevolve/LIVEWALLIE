use crate::fsm::ModeFsm;
use crate::ipc::IpcServer;
use crate::scene_state::{
    clamp01, monotonic_ms, AudioMetrics, Mode, Pulse, PulseKind, SceneState, Stream,
    StreamDirection, SystemMetrics,
};
use libpulse_binding::callbacks::ListResult;
use libpulse_binding::context::{Context, FlagSet as ContextFlagSet, State as ContextState};
use libpulse_binding::mainloop::standard::Mainloop;
use libpulse_binding::sample::{Format as SampleFormat, Spec as SampleSpec};
use libpulse_binding::stream::{
    FlagSet as StreamFlagSet, PeekResult, State as StreamState, Stream as PulseStream,
};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

const FFT_SIZE: usize = 2048;
const HOP: usize = 1024;
const FLUX_HISTORY: usize = 43; // ~1s at this hop size
const BEAT_DEBOUNCE_MS: u64 = 120;

// dBFS mapping shared by RMS and band energies.
const DB_FLOOR: f32 = -60.0;
const DB_CEILING: f32 = -6.0;

const BASS_LO: f32 = 20.0;
const BASS_HI: f32 = 250.0;
const MID_HI: f32 = 4000.0;
const TREBLE_HI: f32 = 16000.0;

/// Shared state between the sampler threads.
pub struct SharedState {
    pub mode: Mutex<Mode>,
    pub system: Mutex<SystemMetrics>,
    pub audio: Mutex<AudioMetrics>,
}

impl Default for SharedState {
    fn default() -> Self {
        SharedState {
            mode: Mutex::new(Mode::System),
            system: Mutex::new(SystemMetrics::default()),
            audio: Mutex::new(AudioMetrics::default()),
        }
    }
}

fn norm_dbfs(dbfs: f32) -> f32 {
    clamp01((dbfs - DB_FLOOR) / (DB_CEILING - DB_FLOOR))
}

struct BandBins {
    bass: Vec<usize>,
    mid: Vec<usize>,
    treble: Vec<usize>,
}

impl BandBins {
    fn new(rate: u32) -> Self {
        let nyquist = rate as f32 / 2.0;
        let mut bass = Vec::new();
        let mut mid = Vec::new();
        let mut treble = Vec::new();
        for k in 1..(FFT_SIZE / 2) {
            let f = k as f32 * rate as f32 / FFT_SIZE as f32;
            if f >= BASS_LO && f < BASS_HI {
                bass.push(k);
            } else if f >= BASS_HI && f < MID_HI {
                mid.push(k);
            } else if f >= MID_HI && f < TREBLE_HI && f <= nyquist {
                treble.push(k);
            }
        }
        BandBins { bass, mid, treble }
    }
}

struct Analyzer {
    rate: u32,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,       // Hann window, length FFT_SIZE
    ring: Vec<f32>,         // rolling mono samples, length FFT_SIZE
    ring_pos: usize,
    spectrum: Vec<Complex<f32>>,
    mag_prev: Vec<f32>,
    flux_history: VecDeque<f32>,
    last_beat_ms: u64,
    bins: BandBins,
}

impl Analyzer {
    fn new(rate: u32) -> Self {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32).cos()))
            .collect();
        Analyzer {
            rate,
            fft,
            window,
            ring: vec![0.0; FFT_SIZE],
            ring_pos: 0,
            spectrum: vec![Complex::new(0.0, 0.0); FFT_SIZE],
            mag_prev: vec![0.0; FFT_SIZE / 2],
            flux_history: VecDeque::with_capacity(FLUX_HISTORY),
            last_beat_ms: 0,
            bins: BandBins::new(rate),
        }
    }

    fn band_power(&self, mags: &[f32], band: &[usize]) -> f32 {
        band.iter().map(|&k| mags[k] * mags[k]).sum()
    }

    fn band_norm(&self, power: f32) -> f32 {
        let full_scale_power = 0.1875 * (FFT_SIZE as f32) * (FFT_SIZE as f32);
        let dbfs = 10.0 * (power / full_scale_power.max(1e-12)).log10();
        norm_dbfs(dbfs)
    }
}

/// Per-hop analysis result, before any mode/FSM involvement.
struct HopResult {
    intensity: f32,
    peak: f32,
    bass: f32,
    mid: f32,
    treble: f32,
    centroid: f32,
    beat: Option<Pulse>,
    pan_stream: Option<Stream>,
    pan_value: f32,
}

/// Analyze one hop of interleaved samples (exactly HOP frames per channel).
fn analyze_hop(analyzer: &mut Analyzer, mono: &[f32], channels: usize, hop_data: &[f32]) -> HopResult {
    let now = monotonic_ms();

    // Rolling mono ring buffer.
    for &s in mono {
        analyzer.ring[analyzer.ring_pos] = s;
        analyzer.ring_pos = (analyzer.ring_pos + 1) % FFT_SIZE;
    }
    let ring_full = analyzer.ring_pos == 0;

    let mut intensity = 0.0f32;
    let mut peak = 0.0f32;
    let mut bass = 0.0f32;
    let mut mid = 0.0f32;
    let mut treble = 0.0f32;
    let mut centroid = 0.0f32;
    let mut beat: Option<Pulse> = None;

    // Time-domain RMS + peak on this hop's mono samples. Computed on EVERY hop
    // (the ring/FFT below only fills every second hop, which would otherwise
    // publish alternating real/zero frames).
    let sum_sq: f32 = mono.iter().map(|s| s * s).sum();
    let rms = (sum_sq / mono.len() as f32).sqrt();
    let peak_val = mono.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    let rms_dbfs = 20.0 * (rms.max(1e-12)).log10();
    let peak_dbfs = 20.0 * (peak_val.max(1e-12)).log10();
    intensity = norm_dbfs(rms_dbfs);
    peak = norm_dbfs(peak_dbfs);

    if ring_full {

        // Windowed FFT.
        let ordered: Vec<f32> = (0..FFT_SIZE)
            .map(|i| analyzer.ring[(analyzer.ring_pos + i) % FFT_SIZE] * analyzer.window[i])
            .collect();
        for (i, s) in ordered.iter().enumerate() {
            analyzer.spectrum[i] = Complex::new(*s, 0.0);
        }
        analyzer.fft.process(&mut analyzer.spectrum);

        let mut mags = vec![0.0f32; FFT_SIZE / 2];
        let mut flux = 0.0f32;
        for k in 0..(FFT_SIZE / 2) {
            mags[k] = analyzer.spectrum[k].norm();
        }

        let bass_power = analyzer.band_power(&mags, &analyzer.bins.bass);
        let mid_power = analyzer.band_power(&mags, &analyzer.bins.mid);
        let treble_power = analyzer.band_power(&mags, &analyzer.bins.treble);
        bass = analyzer.band_norm(bass_power);
        mid = analyzer.band_norm(mid_power);
        treble = analyzer.band_norm(treble_power);

        // Spectral centroid across the analyzed range.
        let mut weighted_sum = 0.0f32;
        let mut mag_sum = 0.0f32;
        for k in 1..(FFT_SIZE / 2) {
            weighted_sum += mags[k] * k as f32;
            mag_sum += mags[k];
        }
        if mag_sum > 1e-9 {
            let centroid_bin = weighted_sum / mag_sum;
            let centroid_hz = centroid_bin * analyzer.rate as f32 / FFT_SIZE as f32;
            centroid = clamp01((centroid_hz - BASS_LO) / (TREBLE_HI - BASS_LO));
        }

        // Spectral flux over bass+mid bands for beat detection.
        for &k in analyzer.bins.bass.iter().chain(analyzer.bins.mid.iter()) {
            flux += (mags[k] - analyzer.mag_prev[k]).max(0.0);
        }
        analyzer.mag_prev = mags;

        analyzer.flux_history.push_back(flux);
        if analyzer.flux_history.len() > FLUX_HISTORY {
            analyzer.flux_history.pop_front();
        }
        if analyzer.flux_history.len() == FLUX_HISTORY {
            let avg: f32 = analyzer.flux_history.iter().sum::<f32>() / FLUX_HISTORY as f32;
            if avg > 1e-9 && flux > 1.5 * avg && (now - analyzer.last_beat_ms) >= BEAT_DEBOUNCE_MS {
                analyzer.last_beat_ms = now;
                beat = Some(Pulse {
                    kind: PulseKind::Beat,
                    strength: clamp01(flux / (2.0 * avg)),
                    timestamp_ms: now,
                });
            }
        }
    }

    // Stereo pan (only meaningful with >= 2 channels).
    let mut pan_value = 0.0f32;
    let mut pan_stream: Option<Stream> = None;
    if channels >= 2 {
        let mut l_sum = 0.0f32;
        let mut r_sum = 0.0f32;
        for pair in hop_data.chunks_exact(channels) {
            l_sum += pair[0] * pair[0];
            r_sum += pair[1] * pair[1];
        }
        let frames = (hop_data.len() / channels).max(1) as f32;
        let l_rms = (l_sum / frames).sqrt();
        let r_rms = (r_sum / frames).sqrt();
        let total = l_rms + r_rms;
        if total > 1e-9 {
            let pan = (r_rms - l_rms) / total; // -1..1
            pan_value = pan;
            if pan.abs() > 0.05 {
                pan_stream = Some(Stream {
                    direction: if pan > 0.0 {
                        StreamDirection::PanRight
                    } else {
                        StreamDirection::PanLeft
                    },
                    strength: pan.abs(),
                });
            }
        }
    }

    HopResult {
        intensity,
        peak,
        bass,
        mid,
        treble,
        centroid,
        beat,
        pan_stream,
        pan_value,
    }
}

/// Resolve the default sink's monitor source name and its sample spec.
/// Never touches the default source (microphone) path.
fn resolve_monitor_source() -> Result<(String, u32, u8), String> {
    let mut mainloop = Mainloop::new().ok_or("mainloop creation failed")?;
    let mut context = Context::new(&mut mainloop, "live-wallpaper-sampler")
        .ok_or("context creation failed")?;
    context
        .connect(None, ContextFlagSet::NOFLAGS, None)
        .map_err(|e| format!("connect: {e}"))?;

    let mut ready = false;
    for _ in 0..500 {
        mainloop.iterate(true);
        match context.get_state() {
            ContextState::Ready => {
                ready = true;
                break;
            }
            ContextState::Failed | ContextState::Terminated => {
                return Err("context failed".into());
            }
            _ => {}
        }
    }
    if !ready {
        return Err("context never became ready".into());
    }

    let sink_cell = Rc::new(RefCell::new(None::<String>));
    let rate_cell = Rc::new(RefCell::new(48000u32));
    let channels_cell = Rc::new(RefCell::new(2u8));
    {
        let sink = sink_cell.clone();
        let rate = rate_cell.clone();
        let ch = channels_cell.clone();
        let _op = context.introspect().get_server_info(move |info| {
            *sink.borrow_mut() = info.default_sink_name.as_ref().map(|n| n.to_string());
            if info.sample_spec.rate > 0 {
                *rate.borrow_mut() = info.sample_spec.rate;
            }
            if info.sample_spec.channels > 0 {
                *ch.borrow_mut() = info.sample_spec.channels;
            }
        });
        for _ in 0..100 {
            mainloop.iterate(true);
            if sink_cell.borrow().is_some() {
                break;
            }
        }
    }

    let monitors_cell = Rc::new(RefCell::new(Vec::<String>::new()));
    {
        let m = monitors_cell.clone();
        let _op = context.introspect().get_source_info_list(move |result| {
            if let ListResult::Item(source) = result {
                if let Some(name) = source.name.as_ref() {
                    if name.ends_with(".monitor") {
                        m.borrow_mut().push(name.to_string());
                    }
                }
            }
        });
        for _ in 0..200 {
            mainloop.iterate(true);
            if !monitors_cell.borrow().is_empty() {
                break;
            }
        }
    }

    drop(context);

    let default_sink = sink_cell.borrow().clone();
    let rate = *rate_cell.borrow();
    let channels = *channels_cell.borrow();
    let monitors = monitors_cell.borrow().clone();

    let preferred = default_sink.map(|s| format!("{s}.monitor"));
    if let Some(pref) = &preferred {
        if monitors.iter().any(|m| m == pref) {
            return Ok((pref.clone(), rate, channels));
        }
    }
    if let Some(first) = monitors.first() {
        return Ok((first.clone(), rate, channels));
    }
    Err("no .monitor source found".into())
}

/// Live capture session over the full libpulse API so we can time out reads
/// and observe connection state (required for PipeWire-restart resilience).
struct CaptureSession {
    mainloop: Mainloop,
    context: Context,
    stream: PulseStream,
}

impl CaptureSession {
    fn connect(source: &str, rate: u32, channels: u8) -> Result<Self, String> {
        let mut mainloop = Mainloop::new().ok_or("mainloop creation failed")?;
        let mut context = Context::new(&mut mainloop, "live-wallpaper-sampler")
            .ok_or("context creation failed")?;
        context
            .connect(None, ContextFlagSet::NOFLAGS, None)
            .map_err(|e| format!("connect: {e}"))?;

        let mut ready = false;
        for _ in 0..500 {
            mainloop.iterate(true);
            match context.get_state() {
                ContextState::Ready => {
                    ready = true;
                    break;
                }
                ContextState::Failed | ContextState::Terminated => {
                    return Err("context failed".into());
                }
                _ => {}
            }
        }
        if !ready {
            return Err("context never became ready".into());
        }

        let spec = SampleSpec {
            format: SampleFormat::F32le,
            channels: channels.max(1),
            rate,
        };
        let mut stream = PulseStream::new(&mut context, "live-wallpaper-monitor", &spec, None)
            .ok_or("stream creation failed")?;
        // Fragment size of exactly one hop so each read yields one 1024-frame
        // chunk and analysis cadence stays at hop rate, not buffer rate.
        let fragsize = (HOP * channels.max(1) as usize * 4) as u32;
        let attr = libpulse_binding::def::BufferAttr {
            maxlength: u32::MAX,
            tlength: u32::MAX,
            prebuf: u32::MAX,
            minreq: u32::MAX,
            fragsize,
        };
        stream
            .connect_record(Some(source), Some(&attr), StreamFlagSet::AUTO_TIMING_UPDATE)
            .map_err(|e| format!("connect_record: {e}"))?;

        let mut stream_ready = false;
        for _ in 0..500 {
            mainloop.iterate(true);
            match stream.get_state() {
                StreamState::Ready => {
                    stream_ready = true;
                    break;
                }
                StreamState::Failed | StreamState::Terminated => {
                    return Err("stream failed".into());
                }
                _ => {}
            }
        }
        if !stream_ready {
            return Err("stream never became ready".into());
        }

        Ok(CaptureSession {
            mainloop,
            context,
            stream,
        })
    }

    /// Read into `buf` (bytes). Returns the number of bytes copied, or Err on
    /// connection death. Never blocks indefinitely: the mainloop is iterated
    /// with small sleeps and connection state is checked each pass.
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, String> {
        loop {
            if self.stream.get_state() == StreamState::Failed
                || self.stream.get_state() == StreamState::Terminated
                || self.context.get_state() == ContextState::Failed
                || self.context.get_state() == ContextState::Terminated
            {
                return Err("connection terminated".into());
            }
            match self.stream.peek() {
                Ok(PeekResult::Data(data)) if !data.is_empty() => {
                    let n = data.len().min(buf.len());
                    buf[..n].copy_from_slice(&data[..n]);
                    self.stream.discard().map_err(|e| format!("discard: {e}"))?;
                    return Ok(n);
                }
                Ok(_) => {
                    self.stream.discard().ok();
                }
                Err(e) => return Err(format!("peek: {e}")),
            }
            self.mainloop.iterate(false);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
}

pub fn detect_and_run(shared: &SharedState, ipc: &IpcServer, verbose: bool) {
    let mut backoff = 1u64;
    loop {
        match resolve_monitor_source() {
            Ok(setup) => {
                backoff = 1;
                run(setup, shared, ipc, verbose);
            }
            Err(e) => {
                eprintln!("[audio] no monitor source: {e}; retrying in {backoff}s");
                std::thread::sleep(std::time::Duration::from_secs(backoff));
                backoff = (backoff * 2).min(10);
            }
        }
    }
}

fn run(setup: (String, u32, u8), shared: &SharedState, ipc: &IpcServer, verbose: bool) {
    let (source, rate, channels) = setup;
    let channels = channels.max(1) as usize;
    let mut analyzer = Analyzer::new(rate);
    let mut fsm = ModeFsm::new();
    let mut fsm_input_history: VecDeque<f32> = VecDeque::with_capacity(16);
    let mut pending: Vec<f32> = Vec::new(); // partial-hop remainder across reads
    let chunk_len = 65536; // generous: copy ALL peeked data, split into hops in pending
    let mut raw = vec![0u8; chunk_len];
    let mut last_data = monotonic_ms();

    if verbose {
        eprintln!(
            "[audio] capturing from source '{source}' @ {} Hz, {} ch",
            rate, channels
        );
    }

    loop {
        let mut session = match CaptureSession::connect(&source, rate, channels as u8) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[audio] capture connect failed: {e}; retrying in 2s");
                std::thread::sleep(std::time::Duration::from_secs(2));
                continue;
            }
        };
        // Drop the capture on error or on >5s of silence (stale stream).
        'session: loop {
            let bytes = match session.read(&mut raw) {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("[audio] capture stream died: {e}; reconnecting");
                    break 'session;
                }
            };
            if bytes == 0 {
                if monotonic_ms().saturating_sub(last_data) > 5000 {
                    eprintln!("[audio] no data for 5s; reconnecting");
                    break 'session;
                }
                continue;
            }
            last_data = monotonic_ms();

            let samples: Vec<f32> = raw[..bytes]
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            pending.extend(samples);

            // Split the read into exact HOP-frame hops; keep the remainder.
            while pending.len() >= HOP * channels {
                let hop: Vec<f32> = pending.drain(..HOP * channels).collect();
                let mut mono = vec![0.0f32; HOP];
                for (i, frame) in hop.chunks_exact(channels).enumerate() {
                    let sum: f32 = frame.iter().sum();
                    mono[i] = sum / channels as f32;
                }
                let res = analyze_hop(&mut analyzer, &mono, channels, &hop);

                // Smooth the intensity fed to the FSM so normal music gaps
                // don't reset the transition timer.
                fsm_input_history.push_back(res.intensity);
                if fsm_input_history.len() > 16 {
                    fsm_input_history.pop_front();
                }
                let smooth: f32 =
                    fsm_input_history.iter().sum::<f32>() / fsm_input_history.len() as f32;
                let mode = fsm.update(smooth);
                *shared.mode.lock().unwrap() = mode;

                let mut pulses = Vec::new();
                if let Some(beat) = res.beat {
                    if mode == Mode::Music {
                        pulses.push(beat);
                    }
                }
                let mut streams = Vec::new();
                if let Some(pan) = res.pan_stream {
                    streams.push(pan);
                }

                let audio = AudioMetrics {
                    active: mode == Mode::Music,
                    rms: res.intensity,
                    peak: res.peak,
                    bass: res.bass,
                    mid: res.mid,
                    treble: res.treble,
                    centroid: res.centroid,
                    beat: !pulses.is_empty(),
                    pan: res.pan_value,
                };
                *shared.audio.lock().unwrap() = audio.clone();

                let mut state = SceneState::new(mode, crate::scene_state::Source::Audio);
                state.intensity = res.intensity;
                state.population = res.mid;
                state.heat = res.centroid;
                state.spawn_rate = res.treble;
                state.gravity_bias = res.bass;
                state.pulses = pulses;
                state.streams = streams;
                state.audio = audio;
                state.system = shared.system.lock().unwrap().clone();

                if let Ok(json) = serde_json::to_string(&state) {
                    ipc.publish(&json);
                }
            }

            if verbose && monotonic_ms() % 5000 < 25 {
                let a = shared.audio.lock().unwrap();
                let m = *shared.mode.lock().unwrap();
                eprintln!(
                    "[audio] mode={:?} rms={:.2} bass={:.2} mid={:.2} treble={:.2} centroid={:.2} beat={} pan={:+.2}",
                    m, a.rms, a.bass, a.mid, a.treble, a.centroid, a.beat, a.pan
                );
            }
        }
    }
}
