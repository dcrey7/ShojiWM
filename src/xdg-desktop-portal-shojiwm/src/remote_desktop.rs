//! org.freedesktop.impl.portal.RemoteDesktop backend implementation.
//!
//! See: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.impl.portal.RemoteDesktop.html
//!
//! Input never goes through this process for modern clients. ShojiWM runs an
//! EIS server (`shojiwm_lib::eis`) on `$XDG_RUNTIME_DIR/shojiwm.<display>.eis.sock`;
//! after the user allows a session, `ConnectToEIS` connects to that socket and
//! hands the connected end to the app, which then talks libei to the
//! compositor directly. KDE Connect's Remote Input works this way.
//!
//! Older clients use the `Notify*` methods instead. For those the portal opens
//! its own EIS connection per session ([`notify`]) and replays each call on it.

use std::collections::HashMap;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use zbus::zvariant::{self, ObjectPath, OwnedValue, Value};

use crate::i18n;
use crate::picker::PickerHandle;

/// DeviceType bitmask values from the portal spec.
mod device_types {
    pub const KEYBOARD: u32 = 1 << 0;
    pub const POINTER: u32 = 1 << 1;
}

/// Touch is not offered: no client we know of needs it, and smithay's touch
/// path would need per-output mapping first.
const AVAILABLE_DEVICES: u32 = device_types::KEYBOARD | device_types::POINTER;

/// Response codes from the portal spec.
const RESPONSE_SUCCESS: u32 = 0;
const RESPONSE_CANCELLED: u32 = 1;
const RESPONSE_OTHER: u32 = 2;

/// Vendor tag inside the `(suv)` restore_data blob, as in ScreenCast.
const RESTORE_VENDOR: &str = "shojiwm-remote-desktop";
const RESTORE_VERSION: u32 = 1;

/// Where the compositor on the current Wayland display accepts EIS
/// connections. Mirrors `shojiwm_lib::eis::socket_path`.
fn eis_socket_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("SHOJIWM_EIS_SOCKET").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty())?;
    let display = std::env::var_os("WAYLAND_DISPLAY").filter(|d| !d.is_empty())?;
    let mut name = std::ffi::OsString::from("shojiwm.");
    name.push(display);
    name.push(".eis.sock");
    Some(PathBuf::from(runtime_dir).join(name))
}

fn connect_to_compositor() -> zbus::fdo::Result<UnixStream> {
    let path = eis_socket_path().ok_or_else(|| {
        zbus::fdo::Error::Failed("cannot locate the ShojiWM EIS socket".to_string())
    })?;
    UnixStream::connect(&path).map_err(|e| {
        zbus::fdo::Error::Failed(format!("cannot connect to {}: {e}", path.display()))
    })
}

#[derive(Default)]
struct Session {
    /// Devices the app asked for at SelectDevices, already limited to ours.
    devices: u32,
    persist_mode: u32,
    /// SelectDevices carried our restore_data: the user allowed this app
    /// before, and the frontend vouches that the token belongs to it.
    restored: bool,
    /// Start succeeded; input may flow.
    started: bool,
    /// The `Notify*` replay connection, opened on first use.
    notify: Option<mpsc::UnboundedSender<notify::Command>>,
}

struct Inner {
    picker: PickerHandle,
    sessions: Mutex<HashMap<String, Session>>,
}

impl Inner {
    fn cleanup_session(&self, session_key: &str) {
        // Dropping the session drops the replay sender, which ends its task
        // and closes its EIS connection. Connections handed out through
        // ConnectToEIS belong to the app, which closes them with the session.
        let removed = self.sessions.lock().unwrap().remove(session_key);
        tracing::info!(session_key, existed = removed.is_some(), "remote desktop session closed");
    }

