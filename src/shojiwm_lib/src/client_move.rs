//! Moves that an X11 client drives itself.
//!
//! Chrome on X11 moves a dragged-out tab window on its own: it keeps the
//! pointer, and on every motion it asks the window manager to put the window
//! under the cursor. It must keep the pointer to see the tab strip it is
//! dropped on, so ShojiWM cannot start its own move grab. Instead each request
//! (`SatelliteEvent::MoveRequest`) becomes the same window move event a title
//! bar drag sends, so the config moves the window and plays the jelly drag.
//! The move ends when the left button comes up.

use crate::{
    grabs::{
        follow_focus_grab::FollowFocusGrab,
        move_grab::{point_snapshot, rect_snapshot},
    },
    ssd::{
        PointerModifierStateSnapshot, WindowMoveEventSnapshot, WindowMovePhaseSnapshot,
        WindowMoveSourceSnapshot, WindowPositionSnapshot,
    },
    state::{ClientState, ShojiWM},
};
use smithay::{
    desktop::Window,
    reexports::wayland_server::{protocol::wl_surface::WlSurface, Resource},
    input::pointer::Focus,
    utils::{Logical, Point, Rectangle, SERIAL_COUNTER},
};
use tracing::info;

/// One client-driven move, from the first request to the button release.
pub struct ClientMove {
    window: Window,
    /// The window's frame (decorations included) when the move started.
    start_rect: Rectangle<i32, Logical>,
    /// The client area's top-left corner inside the frame (the title bar
    /// height, the border). Requests are for the client area, the move event
    /// is for the frame.
    client_offset: Point<i32, Logical>,
    start_pointer: Point<f64, Logical>,
    last_rect: WindowPositionSnapshot,
    /// The pointer's place on the frame, from Chrome's first request (the
    /// tab it holds), kept inside the frame. Later requests only say the
    /// drag goes on: the frame follows the real pointer.
    grab: Option<Point<f64, Logical>>,
    /// Requests seen, to log only some of them.
    updates: u32,
}

/// The grab point stays at least this far inside the frame's sides.
const GRAB_MARGIN: f64 = 40.0;

/// True for a surface of the embedded xwayland-satellite, i.e. an X11 window.
pub fn is_satellite_surface(surface: &WlSurface) -> bool {
    surface.client().is_some_and(|client| {
        client
            .get_data::<ClientState>()
            .is_some_and(|data| data.xwayland_refresh_override)
    })
}

impl ShojiWM {
    /// An X11 toplevel asked to be at `x`/`y` (logical, from the top-left
    /// corner of all outputs). Honoured only while the left button is held,
    /// which is when Chrome drags a tab window; at other times X11 windows stay
    /// where the layout puts them.
    pub fn x11_client_move_request(&mut self, surface_id: u32, x: i32, y: i32) {
        if !self.left_button_held {
            return;
        }
        let Some(window) = self.satellite_window(surface_id) else {
            return;
        };
        let Some(origin) = self.outputs_origin() else {
            return;
        };
        let requested = Point::<i32, Logical>::from((x + origin.x, y + origin.y));

        if self
            .client_move
            .as_ref()
            .is_some_and(|client_move| client_move.window != window)
        {
            self.end_client_move();
        }
        if self.client_move.is_none() && !self.start_client_move(window) {
            return;
        }
        self.update_client_move(requested);
    }

    /// The left button came up: finish the client-driven move, if any.
    pub fn end_client_move(&mut self) {
        let Some(client_move) = self.client_move.take() else {
            return;
        };
        let pointer = self.pointer_location();
        info!(rect = ?client_move.last_rect, ?pointer, "client move end");
        let event = self.client_move_event(
            &client_move,
            WindowMovePhaseSnapshot::End,
            client_move.last_rect.clone(),
            pointer,
        );
        self.send_client_move_event(&client_move.window, &event);
    }

    /// A window is gone: drop its move without an event, the close handles it.
    pub fn forget_client_move(&mut self, surface: &WlSurface) {
        if self.client_move.as_ref().is_some_and(|client_move| {
            client_move
                .window
                .toplevel()
                .is_some_and(|toplevel| toplevel.wl_surface() == surface)
        }) {
            self.client_move = None;
        }
    }

    /// Keep the held button's pointer coordinates counted from where the
    /// pressed window is now, not where it was at the press: the tiling
    /// moves it to make room (see `FollowFocusGrab`).
    fn follow_pressed_window(&mut self) {
        let Some(pointer) = self.seat.get_pointer() else {
            return;
        };
        let Some(start_data) = pointer.grab_start_data() else {
            return;
        };
        let Some((surface, press_origin)) = start_data.focus.clone() else {
            return;
        };
        if !is_satellite_surface(&surface) {
            return;
        }
        let Some(window) = self
            .space
            .elements()
            .find(|window| {
                window
                    .toplevel()
                    .is_some_and(|toplevel| toplevel.wl_surface() == &surface)
            })
            .cloned()
        else {
            return;
        };
        info!(
            ?press_origin,
            now = ?self.space.element_location(&window),
            "client move: pointer follows the pressed window"
        );
        pointer.set_grab(
            self,
            FollowFocusGrab { start_data, window },
            SERIAL_COUNTER.next_serial(),
            Focus::Keep,
        );
    }

