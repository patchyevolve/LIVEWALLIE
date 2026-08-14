mod audio;
mod fsm;
mod ipc;
mod scene_state;
mod telemetry;

use audio::{detect_and_run, SharedState};
use scene_state::Source;
use std::sync::Arc;
use std::time::Duration;

fn main() {
    let verbose = std::env::var("LW_VERBOSE").map(|v| v == "1" || v == "true").unwrap_or(false);
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());

    // Single instance: flock the runtime dir so a duplicate (e.g. a stale
    // extension respawn) exits immediately instead of fighting over the socket.
    let _lock = match single_instance_lock(&runtime_dir) {
        Some(l) => l,
        None => {
            eprintln!("[sampler] another instance is running; exiting");
            std::process::exit(0);
        }
    };

    let ipc = Arc::new(
        ipc::IpcServer::new(&runtime_dir).expect("failed to create IPC socket server"),
    );
    let shared = Arc::new(SharedState::default());

    let mut telemetry = telemetry::Telemetry::new();
    eprintln!(
        "[sampler] started (protocol v{}, socket {})",
        scene_state::PROTOCOL_VERSION,
        ipc.socket_path().display()
    );
    match telemetry.temp_source() {
        Some(p) => eprintln!("[sampler] hwmon temp: {}", p.display()),
        None => eprintln!("[sampler] hwmon temp: NOT FOUND (heat will be 0.0)"),
    }
    match telemetry.gpu_source() {
        Some(p) => eprintln!("[sampler] amdgpu busy: {}", p.display()),
        None => eprintln!("[sampler] amdgpu busy: NOT FOUND (gpu = null)"),
    }
    match telemetry.battery_source() {
        Some(p) => eprintln!("[sampler] battery: {}", p.display()),
        None => eprintln!("[sampler] battery: not present"),
    }

    let tel_shared = shared.clone();
    let tel_ipc = ipc.clone();
    std::thread::spawn(move || {
        telemetry_loop(&mut telemetry, &tel_shared, &tel_ipc, verbose);
    });

    let aud_shared = shared.clone();
    let aud_ipc = ipc.clone();
    std::thread::spawn(move || {
        detect_and_run(&aud_shared, &aud_ipc, verbose);
    });

    ctrlc::set_handler(move || {
        ipc.shutdown();
        std::process::exit(0);
    })
    .expect("failed to install Ctrl-C handler");

    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

fn single_instance_lock(runtime_dir: &str) -> Option<std::fs::File> {
    let dir = std::path::Path::new(runtime_dir).join("live-wallpaper");
    std::fs::create_dir_all(&dir).ok()?;
    let lock_path = dir.join("lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .ok()?;
    // SAFETY: flock takes a raw fd; the file stays alive for the process lifetime.
    let rc = unsafe {
        libc::flock(std::os::fd::AsRawFd::as_raw_fd(&file), libc::LOCK_EX | libc::LOCK_NB)
    };
    if rc != 0 {
        return None;
    }
    Some(file)
}

fn telemetry_loop(
    telemetry: &mut telemetry::Telemetry,
    shared: &SharedState,
    ipc: &ipc::IpcServer,
    verbose: bool,
) {
    let mut battery_log_counter = 0u32;
    loop {
        std::thread::sleep(Duration::from_millis(300));

        let snap = telemetry.poll();
        let m = &snap.metrics;

        *shared.system.lock().unwrap() = m.clone();
        let mode = *shared.mode.lock().unwrap();
        let audio = shared.audio.lock().unwrap().clone();

        let mut state = scene_state::SceneState::new(mode, Source::Telemetry);
        state.intensity = scene_state::clamp01(0.6 * m.cpu + 0.4 * m.memory);
        state.population = m.memory;
        state.heat = m.temperature;
        state.spawn_rate = m.process_churn;
        state.gravity_bias = 0.0;
        state.pulses = snap.disk_pulses;
        // Streams are audio pan only (design decision): network rx/tx drift
        // was an arbitrary metaphor; pan belongs to what the user hears.
        state.streams = vec![];
        state.system = m.clone();
        state.audio = audio;

        if let Ok(json) = serde_json::to_string(&state) {
            ipc.publish(&json);
        }

        battery_log_counter += 1;
        if verbose || battery_log_counter >= 10 {
            battery_log_counter = 0;
            let batt = m.battery.map(|b| format!("{:.0}%", b * 100.0)).unwrap_or_else(|| "n/a".into());
            if verbose {
                eprintln!(
                    "[telemetry] cpu={:.2} ram={:.2} temp={:.2} gpu={} churn={:.2} rx={:.2} tx={:.2} batt={} mode={:?}",
                    m.cpu, m.memory, m.temperature,
                    m.gpu.map(|g| format!("{:.2}", g)).unwrap_or_else(|| "n/a".into()),
                    m.process_churn, m.network_rx, m.network_tx, batt, mode
                );
            } else {
                eprintln!("[telemetry] batt={} mode={:?}", batt, mode);
            }
        }
    }
}