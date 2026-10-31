//! Remote pointer: phone (EIS) input gets an acceleration curve and its own
//! cursor look, so you can see when the phone drives.
//!
//! LOCAL is any real mouse or touchpad. REMOTE starts on any EIS pointer
//! event and ends on a local pointer event or after `IDLE` with no EIS input.

use std::time::{Duration, Instant};

use xcursor::parser::Image;

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

impl RemoteCursorStyle {
    /// Fill missing fields with the defaults; out-of-range values fall back
    /// to the default too, so a typo never breaks the cursor.
    pub fn from_config(config: Option<&crate::cursor::RuntimeRemoteCursorConfig>) -> Self {
        let defaults = Self::default();
        let Some(config) = config else {
            return defaults;
        };
        let speed = config
            .speed
            .filter(|s| s.is_finite() && *s > 0.0 && *s <= 10.0)
            .unwrap_or(defaults.speed);
        let scale = config
            .scale
            .filter(|s| s.is_finite() && *s >= 1.0 && *s <= 4.0)
            .unwrap_or(defaults.scale);
        let ring = match config.ring.as_deref() {
            None => defaults.ring,
            Some("none") => None,
            Some(hex) => parse_hex_rgb(hex).or(defaults.ring),
        };
        Self { speed, scale, ring }
    }
}

