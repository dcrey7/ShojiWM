//! Where the embedding compositor put each toplevel.
//!
//! Wayland never tells a client where its windows are, so every X11 toplevel
//! used to sit at its output's origin. X11 clients use window positions to
//! find the window under the pointer: Chrome looks for the window to drop a
//! dragged tab into that way. A compositor that runs satellite in its own
//! process publishes the real positions here, then wakes satellite through
//! the socket from `RunData::positions_rx`. Satellite moves the X11 windows
//! there (`ServerState::apply_window_positions`); their size stays.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// Key: the protocol id of the toplevel's `wl_surface` on satellite's
/// connection to the compositor (the same number on both ends). Value: the
/// window geometry's top-left corner in logical pixels, counted from the
/// top-left corner of the box around all outputs (the X11 root's origin).
static POSITIONS: LazyLock<Mutex<HashMap<u32, (i32, i32)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Store a toplevel's position. True when it changed (wake satellite then).
pub fn set(surface_id: u32, x: i32, y: i32) -> bool {
    let mut positions = POSITIONS.lock().unwrap();
    positions.insert(surface_id, (x, y)) != Some((x, y))
}

/// Forget a toplevel that is gone (its id can come back for a new surface).
pub fn remove(surface_id: u32) {
    POSITIONS.lock().unwrap().remove(&surface_id);
}

pub(crate) fn snapshot() -> HashMap<u32, (i32, i32)> {
    POSITIONS.lock().unwrap().clone()
}
