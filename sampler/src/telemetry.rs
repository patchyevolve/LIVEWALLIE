use crate::scene_state::{clamp01, monotonic_ms, Pulse, PulseKind, Stream, StreamDirection, SystemMetrics};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

const DISK_PULSE_THRESHOLD_SECTORS: u64 = 512;
const DISK_PULSE_STRENGTH_DIVISOR: f64 = 8192.0;
const NET_STRENGTH_DIVISOR: f64 = 5_000_000.0;
const CHURN_DIVISOR: f64 = 20.0;

/// Raw telemetry values for one poll window (not yet normalized to the
/// derived fields — the raw numbers ride on the message for reuse).
pub struct TelemetrySnapshot {
    pub metrics: SystemMetrics,
    pub disk_pulses: Vec<Pulse>,
    pub streams: Vec<Stream>,
}

pub struct Telemetry {
    sys: sysinfo::System,
    disk_last: HashMap<String, (u64, u64)>,
    net_last: HashMap<String, (u64, u64)>,
    pids: HashSet<i32>,
    temp_path: Option<PathBuf>,
    gpu_path: Option<PathBuf>,
    battery_path: Option<PathBuf>,
}

fn find_hwmon_temp() -> Option<PathBuf> {
    let entries = fs::read_dir("/sys/class/hwmon").ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        let labels = fs::read_dir(&dir).ok()?;
        for label in labels.flatten() {
            let lp = label.path();
            let name = lp.file_name()?.to_string_lossy().to_string();
            if let Some(rest) = name.strip_prefix("temp") {
                if let Some(num) = rest.strip_suffix("_label") {
                    if let Ok(value) = fs::read_to_string(&lp) {
                        let v = value.trim().to_ascii_lowercase();
                        if v == "tctl" || v == "tdie" {
                            return Some(dir.join(format!("temp{}_input", num)));
                        }
                    }
                }
            }
        }
    }
    None
}

fn find_amdgpu_busy() -> Option<PathBuf> {
    let cards = fs::read_dir("/sys/class/drm").ok()?;
    for card in cards.flatten() {
        let path = card.path();
        if !path.file_name()?.to_string_lossy().starts_with("card") {
            continue;
        }
        let vendor = fs::read_to_string(path.join("device/vendor")).ok();
        if vendor.as_deref().map(|v| v.trim() == "0x1002").unwrap_or(false) {
            let busy = path.join("device/gpu_busy_percent");
            if busy.exists() {
                return Some(busy);
            }
        }
    }
    None
}

fn find_battery() -> Option<PathBuf> {
    let entries = fs::read_dir("/sys/class/power_supply").ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name()?.to_string_lossy().to_string();
        if name.starts_with("BAT") && path.join("capacity").exists() {
            return Some(path.join("capacity"));
        }
    }
    None
}

fn read_diskstats() -> HashMap<String, (u64, u64)> {
    let mut out = HashMap::new();
    let Ok(text) = fs::read_to_string("/proc/diskstats") else {
        return out;
    };
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 11 {
            continue;
        }
        // 1-based fields 6 and 10 (0-based 5 and 9): sectors read / sectors written.
        let read: u64 = fields[5].parse().unwrap_or(0);
        let written: u64 = fields[9].parse().unwrap_or(0);
        out.insert(fields[2].to_string(), (read, written));
    }
    out
}

fn read_netdev() -> HashMap<String, (u64, u64)> {
    let mut out = HashMap::new();
    let Ok(text) = fs::read_to_string("/proc/net/dev") else {
        return out;
    };
    for line in text.lines().skip(2) {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        if fields.len() < 9 {
            continue;
        }
        let rx: u64 = fields[0].parse().unwrap_or(0);
        let tx: u64 = fields[8].parse().unwrap_or(0);
        out.insert(name.trim().to_string(), (rx, tx));
    }
    out
}

fn read_pids() -> HashSet<i32> {
    let mut out = HashSet::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Ok(pid) = name.parse::<i32>() {
            out.insert(pid);
        }
    }
    out
}

