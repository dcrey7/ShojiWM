---
title: Clipboard to X11 fixed, Magic Lamp stutter under training measured
date: 2026-11-12 18:35 CET
author: Abhishek (with Claude Code)
type: update
status: in progress
---

# Clipboard to X11 fixed, Magic Lamp stutter under training measured

## Clipboard (fixed)

- Symptom: Chrome (XWayland) always pasted an old text ("Myprotein Impact Whey"), whatever Konsole copied.
- Cause: the embedded xwayland-satellite kept a stale X11 source. Smithay denies a set_selection from a client without keyboard focus, silently and without a cancel. The satellite then ignored every later Wayland offer (`state.source.is_none()` check).
- Engine fix (commit 4286799, needs the new binary): a new offer that is not our own echo (different mime list) replaces the stale X11 source; a paste request for a dropped source is skipped, not a panic.
- Live fix now: `helpers/clip-x11-sync.py` service copies Wayland text onto the X11 CLIPBOARD every 0.3 s. It answers X11 requests while `wl-paste` runs (the satellite mirrors our X11 text back to Wayland; blocking deadlocked).
- Install the engine fix: `sudo cp target/release/shoji_wm /usr/bin/shoji_wm`, then log out and in.

## Layout key

- Super+Space (workspace mode tiled/scrolling/floating) moved to Super+Shift+Space (commit 23c9340). An accidental press had put workspace 1 in scrolling mode.

## Magic Lamp stutter while a CUDA training runs (open)

Measured with `tools/debug/lamp-bench.py` (Konsole minimize + restore x6), training at ~77% GPU:

| Case | Late frames (>10.4 ms) | Median |
|---|---|---|
| Glass on | 35 to 42% | 9.2 ms |
| Glass off (quality level 1, test only) | 13% | 6.9 ms |
| Lamp invalidate on-source-damage-box | 34 to 44% | no gain, reverted |

Ruled out:
- CPU: load 4 of 16, shoji_wm nice -4.
- VRAM: 10.5 of 24 GB.
- EGL priority: HIGH granted (`tools/debug/egl-priority-check.py`).
- nvidia-smi timeslice SHORT (set by Abhishek): little gain.
- Frame timing: render starts right after the flip, render-ahead is on, 3 frames in flight; `estimated_render_duration` sets no deadline.

Conclusion: under contention one frame needs ~9 ms of GPU time against a 6.94 ms budget. Only less GPU work per frame fixes it. Abhishek refuses any visual change (final theme).

Next options that keep the look:
1. Measure GPU time per frame: `SHOJI_GPU_TIMING_DEBUG=1 SHOJI_GPU_ELEMENT_TIMING_DEBUG=1` (needs a restart with the env).
2. Engine: cache the blurred backdrop and redo blur only in the damaged area (clip passes to damage); same pixels.
3. Small: `SHOJI_CURSOR_FAST_PATH=0`, or allow render-ahead while a cursor commit waits (tty.rs:1673), for a few ms more on the minimize click.

## Changelog

- 2026-11-12 18:35 CET: created.
