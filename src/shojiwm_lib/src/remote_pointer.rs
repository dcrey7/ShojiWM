//! Remote pointer: phone (EIS) input gets an acceleration curve and its own
//! cursor look, so you can see when the phone drives.
//!
//! LOCAL is any real mouse or touchpad. REMOTE starts on any EIS pointer
//! event and ends on a local pointer event or after `IDLE` with no EIS input.

use std::time::{Duration, Instant};

pub const IDLE: Duration = Duration::from_secs(3);
pub const FADE: Duration = Duration::from_millis(150);
/// A longer pause between two EIS motions starts a new stroke at gain 1.
const STROKE_GAP: Duration = Duration::from_millis(100);
/// px/ms: at or below this, motion stays 1:1.
const SLOW: f64 = 0.3;
/// px/ms: at or above this, motion gets `MAX_GAIN`.
const FAST: f64 = 2.5;
const MAX_GAIN: f64 = 4.0;

/// Pointer gain for an input speed in px/ms: 1 when slow, rising linearly to
/// `MAX_GAIN` when fast. Slow drags stay precise; a flick crosses the screen.
pub fn remote_gain(speed_px_per_ms: f64) -> f64 {
    if speed_px_per_ms <= SLOW {
        return 1.0;
    }
    if speed_px_per_ms >= FAST {
        return MAX_GAIN;
    }
    1.0 + (MAX_GAIN - 1.0) * (speed_px_per_ms - SLOW) / (FAST - SLOW)
}

/// How the remote cursor looks and moves. Built from the config's `remote`.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteCursorStyle {
    pub speed: f64,
    pub scale: f64,
    /// RGB of the ring; `None` when the config says `ring: "none"`.
    pub ring: Option<[u8; 3]>,
}

impl Default for RemoteCursorStyle {
    fn default() -> Self {
        Self {
            speed: 1.0,
            scale: 1.5,
            ring: Some([0x3d, 0xae, 0xe9]),
        }
    }
}

#[derive(Debug, Default)]
pub struct RemotePointer {
    pub style: RemoteCursorStyle,
    last_remote: Option<Instant>,
    last_motion: Option<Instant>,
    fade_in_at: Option<Instant>,
    /// Set when a local event ends REMOTE early; the idle timeout uses its
    /// own deadline instead.
    fade_out_at: Option<Instant>,
}

impl RemotePointer {
    /// Scale one EIS relative delta by the stroke speed and `style.speed`.
    pub fn note_remote_motion(&mut self, delta: (f64, f64), now: Instant) -> (f64, f64) {
        let gain = match self.last_motion {
            Some(prev) if now.duration_since(prev) <= STROKE_GAP => {
                let ms = now.duration_since(prev).as_secs_f64() * 1000.0;
                let distance = (delta.0 * delta.0 + delta.1 * delta.1).sqrt();
                remote_gain(distance / ms.max(1.0))
            }
            _ => 1.0,
        };
        self.last_motion = Some(now);
        self.note_remote_activity(now);
        let k = gain * self.style.speed;
        (delta.0 * k, delta.1 * k)
    }

    /// Any EIS pointer event: motion, absolute motion, button, scroll.
    pub fn note_remote_activity(&mut self, now: Instant) {
        if !self.is_remote(now) {
            self.fade_in_at = Some(now);
            self.fade_out_at = None;
        }
        self.last_remote = Some(now);
    }

    /// Any pointer event from a real device ends REMOTE at once.
    pub fn note_local_activity(&mut self, now: Instant) {
        if self.is_remote(now) {
            self.fade_out_at = Some(now);
        }
        self.last_remote = None;
        self.last_motion = None;
    }

    pub fn is_remote(&self, now: Instant) -> bool {
        self.last_remote
            .is_some_and(|t| now.duration_since(t) < IDLE)
    }

    /// When REMOTE expires on its own, if it is active.
    pub fn idle_deadline(&self) -> Option<Instant> {
        self.last_remote.map(|t| t + IDLE)
    }