    fn start_client_move(&mut self, window: Window) -> bool {
        let Some(decoration) = self.window_decorations.get(&window) else {
            return false;
        };
        let root = decoration.layout.root.rect;
        // From the decoration tree, not the cached `client_rect`: a window
        // that just opened can still carry the client rect of an older
        // layout, and the dragged window then trailed far from the pointer.
        let client = crate::ssd::client_rect_for_frame(decoration, root);
        let client_offset = Point::from((client.x - root.x, client.y - root.y));
        info!(
            ?root,
            cached_client = ?decoration.client_rect,
            ?client,
            pointer = ?self.pointer_location(),
            "client move start"
        );
        let client_move = ClientMove {
            window: window.clone(),
            start_rect: Rectangle::new((root.x, root.y).into(), (root.width, root.height).into()),
            client_offset,
            start_pointer: self.pointer_location(),
            last_rect: rect_snapshot(Rectangle::new(
                (root.x, root.y).into(),
                (root.width, root.height).into(),
            )),
            grab: None,
            updates: 0,
        };
        let event = self.client_move_event(
            &client_move,
            WindowMovePhaseSnapshot::Start,
            client_move.last_rect.clone(),
            client_move.start_pointer,
        );
        if !self.send_client_move_event(&window, &event) {
            // No config handles moves: nothing to do.
            return false;
        }
        self.follow_pressed_window();
        self.client_move = Some(client_move);
        true
    }

    fn update_client_move(&mut self, requested: Point<i32, Logical>) {
        let pointer = self.pointer_location();
        let Some(client_move) = self.client_move.as_mut() else {
            return;
        };
        // Chrome keeps the tab under the pointer where it sat in the old
        // window, which can be wider than this frame, and its requests jump
        // while the tiling moves windows. So take the grab point once, keep
        // it inside the frame, and follow the pointer from then on.
        let size = client_move.start_rect.size;
        let grab = *client_move.grab.get_or_insert_with(|| {
            let requested_frame = (requested - client_move.client_offset).to_f64();
            let grab = pointer - requested_frame;
            let clamp = |value: f64, length: i32| {
                value.clamp(GRAB_MARGIN.min(length as f64 / 2.0), (length as f64 - GRAB_MARGIN).max(length as f64 / 2.0))
            };
            Point::from((clamp(grab.x, size.w), clamp(grab.y, size.h)))
        });
        let frame = pointer - grab;
        client_move.updates += 1;
        if client_move.updates % 20 == 1 {
            info!(?requested, ?frame, ?grab, ?pointer, "client move update");
        }
        let rect = WindowPositionSnapshot {
            x: frame.x,
            y: frame.y,
            width: client_move.start_rect.size.w as f64,
            height: client_move.start_rect.size.h as f64,
        };
        if rect == client_move.last_rect {
            return;
        }
        client_move.last_rect = rect.clone();
        let window = client_move.window.clone();
        let client_move = self.client_move.as_ref().unwrap();
        let event =
            self.client_move_event(client_move, WindowMovePhaseSnapshot::Update, rect, pointer);
        self.send_client_move_event(&window, &event);
    }

    fn client_move_event(
        &self,
        client_move: &ClientMove,
        phase: WindowMovePhaseSnapshot,
        current_rect: WindowPositionSnapshot,
        pointer: Point<f64, Logical>,
    ) -> WindowMoveEventSnapshot {
        let output_name = self
            .space
            .outputs()
            .find(|output| {
                self.space
                    .output_geometry(output)
                    .is_some_and(|geometry| geometry.contains(pointer.to_i32_floor()))
            })
            .map(|output| output.name());
        WindowMoveEventSnapshot {
            // The client asked for the move, like `xdg_toplevel.move`.
            source: WindowMoveSourceSnapshot::ClientCsd,
            phase,
            start_pointer: point_snapshot(client_move.start_pointer),
            current_pointer: point_snapshot(pointer),
            delta: point_snapshot(pointer - client_move.start_pointer),
            start_rect: rect_snapshot(client_move.start_rect),
            current_rect,
            output_name,
            modifiers: PointerModifierStateSnapshot {
                logo: self.current_keyboard_modifiers.logo,
                alt: self.current_keyboard_modifiers.alt,
                ctrl: self.current_keyboard_modifiers.ctrl,
                shift: self.current_keyboard_modifiers.shift,
            },
            timestamp: std::time::Duration::from(self.clock.now()).as_millis() as u64,
        }
    }

    fn send_client_move_event(&mut self, window: &Window, event: &WindowMoveEventSnapshot) -> bool {
        let window_id = self.snapshot_window(window).id;
        let now_ms = std::time::Duration::from(self.clock.now()).as_millis() as u64;
        self.invoke_window_move_event(&window_id, event, now_ms)
    }

    fn satellite_window(&self, surface_id: u32) -> Option<Window> {
        self.space
            .elements()
            .find(|window| {
                window.toplevel().is_some_and(|toplevel| {
                    let surface = toplevel.wl_surface();
                    surface.id().protocol_id() == surface_id && is_satellite_surface(surface)
                })
            })
            .cloned()
    }

    /// The top-left corner of the box around all outputs (X11's origin).
    pub fn outputs_origin(&self) -> Option<Point<i32, Logical>> {
        self.space
            .outputs()
            .filter_map(|output| self.space.output_geometry(output))
            .map(|geometry| geometry.loc)
            .reduce(|a, b| (a.x.min(b.x), a.y.min(b.y)).into())
    }

    fn pointer_location(&self) -> Point<f64, Logical> {
        self.seat
            .get_pointer()
            .map(|pointer| pointer.current_location())
            .unwrap_or_default()
    }
}
