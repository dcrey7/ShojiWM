# ShojiWM patches to xwayland-satellite

This folder holds a copy of xwayland-satellite at
`bea4dev/xwayland-satellite` commit `d995e79977d63e30e556302a347c6df8b7fd0961`
(version 0.8.2). The root `Cargo.toml` uses it through `[patch]`.

To return to the upstream crate, remove the `[patch]` entry and the
`exclude` line in the root `Cargo.toml`, then delete this folder.

## 1. Copy from an X11 app gives the previous text (every second copy)

Symptom: with Klipper running (Plasma's clipboard manager), every second
Ctrl+C in an X11 app (Chrome with `--ozone-platform=x11`) gives the previous
clipboard text, or nothing, to Wayland apps.

Cause, in `src/server/selection.rs` `set_selection_source`:

1. The X11 app copies again. Satellite replaces its old Wayland source,
   and that destroys it, before it sets the new one.
2. The compositor sees its current source destroyed and empties the
   clipboard. Data-control clients (Klipper) see the empty clipboard.
3. Klipper's "prevent empty clipboard" (on by default) sets its last
   history item, the previous copy, as the clipboard.
4. That arrives after satellite's new source, so the previous copy wins.
   Satellite then takes Klipper's selection and gives it to X11 as well.
5. On the next copy satellite has no old source to destroy, so that copy
   works. The result is a fail, work, fail, work pattern.

Fix:

- `set_selection_source` sets the new source first, and only then drops
  the old one. The compositor cancels the old source; the clipboard never
  goes empty.
- `SelectionEvents::cancelled` (`src/server/clientside.rs`) now holds the
  ids of the cancelled sources, not one flag. `handle_impl` clears the
  current source only when that source was cancelled. Before, a late
  cancel of an older source dropped the newer selection.

Test: `server::tests::{clipboard,primary}::copy_from_x11_twice`. It fails
on the old code (the selection went empty once). `testwl` now empties a
selection only when the *current* source is destroyed, and cancels a
replaced source, like real compositors do.

Measured in a headless ShojiWM with a Klipper stand-in (a wlr data-control
client that restores the last text when the clipboard goes empty), 20
copies each way, three runs:

| Build  | X11 to Wayland | Wayland to X11 |
|--------|----------------|----------------|
| before | 10/20 (each run) | 20/20 |
| after  | 20/20 (each run) | 20/20 |