    /// Ring opacity, 0..=1, with the 150 ms fade in and out.
    pub fn ring_alpha(&self, now: Instant) -> f32 {
        let ramp = |since: Instant| {
            (now.saturating_duration_since(since).as_secs_f32() / FADE.as_secs_f32()).clamp(0.0, 1.0)
        };
        if self.is_remote(now) {
            return self.fade_in_at.map_or(1.0, ramp);
        }
        match self.fade_out_at.or_else(|| self.idle_deadline()) {
            Some(start) if now >= start => 1.0 - ramp(start),
            _ => 0.0,
        }
    }

    /// True while a fade runs, so the renderer keeps scheduling frames.
    pub fn animating(&self, now: Instant) -> bool {
        let alpha = self.ring_alpha(now);
        alpha > 0.0 && alpha < 1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn gain_is_one_when_slow_and_four_when_fast() {
        assert_eq!(remote_gain(0.0), 1.0);
        assert_eq!(remote_gain(0.3), 1.0);
        assert!((remote_gain(1.4) - 2.5).abs() < 1e-9);
        assert_eq!(remote_gain(2.5), 4.0);
        assert_eq!(remote_gain(50.0), 4.0);
    }

    #[test]
    fn first_motion_of_a_stroke_is_one_to_one() {
        let mut rp = RemotePointer::default();
        let t = Instant::now();
        assert_eq!(rp.note_remote_motion((30.0, 0.0), t), (30.0, 0.0));
        // 150 ms later counts as a new stroke too.
        assert_eq!(
            rp.note_remote_motion((30.0, 0.0), t + Duration::from_millis(150)),
            (30.0, 0.0)
        );
    }

    #[test]
    fn fast_motion_is_accelerated_slow_motion_is_not() {
        let mut rp = RemotePointer::default();
        let t = Instant::now();
        rp.note_remote_motion((1.0, 0.0), t);
        // 2 px in 10 ms = 0.2 px/ms: 1:1.
        assert_eq!(
            rp.note_remote_motion((2.0, 0.0), t + Duration::from_millis(10)),
            (2.0, 0.0)
        );
        // 40 px in 10 ms = 4 px/ms: x4.
        let (dx, _) = rp.note_remote_motion((40.0, 0.0), t + Duration::from_millis(20));
        assert!((dx - 160.0).abs() < 1e-6);
    }

    #[test]
    fn speed_setting_multiplies_the_result() {
        let mut rp = RemotePointer::default();
        rp.style.speed = 2.0;
        let t = Instant::now();
        assert_eq!(rp.note_remote_motion((10.0, 5.0), t), (20.0, 10.0));
    }

    #[test]
    fn mode_switches_and_expires() {
        let mut rp = RemotePointer::default();
        let t = Instant::now();
        assert!(!rp.is_remote(t));
        rp.note_remote_activity(t);
        assert!(rp.is_remote(t + Duration::from_millis(2900)));
        assert!(!rp.is_remote(t + Duration::from_millis(3100)));
        rp.note_remote_activity(t);
        rp.note_local_activity(t + Duration::from_millis(10));
        assert!(!rp.is_remote(t + Duration::from_millis(11)));
    }

    #[test]
    fn ring_fades_in_and_out_over_150ms() {
        let mut rp = RemotePointer::default();
        let t = Instant::now();
        rp.note_remote_activity(t);
        assert_eq!(rp.ring_alpha(t), 0.0);
        assert!((rp.ring_alpha(t + Duration::from_millis(75)) - 0.5).abs() < 0.01);
        assert_eq!(rp.ring_alpha(t + Duration::from_millis(200)), 1.0);
        assert!(rp.animating(t + Duration::from_millis(75)));
        assert!(!rp.animating(t + Duration::from_millis(200)));
        let off = t + Duration::from_millis(500);
        rp.note_local_activity(off);
        assert!((rp.ring_alpha(off + Duration::from_millis(75)) - 0.5).abs() < 0.01);
        assert_eq!(rp.ring_alpha(off + Duration::from_millis(200)), 0.0);
    }
}
