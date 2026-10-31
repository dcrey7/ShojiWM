//! EIS (emulated input) server behind the RemoteDesktop portal.
//!
//! Remote-control apps such as KDE Connect's Remote Input send pointer and
//! keyboard events through libei. They never reach this socket directly:
//! xdg-desktop-portal-shojiwm asks the user first, then answers the app's
//! `ConnectToEIS` by connecting here and handing the connected end over.
//!
//! Each connection becomes a smithay [`EiInput`] source. Its events take the
//! same path as a real mouse and keyboard (`process_input_event`), so
//! bindings, focus, pointer constraints and the session lock all apply.
//!
//! The socket is `$XDG_RUNTIME_DIR/shojiwm.<WAYLAND_DISPLAY>.eis.sock`, exported
//! as `SHOJIWM_EIS_SOCKET`. Mode 0600: only this user may connect.

use std::{
    ffi::OsStr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use smithay::{
    backend::libei::{EiInput, EiInputEvent, EiInputSeat, EiRegion},
    reexports::{
        calloop::{LoopHandle, PostAction},
        reis::{calloop::EisListenerSource, eis},
    },
    utils::Rectangle,
};
use tracing::{info, warn};

use crate::{runtime_input::RuntimeKeyboardInputConfig, state::ShojiWM};

pub const SOCKET_ENV: &str = "SHOJIWM_EIS_SOCKET";

const SEAT_NAME: &str = "default";
const POINTER_NAME: &str = "ShojiWM virtual pointer";
const ABSOLUTE_POINTER_NAME: &str = "ShojiWM virtual absolute pointer";
const KEYBOARD_NAME: &str = "ShojiWM virtual keyboard";

/// Where the compositor on `wayland_display` accepts EIS connections.
pub fn socket_path(wayland_display: &OsStr) -> Option<PathBuf> {
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").filter(|dir| !dir.is_empty())?;
    let mut name = std::ffi::OsString::from("shojiwm.");
    name.push(wayland_display);
    name.push(".eis.sock");
    Some(Path::new(&runtime_dir).join(name))
}

/// Bind the EIS socket for `wayland_display`. The listener lives in the event
/// loop and unlinks its socket file when the loop drops it. Failing to bind
/// only costs remote input, so it is logged rather than fatal.
pub fn start(loop_handle: &LoopHandle<'static, ShojiWM>, wayland_display: &OsStr) {
    let Some(path) = socket_path(wayland_display) else {
        warn!("XDG_RUNTIME_DIR is not set; remote input (EIS) is disabled");
        return;
    };
    // Namespaced by the Wayland display this process owns, so anything already
    // there was left behind by a crashed instance.
    let _ = std::fs::remove_file(&path);
    let listener = match eis::Listener::bind(&path) {
        Ok(listener) => listener,
        Err(error) => {
            warn!(path = %path.display(), %error, "failed to bind the EIS socket");
            return;
        }
    };
    if let Err(error) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
        warn!(path = %path.display(), %error, "failed to restrict the EIS socket");
        return;
    }

    let handle = loop_handle.clone();
    let inserted = loop_handle.insert_source(
        EisListenerSource::new(listener),
        move |context, _, _state| {
            accept(&handle, context);
            Ok(PostAction::Continue)
        },
    );
    if let Err(error) = inserted {
        warn!(%error, "failed to register the EIS socket");
        return;
    }

    crate::process_env::set_var(SOCKET_ENV, &path);
    info!(path = %path.display(), "EIS socket listening");
}

fn accept(loop_handle: &LoopHandle<'static, ShojiWM>, context: eis::Context) {
    let mut client = EisClient::default();
    let inserted = loop_handle.insert_source(EiInput::new(context), move |event, connection, state| {
        match event {
            EiInputEvent::Connected => {
                info!("EIS client connected");
                let seat = connection.add_seat(SEAT_NAME);
                seat.add_pointer(POINTER_NAME);
                client.seat = Some(seat);
                client.sync(state);
            }
            EiInputEvent::Disconnected => {
                info!("EIS client disconnected");
                client.seat = None;
            }
            EiInputEvent::Event(event) => {
                client.sync(state);
                state.process_input_event(event);
            }
            // No text device is offered, so clients fall back to keycodes
            // through the keymap. KDE Connect does exactly that.
            EiInputEvent::TextKeysym { .. } | EiInputEvent::TextUtf8 { .. } => {}
        }
    });
    if let Err(error) = inserted {
        warn!(%error, "failed to register an EIS connection");
    }
}

/// What one connection has advertised, so it can be refreshed when the
/// compositor's keymap or output layout changes under it.
#[derive(Default)]
struct EisClient {
    seat: Option<EiInputSeat>,
    /// `None` until the keyboard device exists; then the config it was built from.
    keyboard: Option<Option<RuntimeKeyboardInputConfig>>,
    /// `None` until the absolute pointer exists; then the regions it advertises.
    regions: Option<Vec<EiRegion>>,
}

impl EisClient {
    /// Bring the keyboard keymap and the absolute pointer regions in line with
    /// the compositor. Cheap when nothing changed: two comparisons.
    fn sync(&mut self, state: &ShojiWM) {
        let Some(seat) = &self.seat else {
            return;
        };

        // The client turns keysyms into keycodes with this keymap, so it must
        // be the one the seat keyboard uses right now.
        let xkb = state.runtime_applied_xkb_config.clone();
        if self.keyboard.as_ref() != Some(&xkb) {
            let config = crate::runtime_input::xkb_config_for(xkb.as_ref());
            if let Err(error) = seat.add_keyboard(KEYBOARD_NAME, config) {
                warn!(?error, "EIS keyboard: failed to compile the keymap");
            }
            // Remembered either way: retrying a broken config on every event
            // would only repeat the warning.
            self.keyboard = Some(xkb);
        }

        let regions = output_regions(state);
        match &self.regions {
            None => seat.add_pointer_absolute(ABSOLUTE_POINTER_NAME, &regions),
            Some(current) if *current != regions => seat.update_regions(&regions),
            Some(_) => return,
        }
        self.regions = Some(regions);
    }
}

/// One region per output, in the coordinate space absolute motion arrives in.
///
/// The absolute motion handler adds the layout's top-left corner to the
/// position, and EI positions are not scaled by the output size, so regions
/// are expressed relative to that corner.
fn output_regions(state: &ShojiWM) -> Vec<EiRegion> {
    let Some(bounds) = state.output_layout_bounds() else {
        return Vec::new();
    };
    state
        .space
        .outputs()
        .filter_map(|output| {
            let geometry = state.space.output_geometry(output)?;
            Some(EiRegion {
                rect: Rectangle::new(geometry.loc - bounds.loc, geometry.size),
                scale: output.current_scale().fractional_scale() as f32,
                mapping_id: Some(output.name()),
            })
        })
        .collect()
}