    /// Queue a replay command on a started session that selected `device`.
    fn notify(
        &self,
        session_handle: &ObjectPath<'_>,
        device: u32,
        command: notify::Command,
    ) -> zbus::fdo::Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_handle.as_str())
            .ok_or_else(|| zbus::fdo::Error::Failed("unknown session".to_string()))?;
        if !session.started || session.devices & device == 0 {
            return Err(zbus::fdo::Error::AccessDenied(
                "device not granted for this session".to_string(),
            ));
        }
        let sender = match &session.notify {
            Some(sender) if !sender.is_closed() => sender.clone(),
            _ => {
                let stream = connect_to_compositor()?;
                let sender = notify::spawn(stream)
                    .map_err(|e| zbus::fdo::Error::Failed(format!("EIS connection: {e}")))?;
                session.notify = Some(sender.clone());
                sender
            }
        };
        sender
            .send(command)
            .map_err(|_| zbus::fdo::Error::Failed("EIS connection closed".to_string()))
    }
}

pub struct RemoteDesktop {
    inner: Arc<Inner>,
}

impl RemoteDesktop {
    pub fn new(picker: PickerHandle) -> Self {
        Self {
            inner: Arc::new(Inner {
                picker,
                sessions: Mutex::new(HashMap::new()),
            }),
        }
    }
}

/// Per-session `org.freedesktop.impl.portal.Session` object, exported at the
/// session handle so the frontend's Close reaches us.
struct SessionImpl {
    session_key: String,
    inner: Arc<Inner>,
}

#[zbus::interface(name = "org.freedesktop.impl.portal.Session")]
impl SessionImpl {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        1
    }

    async fn close(
        &self,
        #[zbus(object_server)] server: &zbus::ObjectServer,
    ) -> zbus::fdo::Result<()> {
        self.inner.cleanup_session(&self.session_key);
        if let Ok(path) = ObjectPath::try_from(self.session_key.clone()) {
            let _ = server.remove::<Self, _>(&path).await;
        }
        Ok(())
    }
}

fn option_u32(options: &HashMap<String, OwnedValue>, key: &str) -> Option<u32> {
    options.get(key).and_then(|v| u32::try_from(v).ok())
}

fn option_bool(options: &HashMap<String, OwnedValue>, key: &str) -> bool {
    options
        .get(key)
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(false)
}

/// True when `value` is restore_data this backend wrote.
fn is_our_restore_data(value: &OwnedValue) -> bool {
    let Value::Structure(structure) = &**value else {
        return false;
    };
    let fields = structure.fields();
    matches!(
        (fields.first(), fields.get(1)),
        (Some(Value::Str(vendor)), Some(Value::U32(version)))
            if vendor.as_str() == RESTORE_VENDOR && *version == RESTORE_VERSION
    )
}

fn restore_data(devices: u32) -> Option<OwnedValue> {
    let blob = Value::from((
        RESTORE_VENDOR.to_string(),
        RESTORE_VERSION,
        Value::new(devices),
    ));
    OwnedValue::try_from(blob).ok()
}

/// A readable name for the consent dialog. Host apps often arrive with an
/// empty app_id; the dialog must still say something.
fn display_name(app_id: &str) -> String {
    if app_id.is_empty() {
        return i18n::t("remote_control.unknown_app");
    }
    match app_id {
        "org.kde.kdeconnect.daemon" | "org.kde.kdeconnect" | "kdeconnectd" => {
            "KDE Connect".to_string()
        }
        other => other.to_string(),
    }
}

