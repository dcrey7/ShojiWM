---
title: Launcher flash and orb click fixed
date: 2026-11-12 18:03 CET
author: Abhishek (with Claude Code)
type: update
status: done
---

# Launcher flash and orb click fixed

## What changed

1. **Flash before the menu.** A 144 fps recording showed the full panel for 4 frames before the fade on 3 of 6 opens. A scaled window goes through the engine's snapshot path, and the snapshot was stale. The open and close now slide 8 px (translateY) instead of scaling. Commit c0d60bf.
2. **Fade skipped.** The first frame tick after an idle moment carried a clock ~120 ms ahead of open(), so the 90 ms fade was skipped. The open motion now counts from the first drawn frame. The cascade rows no longer rise. Commit 6beb8b2.
3. **Orb click did nothing.** Plasma's executable engine ignores a command that is still connected, so one stuck run swallowed every later click. Each click now runs `shoji-launcher-toggle orb <time>`. Changed in the installed SevenStart CompactRepresentation.qml and in shojiwm-setup/bin/patch-sevenstart.py (backup in shojiwm-setup/backups/).

## Measured

- Second recording: 15 opens and closes checked, all one-way fades, 0 flashes.
- 6 of 6 orb clicks opened the launcher (event log).
- Tests: 95 of 95 pass.
- Abhishek confirmed: "nice fade when super and clicking".

## How to record

`FPS=144 python3 ~/Downloads/work/shoji-ad/rec/record.py OUT.mp4 25`, then measure the menu area per frame with ffmpeg signalstats.

## Still open

- Arrow-key stutter in the launcher: needs the engine change (cache the launcher content in a texture).
- Other animations may also skip their first ~120 ms after idle (engine clock).
- The laptop has none of these fixes yet.

## Changelog

- 2026-11-12 18:03 CET: created.
