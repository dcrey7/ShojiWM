//! `kde_output_order_v1` server (KDE's kde-output-order-v1.xml).
//!
//! The protocol tells plasmashell the order of the outputs: it sends one
//! `output` event per output name, then `done`. plasmashell puts its desktop
//! and panels only on the outputs in this list. Plasma 6.7 fell back to Qt's
//! screen list when the compositor had no such global. Plasma 6.8 does not, so
//! without it the desktop stays empty (no wallpaper, no panel).
//!
//! The list holds every output that has a `wl_output` global, in the order the
//! globals were created. That is the order Qt reported before, so a panel
//! stays on the same screen as under Plasma 6.7.

use smithay::reexports::wayland_server::{
    Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource, backend::ClientId,
};
use wayland_protocols_plasma::output_order::v1::server::kde_output_order_v1::{
    self, KdeOutputOrderV1,
};

use crate::state::ShojiWM;

const VERSION: u32 = 1;

pub struct OutputOrderState {
    /// Output names, in the order their `wl_output` globals were created.
    names: Vec<String>,
    /// Every bound `kde_output_order_v1` object. Each gets the new list on a change.
    instances: Vec<KdeOutputOrderV1>,
}

impl OutputOrderState {
    pub fn new(display: &DisplayHandle) -> Self {
        display.create_global::<ShojiWM, KdeOutputOrderV1, _>(VERSION, ());
        Self {
            names: Vec::new(),
            instances: Vec::new(),
        }
    }

    /// An output got its `wl_output` global: add it at the end of the list.
    pub fn add_output(&mut self, name: &str) {
        if self.names.iter().any(|known| known == name) {
            return;
        }
        self.names.push(name.to_owned());
        self.send_to_all();
    }

    /// An output lost its `wl_output` global: take it out of the list.
    pub fn remove_output(&mut self, name: &str) {
        let count = self.names.len();
        self.names.retain(|known| known != name);
        if self.names.len() != count {
            self.send_to_all();
        }
    }

    fn send_to_all(&mut self) {
        self.instances.retain(|instance| instance.is_alive());
        for instance in &self.instances {
            send_order(instance, &self.names);
        }
    }
}

fn send_order(instance: &KdeOutputOrderV1, names: &[String]) {
    for name in names {
        instance.output(name.clone());
    }
    instance.done();
}

impl GlobalDispatch<KdeOutputOrderV1, ()> for ShojiWM {
    fn bind(
        state: &mut Self,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<KdeOutputOrderV1>,
        _global_data: &(),
        data_init: &mut DataInit<'_, Self>,
    ) {
        // The protocol says: send the list as soon as the global is bound.
        let instance = data_init.init(resource, ());
        send_order(&instance, &state.output_order_state.names);
        state.output_order_state.instances.push(instance);
    }
}

impl Dispatch<KdeOutputOrderV1, ()> for ShojiWM {
    fn request(
        _state: &mut Self,
        _client: &Client,
        _resource: &KdeOutputOrderV1,
        _request: kde_output_order_v1::Request,
        _data: &(),
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, Self>,
    ) {
        // The only request is `destroy`. `destroyed` below forgets the object.
    }

    fn destroyed(state: &mut Self, _client: ClientId, resource: &KdeOutputOrderV1, _data: &()) {
        state
            .output_order_state
            .instances
            .retain(|instance| instance.id() != resource.id());
    }
}