#[zbus::interface(name = "org.freedesktop.impl.portal.RemoteDesktop")]
impl RemoteDesktop {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        2
    }

    #[zbus(property, name = "AvailableDeviceTypes")]
    fn available_device_types(&self) -> u32 {
        AVAILABLE_DEVICES
    }

    async fn create_session(
        &self,
        handle: ObjectPath<'_>,
        session_handle: ObjectPath<'_>,
        app_id: String,
        _options: HashMap<String, OwnedValue>,
        #[zbus(object_server)] server: &zbus::ObjectServer,
    ) -> zbus::fdo::Result<(u32, HashMap<String, OwnedValue>)> {
        tracing::info!(%handle, %session_handle, %app_id, "RemoteDesktop.CreateSession");
        let session = SessionImpl {
            session_key: session_handle.to_string(),
            inner: self.inner.clone(),
        };
        server
            .at(&session_handle, session)
            .await
            .map_err(|e| zbus::fdo::Error::Failed(format!("export session object: {e}")))?;
        self.inner
            .sessions
            .lock()
            .unwrap()
            .insert(session_handle.to_string(), Session::default());
        Ok((RESPONSE_SUCCESS, HashMap::new()))
    }

    async fn select_devices(
        &self,
        handle: ObjectPath<'_>,
        session_handle: ObjectPath<'_>,
        app_id: String,
        options: HashMap<String, OwnedValue>,
    ) -> zbus::fdo::Result<(u32, HashMap<String, OwnedValue>)> {
        let requested = option_u32(&options, "types").unwrap_or(AVAILABLE_DEVICES);
        let persist_mode = option_u32(&options, "persist_mode").unwrap_or(0);
        let restored = options.get("restore_data").is_some_and(is_our_restore_data);
        tracing::info!(
            %handle, %session_handle, %app_id, requested, persist_mode, restored,
            "RemoteDesktop.SelectDevices"
        );
        let mut sessions = self.inner.sessions.lock().unwrap();
        let Some(session) = sessions.get_mut(session_handle.as_str()) else {
            return Ok((RESPONSE_OTHER, HashMap::new()));
        };
        session.devices = requested & AVAILABLE_DEVICES;
        session.persist_mode = persist_mode;
        session.restored = restored;
        Ok((RESPONSE_SUCCESS, HashMap::new()))
    }

    async fn start(
        &self,
        handle: ObjectPath<'_>,
        session_handle: ObjectPath<'_>,
        app_id: String,
        _parent_window: String,
        _options: HashMap<String, OwnedValue>,
    ) -> zbus::fdo::Result<(u32, HashMap<String, OwnedValue>)> {
        let (devices, persist_mode, restored) = {
            let sessions = self.inner.sessions.lock().unwrap();
            let Some(session) = sessions.get(session_handle.as_str()) else {
                return Ok((RESPONSE_OTHER, HashMap::new()));
            };
            (session.devices, session.persist_mode, session.restored)
        };
        tracing::info!(%handle, %session_handle, %app_id, devices, restored, "RemoteDesktop.Start");

        // A session with no devices has nothing to ask about. Otherwise only
        // an earlier "Allow" for this app (carried in restore_data) skips the
        // question.
        if devices != 0 && !restored {
            let allowed = self
                .inner
                .picker
                .ask_remote_control(display_name(&app_id))
                .await;
            if !allowed {
                tracing::info!(%session_handle, %app_id, "remote control denied");
                return Ok((RESPONSE_CANCELLED, HashMap::new()));
            }
        }

        let mut sessions = self.inner.sessions.lock().unwrap();
        let Some(session) = sessions.get_mut(session_handle.as_str()) else {
            // Closed while the dialog was open.
            return Ok((RESPONSE_OTHER, HashMap::new()));
        };
        session.started = true;

        let mut results = HashMap::new();
        results.insert("devices".to_string(), OwnedValue::from(devices));
        results.insert("clipboard_enabled".to_string(), OwnedValue::from(false));
        if persist_mode != 0
            && let Some(blob) = restore_data(devices)
        {
            results.insert("persist_mode".to_string(), OwnedValue::from(persist_mode));
            results.insert("restore_data".to_string(), blob);
        }
        tracing::info!(%session_handle, %app_id, devices, "remote control started");
        Ok((RESPONSE_SUCCESS, results))
    }

    #[zbus(name = "ConnectToEIS")]
    async fn connect_to_eis(
        &self,
        session_handle: ObjectPath<'_>,
        app_id: String,
        _options: HashMap<String, OwnedValue>,
    ) -> zbus::fdo::Result<zvariant::OwnedFd> {
        {
            let sessions = self.inner.sessions.lock().unwrap();
            let Some(session) = sessions.get(session_handle.as_str()) else {
                return Err(zbus::fdo::Error::Failed("unknown session".to_string()));
            };
            if !session.started {
                return Err(zbus::fdo::Error::AccessDenied(
                    "session not started".to_string(),
                ));
            }
        }
        let stream = connect_to_compositor()?;
        tracing::info!(%session_handle, %app_id, "RemoteDesktop.ConnectToEIS: handed out a connection");
        Ok(zvariant::OwnedFd::from(std::os::fd::OwnedFd::from(stream)))
    }

    async fn notify_pointer_motion(
        &self,
        session_handle: ObjectPath<'_>,
        _options: HashMap<String, OwnedValue>,
        dx: f64,
        dy: f64,
    ) -> zbus::fdo::Result<()> {
        self.inner.notify(
            &session_handle,
            device_types::POINTER,
            notify::Command::Motion { dx, dy },
        )
    }

    async fn notify_pointer_motion_absolute(
        &self,
        _session_handle: ObjectPath<'_>,
        _options: HashMap<String, OwnedValue>,
        _stream: u32,
        _x: f64,
        _y: f64,
    ) -> zbus::fdo::Result<()> {
        // Positions are relative to a ScreenCast stream, and a RemoteDesktop
        // session here never has one. The frontend rejects these calls first.
        Err(zbus::fdo::Error::NotSupported(
            "absolute motion needs a screen cast stream".to_string(),
        ))
    }

    async fn notify_pointer_button(
        &self,
        session_handle: ObjectPath<'_>,
        _options: HashMap<String, OwnedValue>,
        button: i32,
        state: u32,
    ) -> zbus::fdo::Result<()> {
        self.inner.notify(
            &session_handle,
            device_types::POINTER,
            notify::Command::Button {
                button: button as u32,
                pressed: state != 0,
            },
        )
    }

    async fn notify_pointer_axis(
        &self,
        session_handle: ObjectPath<'_>,
        options: HashMap<String, OwnedValue>,
        dx: f64,
        dy: f64,
    ) -> zbus::fdo::Result<()> {
        self.inner.notify(
            &session_handle,
            device_types::POINTER,
            notify::Command::Axis {
                dx,
                dy,
                finish: option_bool(&options, "finish"),
            },
        )
    }

    async fn notify_pointer_axis_discrete(
        &self,
        session_handle: ObjectPath<'_>,
        _options: HashMap<String, OwnedValue>,
        axis: u32,
        steps: i32,
    ) -> zbus::fdo::Result<()> {
        self.inner.notify(
            &session_handle,
            device_types::POINTER,
            notify::Command::AxisDiscrete {
                horizontal: axis == 1,
                steps,
            },
        )
    }

    async fn notify_keyboard_keycode(
        &self,
        session_handle: ObjectPath<'_>,
        _options: HashMap<String, OwnedValue>,
        keycode: i32,
        state: u32,
    ) -> zbus::fdo::Result<()> {
        self.inner.notify(
            &session_handle,
            device_types::KEYBOARD,
            notify::Command::Keycode {
                key: keycode as u32,
                pressed: state != 0,
            },
        )
    }

    async fn notify_keyboard_keysym(
        &self,
        session_handle: ObjectPath<'_>,
        _options: HashMap<String, OwnedValue>,
        keysym: i32,
        state: u32,
    ) -> zbus::fdo::Result<()> {
        self.inner.notify(
            &session_handle,
            device_types::KEYBOARD,
            notify::Command::Keysym {
                keysym: keysym as u32,
                pressed: state != 0,
            },
        )
    }

    async fn notify_touch_down(
        &self,
        _session_handle: ObjectPath<'_>,
        _options: HashMap<String, OwnedValue>,
        _stream: u32,
        _slot: u32,
        _x: f64,
        _y: f64,
    ) -> zbus::fdo::Result<()> {
        Err(zbus::fdo::Error::NotSupported("touch is not offered".to_string()))
    }

    async fn notify_touch_motion(
        &self,
        _session_handle: ObjectPath<'_>,
        _options: HashMap<String, OwnedValue>,
        _stream: u32,
        _slot: u32,
        _x: f64,
        _y: f64,
    ) -> zbus::fdo::Result<()> {
        Err(zbus::fdo::Error::NotSupported("touch is not offered".to_string()))
    }

    async fn notify_touch_up(
        &self,
        _session_handle: ObjectPath<'_>,
        _options: HashMap<String, OwnedValue>,
        _slot: u32,
    ) -> zbus::fdo::Result<()> {
        Err(zbus::fdo::Error::NotSupported("touch is not offered".to_string()))
    }
}

