use crate::scene_state::Mode;
use std::time::{Duration, Instant};

/// Mode FSM with hysteresis, per contract §8:
/// - System -> Music: audio intensity stays > 0.15 for >= 400ms
/// - Music -> System: audio intensity stays < 0.05 for >= 3000ms
/// The FSM lives in the sampler; the renderer just reads the `mode` field.
pub struct ModeFsm {
    mode: Mode,
    above_since: Option<Instant>,
    below_since: Option<Instant>,
}

impl Default for ModeFsm {
    fn default() -> Self {
        Self::new()
    }
}

impl ModeFsm {
    pub fn new() -> Self {
        ModeFsm {
            mode: Mode::System,
            above_since: None,
            below_since: None,
        }
    }

    pub fn update(&mut self, audio_intensity: f32) -> Mode {
        if audio_intensity > 0.15 {
            self.below_since = None;
            let since = *self.above_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_millis(400) {
                self.mode = Mode::Music;
            }
        } else if audio_intensity < 0.05 {
            self.above_since = None;
            let since = *self.below_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_millis(3000) {
                self.mode = Mode::System;
            }
        } else {
            self.above_since = None;
            self.below_since = None;
        }
        self.mode
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assert the mode stays `expect` for the whole phase (phase must not
    /// cross a transition boundary).
    fn expect_stable(fsm: &mut ModeFsm, intensity: f32, ms: u64, expect: Mode) {
        let mut elapsed = 0u64;
        while elapsed < ms {
            assert_eq!(
                fsm.update(intensity),
                expect,
                "after {elapsed}ms at {intensity}"
            );
            std::thread::sleep(Duration::from_millis(20));
            elapsed += 20;
        }
    }

    /// Assert the mode becomes `expect` at some point within the phase.
    fn expect_eventual(fsm: &mut ModeFsm, intensity: f32, ms: u64, expect: Mode) {
        let mut elapsed = 0u64;
        let mut seen = false;
        while elapsed < ms {
            if fsm.update(intensity) == expect {
                seen = true;
            }
            std::thread::sleep(Duration::from_millis(20));
            elapsed += 20;
        }
        assert!(seen, "never became {expect:?} within {ms}ms at {intensity}");
    }

    #[test]
    fn enters_music_after_400ms_above_threshold() {
        let mut fsm = ModeFsm::new();
        expect_stable(&mut fsm, 0.3, 300, Mode::System); // 300ms: below threshold
        expect_eventual(&mut fsm, 0.3, 600, Mode::Music); // crosses at 400ms
    }

    #[test]
    fn resets_timer_when_intensity_dips() {
        let mut fsm = ModeFsm::new();
        expect_stable(&mut fsm, 0.3, 300, Mode::System);
        expect_stable(&mut fsm, 0.03, 60, Mode::System); // dip resets the timer
        expect_stable(&mut fsm, 0.3, 300, Mode::System); // 300ms after dip
        expect_eventual(&mut fsm, 0.3, 600, Mode::Music); // crosses at 400ms after dip
    }

    #[test]
    fn returns_to_system_after_3000ms_below_threshold() {
        let mut fsm = ModeFsm::new();
        expect_stable(&mut fsm, 0.5, 300, Mode::System);
        expect_eventual(&mut fsm, 0.5, 600, Mode::Music); // force Music
        assert_eq!(fsm.mode, Mode::Music);
        expect_stable(&mut fsm, 0.01, 2500, Mode::Music); // 2.5s of quiet: linger
        expect_eventual(&mut fsm, 0.01, 800, Mode::System); // crosses at 3s of quiet
    }
}