# Remote Cursor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** EIS (phone) pointer input gets an acceleration curve and a bigger cursor with a baked-in glow ring. Real mice are unchanged.

**Architecture:** A new module `remote_pointer.rs` holds three things:
- the gain curve
- the mode and fade state (LOCAL/REMOTE, 3 s idle, 150 ms fade)
- `compose_remote_cursor`, which bakes the ring into a copy of the xcursor image

`input.rs` marks each pointer event as REMOTE or LOCAL and scales EIS relative deltas. The tty cursor render branch asks the state for the current style and builds ONE image. That keeps the single hardware cursor plane valid, so the arrow and the ring never move apart. Config arrives through the existing `COMPOSITOR.cursor.configure` path as an optional `remote` object.

**Tech Stack:** Rust (smithay fork, xcursor `Image`, calloop timers), TypeScript config runtime.

## Global Constraints

- Defaults: `speed 1.0`, `scale 1.5`, `ring "#3daee9"`, ring alpha 0.85, fade 150 ms, idle 3 s.
- Gain: 1.0 at v ≤ 0.3 px/ms, linear to 4.0 at v ≥ 2.5 px/ms. A gap over 100 ms starts a new stroke (gain 1.0).
- `ring: "none"` turns the ring off. `scale: 1` with `ring: "none"` is the plain cursor.
- Never touch non-EIS devices. Absolute EIS motion is never scaled.
- EIS device check: `smithay::backend::input::Device::id(&dev).starts_with("ei-")`.
- Commit identity: `git -c user.name=Abhishek -c user.email=abhishek01789@gmail.com commit`. No Co-Authored-By lines.
- Unit tests: `~/.cargo/bin/cargo test -p shojiwm_lib remote_pointer`.

---

### Task 1: Gain curve and mode/fade state

**Files:**
- Create: `src/shojiwm_lib/src/remote_pointer.rs`
- Modify: `src/shojiwm_lib/src/lib.rs` (add `pub mod remote_pointer;` after `pub mod eis;`)

**Interfaces:**
- Produces:
  - `pub fn remote_gain(speed_px_per_ms: f64) -> f64`
  - `pub struct RemotePointer` with:
    - `pub fn note_remote_motion(&mut self, delta: (f64, f64), now: Instant) -> (f64, f64)` (returns the scaled delta, using `self.style.speed`)
    - `pub fn note_remote_activity(&mut self, now: Instant)` (buttons, scroll, absolute motion)
    - `pub fn note_local_activity(&mut self, now: Instant)`
    - `pub fn ring_alpha(&self, now: Instant) -> f32` (0.0..=1.0, faded)
    - `pub fn is_remote(&self, now: Instant) -> bool`
    - `pub fn animating(&self, now: Instant) -> bool` (true while a fade runs)
    - `pub fn idle_deadline(&self) -> Option<Instant>` (when REMOTE expires)
  - `pub struct RemoteCursorStyle { pub speed: f64, pub scale: f64, pub ring: Option<[u8; 3]> }` with `Default` and `pub fn from_config(c: Option<&crate::cursor::RuntimeRemoteCursorConfig>) -> Self`. Task 2 defines the config type, so Task 1 adds `from_config` in Task 2, not here.

- [ ] **Step 1: Write the failing tests** (module tail of `remote_pointer.rs`)

```rust
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
        assert_eq!(rp.note_remote_motion((30.0, 0.0), t + Duration::from_millis(150)), (30.0, 0.0));
    }

    #[test]
    fn fast_motion_is_accelerated_slow_motion_is_not() {
        let mut rp = RemotePointer::default();
        let t = Instant::now();
        rp.note_remote_motion((1.0, 0.0), t);
        // 2 px in 10 ms = 0.2 px/ms: 1:1.
        assert_eq!(rp.note_remote_motion((2.0, 0.0), t + Duration::from_millis(10)), (2.0, 0.0));
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `~/.cargo/bin/cargo test -p shojiwm_lib remote_pointer`
Expected: compile error (module items not defined).

- [ ] **Step 3: Implement**

```rust
//! Remote pointer: phone (EIS) input gets an acceleration curve and its own
//! cursor look, so you can see when the phone drives.
//!
//! LOCAL is any real mouse or touchpad. REMOTE starts on any EIS pointer
//! event and ends on a local pointer event or after `IDLE` with no EIS input.