/// "#rrggbb" to RGB bytes.
fn parse_hex_rgb(text: &str) -> Option<[u8; 3]> {
    let hex = text.strip_prefix('#')?;
    if hex.len() != 6 || !hex.is_ascii() {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

#[derive(Debug, Default)]
pub struct RemotePointer {
    pub style: RemoteCursorStyle,
    /// Last baked image: (base arrow, fade step, ring colour) -> composed.
    /// The arrow is rarely animated, so this saves re-baking every frame.
    composed: Option<(Image, u8, Option<[u8; 3]>, Image)>,
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

    /// The remote cursor image for `base` at ring opacity `alpha`. Alpha is
    /// quantised to 8 steps so a fade bakes at most 8 images.
    pub fn remote_frame(&mut self, base: Image, alpha: f32) -> Image {
        let step = (alpha.clamp(0.0, 1.0) * 8.0).round() as u8;
        let ring = self.style.ring;
        if let Some((cached_base, cached_step, cached_ring, image)) = &self.composed
            && *cached_step == step
            && *cached_ring == ring
            && *cached_base == base
        {
            return image.clone();
        }
        let image = compose_remote_cursor(&base, ring, step as f32 / 8.0);
        self.composed = Some((base, step, ring, image.clone()));
        image
    }

    /// True while a fade runs, so the renderer keeps scheduling frames.
    pub fn animating(&self, now: Instant) -> bool {
        let alpha = self.ring_alpha(now);
        alpha > 0.0 && alpha < 1.0
    }
}

const RING_ALPHA: f32 = 0.85;
const RING_STROKE: f32 = 2.0;
const RING_GLOW: f32 = 6.0;

/// Ring radius in image pixels for a cursor image of nominal `size`.
pub fn ring_radius(size: u32) -> u32 {
    ((size as f32) * 0.75).round() as u32
}

/// Centre of the visible (non-transparent) part of `image`, so the ring
/// frames the whole arrow instead of only its tip.
fn visible_centre(image: &Image) -> (f32, f32) {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
    for y in 0..image.height {
        for x in 0..image.width {
            if image.pixels_rgba[((y * image.width + x) * 4 + 3) as usize] > 0 {
                (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
            }
        }
    }
    if x0 > x1 {
        return (image.xhot as f32 + 0.5, image.yhot as f32 + 0.5);
    }
    ((x0 + x1 + 1) as f32 / 2.0, (y0 + y1 + 1) as f32 / 2.0)
}

/// A copy of `base` on a larger canvas with a soft ring around the arrow,
/// drawn under it. It is one image on purpose: the hardware
/// cursor plane holds one buffer, so the arrow and the ring move together.
///
/// Pixels are premultiplied, in the byte order the cursor buffer uses
/// (`Fourcc::Argb8888` little-endian: B, G, R, A).
pub fn compose_remote_cursor(base: &Image, ring: Option<[u8; 3]>, alpha: f32) -> Image {
    let Some([r, g, b]) = ring else {
        return base.clone();
    };
    let alpha = alpha.clamp(0.0, 1.0);
    if alpha <= 0.0 {
        return base.clone();
    }
    let radius = ring_radius(base.size) as f32;
    let reach = radius + RING_STROKE + RING_GLOW;
    let (ax, ay) = visible_centre(base);
    // The canvas covers both the base image and the ring around the arrow.
    let left = (reach - ax).ceil().max(0.0) as u32;
    let top = (reach - ay).ceil().max(0.0) as u32;
    let width = left + base.width.max((ax + reach).ceil() as u32);
    let height = top + base.height.max((ay + reach).ceil() as u32);
    let mut px = vec![0u8; (width * height * 4) as usize];
    let (cx, cy) = (ax + left as f32, ay + top as f32);

    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let off = ((dx * dx + dy * dy).sqrt() - radius).abs();
            // A solid stroke with a 1 px anti-aliased edge, plus a soft glow
            // falling off to zero.
            let half = RING_STROKE / 2.0;
            let stroke = (half + 0.5 - off).clamp(0.0, 1.0);
            let glow = (1.0 - (off - half) / RING_GLOW).clamp(0.0, 1.0).powi(2) * 0.6;
            let cover = stroke.max(glow);
            let a = cover * RING_ALPHA * alpha;
            if a <= 0.0 {
                continue;
            }
            let i = ((y * width + x) * 4) as usize;
            px[i] = (b as f32 * a).round() as u8;
            px[i + 1] = (g as f32 * a).round() as u8;
            px[i + 2] = (r as f32 * a).round() as u8;
            px[i + 3] = (255.0 * a).round() as u8;
        }
    }

    // The arrow over the ring (premultiplied "over").
    for y in 0..base.height {
        for x in 0..base.width {
            let s = ((y * base.width + x) * 4) as usize;
            let src = &base.pixels_rgba[s..s + 4];
            let src_alpha = src[3] as f32 / 255.0;
            if src_alpha == 0.0 {
                continue;
            }
            let d = (((y + top) * width + x + left) * 4) as usize;
            for k in 0..4 {
                let blended = src[k] as f32 + px[d + k] as f32 * (1.0 - src_alpha);
                px[d + k] = blended.round().min(255.0) as u8;
            }
        }
    }

    Image {
        size: base.size,
        width,
        height,
        xhot: base.xhot + left,
        yhot: base.yhot + top,
        delay: base.delay,
        pixels_rgba: px,
        pixels_argb: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn composed_cursor_keeps_the_arrow_and_adds_a_ring_around_the_hotspot() {
        let w = 8u32;
        let mut px = vec![0u8; (w * w * 4) as usize];
        px[0..4].copy_from_slice(&[255, 255, 255, 255]); // opaque hotspot pixel at (0,0)
        let base = Image {
            size: 8,
            width: w,
            height: w,
            xhot: 0,
            yhot: 0,
            delay: 0,
            pixels_rgba: px,
            pixels_argb: vec![],
        };
        let out = compose_remote_cursor(&base, Some([0x3d, 0xae, 0xe9]), 1.0);
        assert!(out.width > base.width && out.height > base.height);
        let at = |x: u32, y: u32| {
            let i = ((y * out.width + x) * 4) as usize;
            out.pixels_rgba[i..i + 4].to_vec()
        };
        // The hotspot moves with the padding; the arrow pixel stays opaque white.
        assert_eq!(at(out.xhot, out.yhot), vec![255, 255, 255, 255]);
        // A pixel on the ring radius is ring-coloured (B, G, R order, premultiplied).
        let ring = at(out.xhot + ring_radius(base.size), out.yhot);
        assert!(ring[3] > 150, "ring alpha {}", ring[3]);
        assert!(ring[0] > ring[2], "blue channel should beat red for #3daee9");
        // Far from the ring (in a corner), the canvas is transparent.
        assert_eq!(at(0, 0)[3], 0);
        // No ring, or alpha 0: the base image comes back unchanged.
        assert_eq!(compose_remote_cursor(&base, None, 1.0), base);
        assert_eq!(compose_remote_cursor(&base, Some([1, 2, 3]), 0.0), base);
    }

    #[test]
    fn style_from_config_fills_defaults_and_parses_colours() {
        use crate::cursor::RuntimeRemoteCursorConfig as C;
        assert_eq!(RemoteCursorStyle::from_config(None), RemoteCursorStyle::default());
        let c = C { speed: Some(2.0), scale: None, ring: Some("#ff0080".into()) };
        let s = RemoteCursorStyle::from_config(Some(&c));
        assert_eq!((s.speed, s.scale, s.ring), (2.0, 1.5, Some([0xff, 0x00, 0x80])));
        let none = C { speed: None, scale: Some(1.0), ring: Some("none".into()) };
        assert_eq!(RemoteCursorStyle::from_config(Some(&none)).ring, None);
        // Bad values fall back instead of breaking the cursor.
        let bad = C { speed: Some(-1.0), scale: Some(99.0), ring: Some("blue".into()) };
        let s = RemoteCursorStyle::from_config(Some(&bad));
        assert_eq!((s.speed, s.scale, s.ring), (1.0, 1.5, Some([0x3d, 0xae, 0xe9])));
    }

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

/// Writes the baked remote cursor (real theme) as raw BGRA for a visual check:
/// `SHOJI_REMOTE_CURSOR_DUMP=/tmp/x.bgra cargo test -p shojiwm_lib dump_remote_cursor -- --ignored`
#[cfg(test)]
mod visual {
    #[test]
    #[ignore = "writes an image for a human to look at"]
    fn dump_remote_cursor() {
        let Ok(path) = std::env::var("SHOJI_REMOTE_CURSOR_DUMP") else {
            return;
        };
        let mut cursor = crate::cursor::Cursor::from_config("breeze_cursors".into(), 24);
        let base = cursor.get_image_sized(
            smithay::input::pointer::CursorIcon::Default,
            36,
            std::time::Duration::ZERO,
        );
        let style = super::RemoteCursorStyle::default();
        let image = super::compose_remote_cursor(&base, style.ring, 1.0);
        let header = format!("{} {} {} {}\n", image.width, image.height, image.xhot, image.yhot);
        let mut out = header.into_bytes();
        out.extend_from_slice(&image.pixels_rgba);
        std::fs::write(path, out).unwrap();
    }
}
