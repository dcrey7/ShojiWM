//! The X11 `WM_WINDOW_ROLE` of each new toplevel, for the embedding
//! compositor.
//!
//! Chrome names its normal windows "browser" and its popups, like an OAuth
//! sign-in, "pop-up"; its profile picker has no role. A compositor can float
//! the windows that are not "browser". Satellite stores the role when it
//! makes the `xdg_toplevel`, before the request reaches the compositor, and
//! the compositor takes it out when the toplevel arrives.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// Key: the protocol id of the toplevel's `wl_surface` (the same number on
/// both ends, as in `window_positions`). A window with no role has no entry.
static ROLES: LazyLock<Mutex<HashMap<u32, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn set(surface_id: u32, role: Option<String>) {
    let mut roles = ROLES.lock().unwrap();
    match role {
        Some(role) => roles.insert(surface_id, role),
        None => roles.remove(&surface_id),
    };
}

/// Take a new toplevel's role. `None` when its window has no role.
pub fn take(surface_id: u32) -> Option<String> {
    ROLES.lock().unwrap().remove(&surface_id)
}