use std::time::{Duration, Instant};

pub const IDLE: Duration = Duration::from_secs(3);
pub const FADE: Duration = Duration::from_millis(150);
const STROKE_GAP: Duration = Duration::from_millis(100);
const SLOW: f64 = 0.3; // px/ms: below this, 1:1
const FAST: f64 = 2.5; // px/ms: above this, MAX_GAIN
const MAX_GAIN: f64 = 4.0;

/// Pointer gain for an input speed in px/ms.
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
    /// RGB of the ring; None when the config says `ring: "none"`.
    pub ring: Option<[u8; 3]>,
}

impl Default for RemoteCursorStyle {
    fn default() -> Self {
        Self { speed: 1.0, scale: 1.5, ring: Some([0x3d, 0xae, 0xe9]) }
    }
}

#[derive(Debug, Default)]
pub struct RemotePointer {
    pub style: RemoteCursorStyle,
    last_remote: Option<Instant>,
    last_motion: Option<Instant>,
    /// When the ring last started fading in (Some) or out (None stays off).
    fade_in_at: Option<Instant>,
    fade_out_at: Option<Instant>,
}

impl RemotePointer {
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

    pub fn note_remote_activity(&mut self, now: Instant) {
        if !self.is_remote(now) {
            self.fade_in_at = Some(now);
            self.fade_out_at = None;
        }
        self.last_remote = Some(now);
    }

    pub fn note_local_activity(&mut self, now: Instant) {
        if self.is_remote(now) {
            self.fade_out_at = Some(now);
        }
        self.last_remote = None;
        self.last_motion = None;
    }

    pub fn is_remote(&self, now: Instant) -> bool {
        self.last_remote.is_some_and(|t| now.duration_since(t) < IDLE)
    }

    /// When REMOTE expires on its own, if it is active.
    pub fn idle_deadline(&self) -> Option<Instant> {
        self.last_remote.map(|t| t + IDLE)
    }

    pub fn ring_alpha(&self, now: Instant) -> f32 {
        let ramp = |since: Instant| (now.duration_since(since).as_secs_f32() / FADE.as_secs_f32()).clamp(0.0, 1.0);
        if self.is_remote(now) {
            return self.fade_in_at.map_or(1.0, ramp);
        }
        // Fading out: after a local event, or after the idle timeout.
        let out_start = self.fade_out_at.or_else(|| self.idle_deadline());
        match out_start {
            Some(start) if now >= start => 1.0 - ramp(start),
            _ => 0.0,
        }
    }