/// Replays `Notify*` calls on a libei sender connection to the compositor.
mod notify {
    use std::collections::HashMap;
    use std::os::unix::net::UnixStream;

    use futures_util::StreamExt;
    use reis::ei;
    use reis::event::{Connection, Device, DeviceCapability, EiEvent};
    use tokio::sync::mpsc;
    use xkbcommon::xkb;

    /// evdev codes for the modifiers a keysym may need.
    const KEY_LEFTSHIFT: u32 = 42;
    const KEY_LEFTCTRL: u32 = 29;
    const KEY_LEFTALT: u32 = 56;
    const KEY_RIGHTALT: u32 = 100;

    #[derive(Debug)]
    pub enum Command {
        Motion { dx: f64, dy: f64 },
        Button { button: u32, pressed: bool },
        Axis { dx: f64, dy: f64, finish: bool },
        AxisDiscrete { horizontal: bool, steps: i32 },
        Keycode { key: u32, pressed: bool },
        Keysym { keysym: u32, pressed: bool },
    }

    /// Start the replay connection. It ends, closing its EIS connection, when
    /// the returned sender is dropped or the compositor goes away.
    ///
    /// reis' event stream and the xkb keymap are not `Send`, so each
    /// connection gets its own thread with a single-threaded runtime rather
    /// than a task on the shared pool. Sessions are few and long-lived.
    pub fn spawn(stream: UnixStream) -> std::io::Result<mpsc::UnboundedSender<Command>> {
        let context = ei::Context::new(stream)?;
        let (sender, receiver) = mpsc::unbounded_channel();
        std::thread::Builder::new()
            .name("portal-eis-notify".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_io()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(e) => {
                        tracing::warn!("Notify replay runtime: {e}");
                        return;
                    }
                };
                if let Err(e) = runtime.block_on(run(context, receiver)) {
                    tracing::warn!("Notify replay connection ended: {e}");
                }
            })?;
        Ok(sender)
    }

    #[derive(Default)]
    struct Devices {
        pointer: Option<Device>,
        keyboard: Option<Device>,
        keymap: Option<xkb::Keymap>,
        /// Devices the compositor has resumed and we started emulating on.
        emulating: Vec<Device>,
        sequence: u32,
        /// Modifiers pressed for each held keysym, released with it.
        held_keysyms: HashMap<u32, (u32, Vec<u32>)>,
    }

    async fn run(
        context: ei::Context,
        mut commands: mpsc::UnboundedReceiver<Command>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (connection, mut events) = context
            .handshake_tokio("xdg-desktop-portal-shojiwm", ei::handshake::ContextType::Sender)
            .await?;
        let mut devices = Devices::default();
        // Commands that arrive before the devices are ready wait here, so the
        // first click of a session is not lost.
        let mut pending: Vec<Command> = Vec::new();

        loop {
            tokio::select! {
                event = events.next() => {
                    let Some(event) = event else { return Ok(()) };
                    handle_event(&connection, &mut devices, event?);
                    if !pending.is_empty() && ready(&devices) {
                        for command in pending.drain(..) {
                            send(&connection, &mut devices, command);
                        }
                    }
                }
                command = commands.recv() => {
                    let Some(command) = command else { return Ok(()) };
                    if ready(&devices) {
                        send(&connection, &mut devices, command);
                    } else {
                        pending.push(command);
                    }
                }
            }
            connection.flush()?;
        }
    }

    fn ready(devices: &Devices) -> bool {
        devices.pointer.is_some()
            && devices.keyboard.is_some()
            && devices.emulating.len() >= 2
    }

    fn handle_event(connection: &Connection, devices: &mut Devices, event: EiEvent) {
        match event {
            EiEvent::SeatAdded(added) => {
                added.seat.bind_capabilities(
                    DeviceCapability::Pointer
                        | DeviceCapability::Button
                        | DeviceCapability::Scroll
                        | DeviceCapability::Keyboard,
                );
            }
            EiEvent::DeviceAdded(added) => {
                let device = added.device;
                if device.has_capability(DeviceCapability::Pointer) {
                    devices.pointer = Some(device.clone());
                }
                if device.has_capability(DeviceCapability::Keyboard) {
                    devices.keymap = device.keymap().and_then(load_keymap);
                    devices.keyboard = Some(device);
                }
            }
            EiEvent::DeviceRemoved(removed) => {
                devices.emulating.retain(|d| *d != removed.device);
                if devices.pointer.as_ref() == Some(&removed.device) {
                    devices.pointer = None;
                }
                if devices.keyboard.as_ref() == Some(&removed.device) {
                    devices.keyboard = None;
                    devices.keymap = None;
                }
            }
            EiEvent::DeviceResumed(resumed) => {
                resumed
                    .device
                    .device()
                    .start_emulating(connection.serial(), devices.sequence);
                devices.sequence = devices.sequence.wrapping_add(1);
                if !devices.emulating.contains(&resumed.device) {
                    devices.emulating.push(resumed.device);
                }
            }
            EiEvent::DevicePaused(paused) => {
                devices.emulating.retain(|d| *d != paused.device);
            }
            EiEvent::Disconnected(disconnected) => {
                tracing::info!(reason = ?disconnected.reason, "EIS server disconnected the replay connection");
            }
            _ => {}
        }
    }

    fn load_keymap(keymap: &reis::event::Keymap) -> Option<xkb::Keymap> {
        if keymap.type_ != ei::keyboard::KeymapType::Xkb {
            return None;
        }
        let fd = keymap.fd.try_clone().ok()?;
        let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        // SAFETY: the fd is a sealed keymap file the compositor sent for
        // exactly this purpose; xkbcommon maps it read-only.
        unsafe {
            xkb::Keymap::new_from_fd(
                &context,
                fd,
                keymap.size as usize,
                xkb::KEYMAP_FORMAT_TEXT_V1,
                xkb::COMPILE_NO_FLAGS,
            )
        }
        .ok()
        .flatten()
    }

    fn now_us() -> u64 {
        let ts = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
        ts.tv_sec as u64 * 1_000_000 + ts.tv_nsec as u64 / 1_000
    }

    fn frame(connection: &Connection, device: &Device) {
        device.device().frame(connection.serial(), now_us());
    }

    fn key(connection: &Connection, keyboard: &Device, key: u32, pressed: bool) {
        let Some(interface) = keyboard.interface::<ei::Keyboard>() else {
            return;
        };
        let state = if pressed {
            ei::keyboard::KeyState::Press
        } else {
            ei::keyboard::KeyState::Released
        };
        interface.key(key, state);
        frame(connection, keyboard);
    }

    fn send(connection: &Connection, devices: &mut Devices, command: Command) {
        match command {
            Command::Motion { dx, dy } => {
                let Some(pointer) = &devices.pointer else { return };
                if let Some(interface) = pointer.interface::<ei::Pointer>() {
                    interface.motion_relative(dx as f32, dy as f32);
                    frame(connection, pointer);
                }
            }
            Command::Button { button, pressed } => {
                let Some(pointer) = &devices.pointer else { return };
                if let Some(interface) = pointer.interface::<ei::Button>() {
                    let state = if pressed {
                        ei::button::ButtonState::Press
                    } else {
                        ei::button::ButtonState::Released
                    };
                    interface.button(button, state);
                    frame(connection, pointer);
                }
            }
            Command::Axis { dx, dy, finish } => {
                let Some(pointer) = &devices.pointer else { return };
                if let Some(interface) = pointer.interface::<ei::Scroll>() {
                    if dx != 0.0 || dy != 0.0 {
                        interface.scroll(dx as f32, dy as f32);
                    }
                    if finish {
                        interface.scroll_stop(1, 1, 0);
                    }
                    frame(connection, pointer);
                }
            }
            Command::AxisDiscrete { horizontal, steps } => {
                let Some(pointer) = &devices.pointer else { return };
                if let Some(interface) = pointer.interface::<ei::Scroll>() {
                    // One wheel detent is 120 in the discrete scroll unit.
                    let amount = steps.saturating_mul(120);
                    if horizontal {
                        interface.scroll_discrete(amount, 0);
                    } else {
                        interface.scroll_discrete(0, amount);
                    }
                    frame(connection, pointer);
                }
            }
            Command::Keycode { key: code, pressed } => {
                let Some(keyboard) = &devices.keyboard else { return };
                key(connection, keyboard, code, pressed);
            }
            Command::Keysym { keysym, pressed } => {
                let Some(keyboard) = devices.keyboard.clone() else { return };
                if pressed {
                    let Some((code, modifiers)) = devices
                        .keymap
                        .as_ref()
                        .and_then(|keymap| keysym_to_key(keymap, keysym))
                    else {
                        tracing::warn!(keysym, "no key produces this keysym in the current keymap");
                        return;
                    };
                    for modifier in &modifiers {
                        key(connection, &keyboard, *modifier, true);
                    }
                    key(connection, &keyboard, code, true);
                    devices.held_keysyms.insert(keysym, (code, modifiers));
                } else if let Some((code, modifiers)) = devices.held_keysyms.remove(&keysym) {
                    key(connection, &keyboard, code, false);
                    for modifier in modifiers.iter().rev() {
                        key(connection, &keyboard, *modifier, false);
                    }
                }
            }
        }
    }

    /// The evdev key and the modifier keys that type `keysym` in the first
    /// layout of `keymap`. Prefers the lowest shift level, so 'a' is typed
    /// without Shift and 'A' with it.
    fn keysym_to_key(keymap: &xkb::Keymap, keysym: u32) -> Option<(u32, Vec<u32>)> {
        let wanted = xkb::Keysym::new(keysym);
        let mut best: Option<(u32, Vec<u32>, u32)> = None;
        for raw in keymap.min_keycode().raw()..=keymap.max_keycode().raw() {
            let keycode = xkb::Keycode::new(raw);
            for level in 0..keymap.num_levels_for_key(keycode, 0) {
                if !keymap
                    .key_get_syms_by_level(keycode, 0, level)
                    .contains(&wanted)
                {
                    continue;
                }
                if best.as_ref().is_some_and(|(_, _, best_level)| *best_level <= level) {
                    break;
                }
                let mut masks = [0 as xkb::ModMask; 16];
                let count = keymap.key_get_mods_for_level(keycode, 0, level, &mut masks);
                if let Some(modifiers) = masks[..count]
                    .iter()
                    .find_map(|mask| modifier_keys(keymap, *mask))
                {
                    // evdev codes are xkb keycodes minus 8.
                    best = Some((raw - 8, modifiers, level));
                }
            }
        }
        best.map(|(code, modifiers, _)| (code, modifiers))
    }

    /// The keys to hold for `mask`, or None if it needs a modifier we cannot
    /// press with a plain key (Lock, NumLock, ...).
    fn modifier_keys(keymap: &xkb::Keymap, mask: xkb::ModMask) -> Option<Vec<u32>> {
        let mut keys = Vec::new();
        for index in 0..keymap.num_mods() {
            if mask & (1 << index) == 0 {
                continue;
            }
            let key = match keymap.mod_get_name(index) {
                xkb::MOD_NAME_SHIFT => KEY_LEFTSHIFT,
                xkb::MOD_NAME_CTRL => KEY_LEFTCTRL,
                xkb::MOD_NAME_ALT => KEY_LEFTALT,
                // AltGr on the common layouts.
                "Mod5" | "LevelThree" => KEY_RIGHTALT,
                _ => return None,
            };
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        Some(keys)
    }
}