impl Telemetry {
    pub fn new() -> Self {
        Telemetry {
            sys: sysinfo::System::new(),
            disk_last: HashMap::new(),
            net_last: HashMap::new(),
            pids: read_pids(),
            temp_path: find_hwmon_temp(),
            gpu_path: find_amdgpu_busy(),
            battery_path: find_battery(),
        }
    }

    pub fn temp_source(&self) -> Option<&PathBuf> {
        self.temp_path.as_ref()
    }
    pub fn gpu_source(&self) -> Option<&PathBuf> {
        self.gpu_path.as_ref()
    }
    pub fn battery_source(&self) -> Option<&PathBuf> {
        self.battery_path.as_ref()
    }

    pub fn poll(&mut self) -> TelemetrySnapshot {
        let now = monotonic_ms();

        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        let cpu = clamp01(self.sys.global_cpu_usage() / 100.0);
        let memory = clamp01(
            self.sys.used_memory() as f32 / self.sys.total_memory().max(1) as f32,
        );

        let disk_now = read_diskstats();
        let mut disk_pulses = Vec::new();
        for (dev, (read, written)) in &disk_now {
            if let Some(&(prev_read, prev_written)) = self.disk_last.get(dev) {
                let delta = (read.saturating_sub(prev_read)) + (written.saturating_sub(prev_written));
                if delta >= DISK_PULSE_THRESHOLD_SECTORS {
                    disk_pulses.push(Pulse {
                        kind: PulseKind::DiskIo,
                        strength: clamp01((delta as f64 / DISK_PULSE_STRENGTH_DIVISOR) as f32),
                        timestamp_ms: now,
                    });
                }
            }
        }
        self.disk_last = disk_now;

        let net_now = read_netdev();
        let mut rx_delta = 0u64;
        let mut tx_delta = 0u64;
        for (iface, (rx, tx)) in &net_now {
            if let Some(&(prev_rx, prev_tx)) = self.net_last.get(iface) {
                rx_delta += rx.saturating_sub(prev_rx);
                tx_delta += tx.saturating_sub(prev_tx);
            }
        }
        self.net_last = net_now;
        let mut streams = Vec::new();
        streams.push(Stream {
            direction: StreamDirection::Rx,
            strength: clamp01((rx_delta as f64 / NET_STRENGTH_DIVISOR) as f32),
        });
        streams.push(Stream {
            direction: StreamDirection::Tx,
            strength: clamp01((tx_delta as f64 / NET_STRENGTH_DIVISOR) as f32),
        });

        let temperature = match &self.temp_path {
            Some(path) => {
                let millideg = fs::read_to_string(path)
                    .ok()
                    .and_then(|s| s.trim().parse::<f32>().ok());
                match millideg {
                    Some(md) => {
                        let c = md / 1000.0;
                        clamp01((c - 30.0) / 70.0)
                    }
                    None => 0.0,
                }
            }
            None => 0.0,
        };

        let gpu = self
            .gpu_path
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| s.trim().parse::<f32>().ok())
            .map(clamp01);

        let battery = self
            .battery_path
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| s.trim().parse::<f32>().ok())
            .map(|v| clamp01(v / 100.0));

        let pids_now = read_pids();
        let spawned = pids_now.difference(&self.pids).count();
        let died = self.pids.difference(&pids_now).count();
        self.pids = pids_now;
        let process_churn = clamp01(((spawned + died) as f64 / CHURN_DIVISOR) as f32);

        let metrics = SystemMetrics {
            cpu,
            memory,
            disk_io: clamp01(
                (disk_pulses.iter().map(|p| p.strength as f64).sum::<f64>() / 2.0) as f32,
            ),
            network_rx: streams[0].strength,
            network_tx: streams[1].strength,
            temperature,
            gpu,
            battery,
            process_churn,
        };

        TelemetrySnapshot {
            metrics,
            disk_pulses,
            streams,
        }
    }
}