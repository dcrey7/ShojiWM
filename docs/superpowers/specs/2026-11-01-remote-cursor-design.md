---
title: Remote cursor and remote pointer speed
date: 2026-11-01 00:19 CET
author: Claude Code (with Abhishek)
type: design
status: approved
---

# Remote cursor and remote pointer speed

## Goal

When a phone drives the pointer through EIS (KDE Connect Remote Input), you
can see it at once, and one finger can cross the whole monitor. Your real
mouse and touchpad stay exactly as they are.

## Behaviour

### Mode

- A pointer event from an EIS device sets the mode to REMOTE.
- A pointer event from any other device (libinput, winit) sets the mode to
  LOCAL at once.
- After 3 s with no EIS pointer event, the mode returns to LOCAL.
- Only relative and absolute motion, buttons, and scroll count. Keyboard
  events do not change the mode.

### Speed curve (REMOTE relative motion only)

- The curve takes the input speed v (pixels per millisecond) from the delta
  and the time since the last EIS motion. A gap over 100 ms counts as a new
  stroke.
- Gain is 1.0 at v ≤ 0.3 px/ms. It rises linearly to 4.0 at v ≥ 2.5 px/ms.
- The output delta is delta × gain × `speed`.
- The curve runs before the existing motion-space step, so per-output scaling
  still applies.
- Absolute EIS motion is never scaled.

### Look (REMOTE only)

- The arrow is drawn at `scale` × the theme size (default 1.5), from the same
  xcursor theme, so it stays sharp.
- A ring is drawn around the arrow, centred on its visible part (the
  arrow's tip sits off-centre in its own image):
  - radius 0.75 × the scaled cursor size
  - 2 px stroke and a soft 6 px outer glow
  - colour `ring` (default `#3daee9`), alpha 0.85
- The ring fades in and out over 150 ms when the mode changes.
- The ring is a compositor render element drawn in the same frame as the
  cursor. If the hardware cursor plane cannot hold the bigger image, the
  existing software path draws it.
- Smoothness rule: the ring is one small texture, made once per
  (size, colour) and cached. Drawing it costs about the same as drawing the
  arrow, so it adds no new per-frame work.

### Config

```ts
COMPOSITOR.cursor.configure({
  theme: "breeze_cursors",
  remote: { speed: 1.0, scale: 1.5, ring: "#3daee9" },
});
```

- Each `remote` field is optional and falls back to the defaults above.
- `scale: 1` together with `ring: "none"` gives the plain cursor back.

## Blinking cursor bug (separate task, debug first)

- Symptom: the cursor blinks while the phone drives it and a voice chat
  window is open.
- Method: reproduce in the nested harness with a window that redraws all the
  time, plus EIS motion. Log which cursor path draws each frame (plane fast
  path or full render). Find the cause before any fix.

## Testing

The nested (winit) window cannot show this, because the host compositor
draws its cursor. So:
- Unit tests cover the gain curve, the mode and fade timing, config
  parsing, and the composed image (arrow kept, ring at the radius, hotspot
  moved with the padding).
- The nested harness (`shojiwm-setup/tools/rdtest`) stages 1 and 2 must still
  pass.
- The compositor logs `pointer source changed remote=…` on every mode
  switch.
- Final check on the real tty session with the phone.

## Out of scope

- absolute "phone = screen" mode
- a custom-drawn cursor shape
- a settings UI

## Changelog

- 2026-11-01 01:05 CET: ring centred on the arrow, radius 0.75, after a visual check showed a tip-centred ring looked off-balance.
- 2026-11-01 00:40 CET: testing section matched to the plan (winit draws no cursor).
- 2026-11-01 00:19 CET: created from the brainstorming session. Approved: glow
  ring, acceleration.