    pub fn animating(&self, now: Instant) -> bool {
        let a = self.ring_alpha(now);
        a > 0.0 && a < 1.0
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `~/.cargo/bin/cargo test -p shojiwm_lib remote_pointer`
Expected: 6 passed.

- [ ] **Step 5: Commit** `feat: remote pointer gain curve and mode state`

---

### Task 2: Config `remote` field (Rust + TypeScript)

**Files:**
- Modify: `src/shojiwm_lib/src/cursor.rs` (struct `RuntimeCursorConfigUpdate` ~17, early return ~84, tests ~214-245)
- Modify: `src/shojiwm_lib/src/remote_pointer.rs` (add `RemoteCursorStyle::from_config`)
- Modify: `src/shojiwm_lib/src/state.rs` `apply_runtime_cursor_config_update` (~4021) and the struct field list (~666): add `pub remote_pointer: crate::remote_pointer::RemotePointer` with `Default::default()` in the constructor
- Modify: `src/shojiwm_rs/src/compositor.rs` ~246 (struct literal: add `remote: None`)
- Modify: `packages/shoji_wm/src/types.ts` ~2301 (`CursorConfig`)
- Modify: `packages/shoji_wm/src/cursor.ts` `normalizeConfig` (~51) and `cloneConfig` (~67)

**Interfaces:**
- Produces:
  - `pub struct RuntimeRemoteCursorConfig { pub speed: Option<f64>, pub scale: Option<f64>, pub ring: Option<String> }`
  - `RuntimeCursorConfigUpdate.remote: Option<RuntimeRemoteCursorConfig>`
  - `RemoteCursorStyle::from_config(Option<&RuntimeRemoteCursorConfig>) -> RemoteCursorStyle`

- [ ] **Step 1: Write the failing tests** (in `remote_pointer.rs` tests)

```rust
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
```

And in `cursor.rs` tests:

```rust
    #[test]
    fn cursor_config_accepts_optional_remote() {
        let v = serde_json::json!({"theme":"breeze_cursors","size":24,"reload":false,"remote":{"speed":1.5}});
        let u: RuntimeCursorConfigUpdate = serde_json::from_value(v).unwrap();
        assert_eq!(u.remote.unwrap().speed, Some(1.5));
        let v = serde_json::json!({"theme":"breeze_cursors","size":24,"reload":false});
        let u: RuntimeCursorConfigUpdate = serde_json::from_value(v).unwrap();
        assert!(u.remote.is_none());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**: `~/.cargo/bin/cargo test -p shojiwm_lib -- remote_pointer cursor::tests`. Expected: compile error (no `remote`).

- [ ] **Step 3: Implement**

In `cursor.rs`, next to `RuntimeCursorConfigUpdate`:

```rust
/// `COMPOSITOR.cursor.configure({ remote })`: how the cursor looks and moves
/// while a phone (EIS) drives it. Every field is optional.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRemoteCursorConfig {
    #[serde(default)]
    pub speed: Option<f64>,
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub ring: Option<String>,
}
```

Add `#[serde(default)] pub remote: Option<RuntimeRemoteCursorConfig>,` to `RuntimeCursorConfigUpdate`, and `remote: None` to every struct literal (cursor.rs tests, shojiwm_rs compositor.rs). `Cursor::apply_runtime_config` keeps its theme/size early return. The remote style is applied in `state.rs`, not in `Cursor`.

In `remote_pointer.rs`:

```rust
impl RemoteCursorStyle {
    pub fn from_config(config: Option<&crate::cursor::RuntimeRemoteCursorConfig>) -> Self {
        let d = Self::default();
        let Some(c) = config else { return d };
        let speed = c.speed.filter(|s| s.is_finite() && *s > 0.0 && *s <= 10.0).unwrap_or(d.speed);
        let scale = c.scale.filter(|s| s.is_finite() && *s >= 1.0 && *s <= 4.0).unwrap_or(d.scale);
        let ring = match c.ring.as_deref() {
            None => d.ring,
            Some("none") => None,
            Some(hex) => parse_hex_rgb(hex).or(d.ring),
        };
        Self { speed, scale, ring }
    }
}

fn parse_hex_rgb(s: &str) -> Option<[u8; 3]> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}
```

In `state.rs` `apply_runtime_cursor_config_update`, before the existing apply call:

```rust
let style = crate::remote_pointer::RemoteCursorStyle::from_config(update.remote.as_ref());
if style != self.remote_pointer.style {
    self.remote_pointer.style = style;
    self.pointer_images.clear(); // drop cached remote images built with the old style
    self.schedule_redraw();
}
```

TypeScript `types.ts`:

```ts
export interface RemoteCursorConfig {
  /** Multiplier on top of the phone acceleration curve. Default 1. */
  speed?: number;
  /** Cursor size multiplier while a phone drives. Default 1.5. */
  scale?: number;
  /** Ring colour "#rrggbb", or "none". Default "#3daee9". */
  ring?: string;
}
```

Add `remote?: RemoteCursorConfig;` to `CursorConfig`. In `cursor.ts`, carry `remote` through `normalizeConfig` and `cloneConfig`:

```ts
// in normalizeConfig(config):
remote: config.remote ? { ...config.remote } : undefined,
// in cloneConfig(config):
remote: config.remote ? { ...config.remote } : undefined,
```

- [ ] **Step 4: Run the tests**: `~/.cargo/bin/cargo test -p shojiwm_lib -- remote_pointer cursor::tests` (pass), then `~/.cargo/bin/cargo build --profile release-fast -p shoji_wm` (0 warnings).

- [ ] **Step 5: Commit** `feat: cursor config gains an optional remote style`

---

### Task 3: Input hooks (mode + acceleration)

**Files:**
- Modify: `src/shojiwm_lib/src/input.rs`:
  - PointerMotion branch (~1215; the delta line ~1278)
  - PointerMotionAbsolute (~1375)
  - PointerButton (~1432)
  - PointerAxis (~2090)
  - a helper near `request_redraw_for_pointer_motion` (193)

**Interfaces:**
- Consumes: `RemotePointer::{note_remote_motion, note_remote_activity, note_local_activity, idle_deadline}`, field `ShojiWM.remote_pointer`.
- Produces: `fn note_pointer_source<D: smithay::backend::input::Device>(&mut self, device: &D) -> bool` (returns true for EIS).

- [ ] **Step 1: Add the helper**

```rust
    /// Records whether a phone (EIS) or a real device drives the pointer and
    /// returns true for EIS. Arms a one-shot timer so the remote look fades
    /// out after the idle timeout even when no other redraw happens.
    fn note_pointer_source<D: smithay::backend::input::Device>(&mut self, device: &D) -> bool {
        let now = std::time::Instant::now();
        let remote = smithay::backend::input::Device::id(device).starts_with("ei-");
        let was_remote = self.remote_pointer.is_remote(now);
        if remote {
            self.remote_pointer.note_remote_activity(now);
        } else {
            self.remote_pointer.note_local_activity(now);
        }
        if remote && !was_remote {
            self.arm_remote_cursor_timer();
        }
        if remote != was_remote {
            tracing::info!(remote, "pointer source changed");
            self.schedule_redraw();
        }
        remote
    }

    fn arm_remote_cursor_timer(&mut self) {
        use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
        let _ = self.loop_handle.insert_source(Timer::from_duration(crate::remote_pointer::IDLE), |_, _, state| {
            let now = std::time::Instant::now();
            match state.remote_pointer.idle_deadline() {
                Some(deadline) if deadline > now => TimeoutAction::ToDuration(deadline - now),
                _ => {
                    // Expired (or a local event ended it): redraw for the fade out.
                    state.schedule_redraw();
                    TimeoutAction::Drop
                }
            }
        });
    }
```

- [ ] **Step 2: Hook the branches.**

PointerMotion: replace the `let motion_delta = self.pointer_motion_delta(&event.device(), event.delta(), previous_pos);` line with:

```rust
let device = event.device();
let raw = event.delta();
let raw = if self.note_pointer_source(&device) {
    let (dx, dy) = self.remote_pointer.note_remote_motion((raw.x, raw.y), std::time::Instant::now());
    smithay::utils::Point::from((dx, dy))
} else {
    raw
};
let motion_delta = self.pointer_motion_delta(&device, raw, previous_pos);
```

PointerMotionAbsolute, PointerButton, PointerAxis: add `self.note_pointer_source(&event.device());` as the first statement of each branch.

- [ ] **Step 3: Verify.** Run `~/.cargo/bin/cargo build --profile release-fast -p shoji_wm` (0 warnings). Then run stage 1 of the harness: `dbus-run-session -- python3 -u ~/Downloads/work/shojiwm-setup/tools/rdtest/stage1.py`. Expected: everything passes except "relative motion moved +15 px". That one is a single fresh stroke, so the gain is 1.0 and it must still pass. If it fails, the stroke-gap logic is wrong.

- [ ] **Step 4: Commit** `feat: phone pointer input switches remote mode and accelerates`

---

### Task 4: Ring compositing and tty render

**Files:**
- Modify: `src/shojiwm_lib/src/remote_pointer.rs` (add `compose_remote_cursor` + test)
- Modify: `src/shojiwm_lib/src/cursor.rs` (add `get_image_sized`)
- Modify: `src/shojiwm_lib/src/backend/tty.rs` (~4642-4672, the Named cursor branch)

**Interfaces:**
- Produces:
  - `pub fn compose_remote_cursor(base: &xcursor::parser::Image, ring: Option<[u8; 3]>, alpha: f32) -> xcursor::parser::Image`
  - `Cursor::get_image_sized(&mut self, icon: CursorIcon, size: u32, time: Duration) -> Image`

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn composed_cursor_keeps_the_arrow_and_adds_a_ring_around_the_hotspot() {
        let w = 8u32;
        let mut px = vec![0u8; (w * w * 4) as usize];
        px[0..4].copy_from_slice(&[255, 255, 255, 255]); // opaque hotspot pixel at (0,0)
        let base = xcursor::parser::Image { size: 8, width: w, height: w, xhot: 0, yhot: 0, delay: 0, pixels_rgba: px, pixels_argb: vec![] };
        let out = compose_remote_cursor(&base, Some([0x3d, 0xae, 0xe9]), 1.0);
        assert!(out.width > base.width && out.height > base.height);
        // The hotspot moves with the padding, and the arrow pixel is still opaque there.
        let at = |x: u32, y: u32| { let i = ((y * out.width + x) * 4) as usize; out.pixels_rgba[i..i + 4].to_vec() };
        assert_eq!(at(out.xhot, out.yhot)[3], 255);
        // Some pixel at ring radius from the hotspot is ring-coloured (non-zero alpha).
        let r = ring_radius(base.size);
        assert!(at(out.xhot + r, out.yhot)[3] > 0);
        // alpha 0 or no ring: the image is the base, unchanged.
        assert_eq!(compose_remote_cursor(&base, None, 1.0), base);
        assert_eq!(compose_remote_cursor(&base, Some([1, 2, 3]), 0.0), base);
    }
```

- [ ] **Step 2: Run the test to verify it fails**: `~/.cargo/bin/cargo test -p shojiwm_lib remote_pointer`. Expected: compile error. Add `xcursor` to `shojiwm_lib/Cargo.toml` only if it is not reachable; check `smithay::reexports` or the existing `use` in cursor.rs first, and reuse that path.

- [ ] **Step 3: Implement `compose_remote_cursor`.**

Pixels are premultiplied, in the byte order the tty buffer uses (`Fourcc::Argb8888` from `pixels_rgba`, so little-endian bytes are B, G, R, A).

```rust
const RING_ALPHA: f32 = 0.85;
const RING_STROKE: f32 = 2.0;
const RING_GLOW: f32 = 6.0;

/// Ring radius in image pixels for a cursor image of nominal `size`.
pub fn ring_radius(size: u32) -> u32 {
    ((size as f32) * 1.1).round() as u32
}

/// A copy of `base` on a larger canvas with a soft ring centred on the
/// hotspot, drawn UNDER the arrow. One image, so the hardware cursor plane
/// (which holds one buffer) keeps the arrow and ring together.
pub fn compose_remote_cursor(base: &xcursor::parser::Image, ring: Option<[u8; 3]>, alpha: f32) -> xcursor::parser::Image {
    let Some([r, g, b]) = ring else { return base.clone() };
    if alpha <= 0.0 {
        return base.clone();
    }
    let radius = ring_radius(base.size) as f32;
    let reach = (radius + RING_STROKE + RING_GLOW).ceil() as i64;
    let (hx, hy) = (base.xhot as i64, base.yhot as i64);
    // Canvas covers the base image and the ring around the hotspot.
    let left = (reach - hx).max(0);
    let top = (reach - hy).max(0);
    let width = (left + (base.width as i64).max(hx + reach + 1)) as u32;
    let height = (top + (base.height as i64).max(hy + reach + 1)) as u32;
    let mut px = vec![0u8; (width * height * 4) as usize];
    let (cx, cy) = ((hx + left) as f32 + 0.5, (hy + top) as f32 + 0.5);
    for y in 0..height {
        for x in 0..width {
            let d = (((x as f32 + 0.5) - cx).powi(2) + ((y as f32 + 0.5) - cy).powi(2)).sqrt();
            let off = (d - radius).abs();
            // Solid stroke, then a soft glow falling off to zero.
            let cover = if off <= RING_STROKE / 2.0 {
                1.0
            } else {
                (1.0 - (off - RING_STROKE / 2.0) / RING_GLOW).clamp(0.0, 1.0).powi(2) * 0.6
            };
            let a = cover * RING_ALPHA * alpha.clamp(0.0, 1.0);
            if a <= 0.0 {
                continue;
            }
            let i = ((y * width + x) * 4) as usize;
            px[i] = (b as f32 * a) as u8;
            px[i + 1] = (g as f32 * a) as u8;
            px[i + 2] = (r as f32 * a) as u8;
            px[i + 3] = (255.0 * a) as u8;
        }
    }
    // Arrow over the ring (premultiplied "over").
    for y in 0..base.height {
        for x in 0..base.width {
            let s = ((y * base.width + x) * 4) as usize;
            let src = &base.pixels_rgba[s..s + 4];
            let sa = src[3] as f32 / 255.0;
            if sa == 0.0 {
                continue;
            }
            let d = (((y + top as u32) * width + x + left as u32) * 4) as usize;
            for k in 0..4 {
                px[d + k] = (src[k] as f32 + px[d + k] as f32 * (1.0 - sa)).round().min(255.0) as u8;
            }
        }
    }
    xcursor::parser::Image {
        size: base.size,
        width,
        height,
        xhot: base.xhot + left as u32,
        yhot: base.yhot + top as u32,
        delay: base.delay,
        pixels_rgba: px,
        pixels_argb: Vec::new(),
    }
}
```

- [ ] **Step 4: Add `get_image_sized` in `cursor.rs`.** It is the same as `get_image`, but uses the given size instead of `self.size * scale`:

```rust
    /// Like `get_image`, at an explicit nominal size (the remote cursor asks
    /// for `size * scale * remote_scale`).
    pub fn get_image_sized(&mut self, icon: CursorIcon, size: u32, time: Duration) -> Image {
        let saved = self.size;
        self.size = size.max(1);
        let image = self.get_image(icon, 1, time);
        self.size = saved;
        image
    }
```

Before writing this, read `get_image` (cursor.rs 99-112) and check that it does not cache by `self.size`. If it does, key the cache lookup by size instead.

- [ ] **Step 5: Hook the tty Named branch (tty.rs ~4645).** Replace

```rust
let frame = cursor_theme.get_image(icon, cursor_scale, start_time.elapsed());
```

with

```rust
let now = std::time::Instant::now();
let ring_alpha = remote_pointer.ring_alpha(now);
let frame = if ring_alpha > 0.0 {
    let size = (cursor_theme.size() as f64 * cursor_scale as f64 * remote_pointer.style.scale).round() as u32;
    let base = cursor_theme.get_image_sized(icon, size, start_time.elapsed());
    // Quantise alpha to 8 steps so the image cache stays small during a fade.
    let step = (ring_alpha * 8.0).round() / 8.0;
    crate::remote_pointer::compose_remote_cursor(&base, remote_pointer.style.ring, step)
} else {
    cursor_theme.get_image(icon, cursor_scale, start_time.elapsed())
};
if remote_pointer.animating(now) {
    redraw_after_frame = true;
}
```

`remote_pointer` is `&state.remote_pointer`, borrowed next to `cursor_theme`, `pointer_images` and `current_pointer_image` (find where those locals are destructured from `state` above 4616 and add it there). `redraw_after_frame` is a local bool declared before the cursor scope. After the frame is queued, `if redraw_after_frame { state.schedule_redraw(); }`. Put this where the function already has `&mut state` again (after the render submit). The existing hotspot math `frame.xhot / cursor_scale` stays correct, because the composed image keeps the buffer scale.

- [ ] **Step 6: Verify.**
  - `~/.cargo/bin/cargo test -p shojiwm_lib remote_pointer` (7 pass).
  - `~/.cargo/bin/cargo build --release -p shoji_wm -p xdg-desktop-portal-shojiwm` (0 warnings).
  - Harness stage 1 and stage 2 still pass: `bash ~/Downloads/work/shojiwm-setup/tools/rdtest/run2.sh`.

- [ ] **Step 7: Commit** `feat: remote cursor draws bigger with a glow ring`

---

### Task 5: Blinking cursor (debug first)

**Files:** none until the cause is known.

- [ ] **Step 1: Collect evidence** on the real session after Task 4 is installed:
  - Ask Abhishek to open the voice chat and drive the cursor from the phone for 20 s.
  - Then read `~/shoji_wm/logs/latest.log` for `note_cursor_plane_transition` lines (tty.rs ~582) and `pointer source changed` lines.
  - Count the plane on/off transitions per second.
- [ ] **Step 2: Form one hypothesis** from the evidence. Candidates:
  - The plane flips on and off while the voice window redraws.
  - The cursor surface from the voice app (`CursorImageStatus::Surface`) toggles hidden.
  - REMOTE/LOCAL flapping.
- [ ] **Step 3: Test it** with the smallest change (for example `SHOJI_CURSOR_FAST_PATH=0` for one session) and compare. Only then write a fix with a regression test. Use superpowers:systematic-debugging.

---

### Task 6: Install, docs, push

- [ ] Rebuild release, then `bash ~/Downloads/work/shojiwm-setup/install-remote-input.sh` (Abhishek runs it; sudo) and relogin.
- [ ] Phone test: slow drag (precise), fast flick (crosses the screen), the ring appears, and touching the real mouse brings the normal cursor back at once.
- [ ] Add a "Remote cursor" section to `knowledges/portal-install.md` (config keys + defaults) and a dated note in `shojiwm-setup/docs/updates/`.
- [ ] `git push fork portal-remote-desktop`.
