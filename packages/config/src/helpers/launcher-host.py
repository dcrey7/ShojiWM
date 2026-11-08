#!/usr/bin/env python3
"""The launcher's host surface: one empty window that ShojiWM draws the launcher on.

The launcher (../launcher.tsx) is drawn by the compositor, as the decoration of
a window. The output composition cannot draw text or blur, but a window
decoration can. So this helper maps one tiny transparent window and never
draws again; the config decorates it with the whole launcher and shows or hides
it in place (no window opens or closes when you press Super).

    this helper ──xdg_toplevel "shoji-launcher" (1x1, transparent)──> ShojiWM
                  plasma role "onscreendisplay", skip taskbar + switcher
    config ──decorates it with the launcher, visible only while open

It speaks the Wayland wire protocol directly (no toolkit, no pywayland), so it
starts in a few ms and uses no CPU while it waits.

Usage: launcher-host.py
"""

import array
import os
import socket
import struct
import sys

APP_ID = "shoji-launcher"
# org_kde_plasma_surface roles (plasma-shell.xml).
ROLE_ONSCREENDISPLAY = 3


class Wayland:
    """A minimal Wayland client: send requests, read events."""

    def __init__(self):
        name = os.environ.get("WAYLAND_DISPLAY", "wayland-0")
        path = name if name.startswith("/") else f"{os.environ['XDG_RUNTIME_DIR']}/{name}"
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self.next_id = 2  # 1 is wl_display
        self.buffer = b""
        self.handlers = {}  # object id -> function(opcode, payload)

    def new_id(self) -> int:
        object_id = self.next_id
        self.next_id += 1
        return object_id

    def send(self, object_id: int, opcode: int, args: bytes = b"", fd: int | None = None):
        header = struct.pack("<II", object_id, ((8 + len(args)) << 16) | opcode)
        if fd is None:
            self.sock.sendall(header + args)
        else:
            fds = array.array("i", [fd])
            self.sock.sendmsg([header + args], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, fds)])

    def read_events(self):
        data = self.sock.recv(65536)
        if not data:
            sys.exit(0)  # the compositor went away
        self.buffer += data
        while len(self.buffer) >= 8:
            object_id, word = struct.unpack_from("<II", self.buffer)
            size, opcode = word >> 16, word & 0xFFFF
            if len(self.buffer) < size:
                break
            payload = self.buffer[8:size]
            self.buffer = self.buffer[size:]
            handler = self.handlers.get(object_id)
            if handler:
                handler(opcode, payload)


def uint(value: int) -> bytes:
    return struct.pack("<I", value)


def sint(value: int) -> bytes:
    return struct.pack("<i", value)


def string(text: str) -> bytes:
    raw = text.encode() + b"\0"
    padding = (4 - len(raw) % 4) % 4
    return uint(len(raw)) + raw + b"\0" * padding


def read_string(payload: bytes, offset: int) -> tuple[str, int]:
    (length,) = struct.unpack_from("<I", payload, offset)
    text = payload[offset + 4 : offset + 4 + length - 1].decode()
    return text, offset + 4 + length + (4 - length % 4) % 4


def main():
    wl = Wayland()
    globals_ = {}  # interface -> (name, version)

    def on_registry(opcode, payload):
        if opcode == 0:  # global
            (name,) = struct.unpack_from("<I", payload)
            interface, offset = read_string(payload, 4)
            (version,) = struct.unpack_from("<I", payload, offset)
            globals_[interface] = (name, version)

    def on_display(opcode, payload):
        if opcode == 0:  # error
            object_id, code = struct.unpack_from("<II", payload)
            message, _ = read_string(payload, 8)
            sys.exit(f"launcher-host: Wayland error on object {object_id} ({code}): {message}")

    wl.handlers[1] = on_display
    registry = wl.new_id()
    wl.handlers[registry] = on_registry
    wl.send(1, 1, uint(registry))  # wl_display.get_registry

    def roundtrip():
        callback = wl.new_id()
        done = []
        wl.handlers[callback] = lambda opcode, payload: done.append(True)
        wl.send(1, 0, uint(callback))  # wl_display.sync
        while not done:
            wl.read_events()

    roundtrip()

    def bind(interface: str, version: int) -> int:
        if interface not in globals_:
            sys.exit(f"launcher-host: the compositor has no {interface}")
        name, offered = globals_[interface]
        object_id = wl.new_id()
        # wl_registry.bind(name, interface, version, new_id)
        wl.send(registry, 0, uint(name) + string(interface) + uint(min(version, offered)) + uint(object_id))
        return object_id

    compositor = bind("wl_compositor", 4)
    shm = bind("wl_shm", 1)
    wm_base = bind("xdg_wm_base", 1)
    plasma_shell = bind("org_kde_plasma_shell", 8)
    plasma_version = min(8, globals_["org_kde_plasma_shell"][1])

    def on_wm_base(opcode, payload):
        if opcode == 0:  # ping
            wl.send(wm_base, 3, payload[:4])  # pong

    wl.handlers[wm_base] = on_wm_base

    surface = wl.new_id()
    wl.send(compositor, 0, uint(surface))  # create_surface

    # A shell surface: no title bar, no tiling, no taskbar entry, no switcher.
    plasma = wl.new_id()
    wl.send(plasma_shell, 0, uint(plasma) + uint(surface))  # get_surface
    wl.send(plasma, 3, uint(ROLE_ONSCREENDISPLAY))  # set_role
    wl.send(plasma, 2, sint(0) + sint(0))  # set_position
    if plasma_version >= 2:
        wl.send(plasma, 5, uint(1))  # set_skip_taskbar
    if plasma_version >= 5:
        wl.send(plasma, 9, uint(1))  # set_skip_switcher

    xdg_surface = wl.new_id()
    wl.send(wm_base, 2, uint(xdg_surface) + uint(surface))  # get_xdg_surface
    toplevel = wl.new_id()
    wl.send(xdg_surface, 1, uint(toplevel))  # get_toplevel
    wl.send(toplevel, 2, string("Launcher"))  # set_title
    wl.send(toplevel, 3, string(APP_ID))  # set_app_id

    # One transparent pixel, attached once.
    fd = os.memfd_create("shoji-launcher", 0)
    os.ftruncate(fd, 4)
    pool = wl.new_id()
    wl.send(shm, 0, uint(pool) + sint(4), fd=fd)  # create_pool(id, fd, size)
    buffer = wl.new_id()
    # create_buffer(id, offset, width, height, stride, format ARGB8888)
    wl.send(pool, 0, uint(buffer) + sint(0) + sint(1) + sint(1) + sint(4) + uint(0))

    attached = []

    def on_xdg_surface(opcode, payload):
        if opcode != 0:  # configure
            return
        wl.send(xdg_surface, 4, payload[:4])  # ack_configure
        if not attached:
            attached.append(True)
            wl.send(surface, 1, uint(buffer) + sint(0) + sint(0))  # attach
            wl.send(surface, 2, sint(0) + sint(0) + sint(1) + sint(1))  # damage
        wl.send(surface, 6)  # commit

    wl.handlers[xdg_surface] = on_xdg_surface
    # The toplevel's configure (size) and close are ignored: the window stays.
    wl.send(surface, 6)  # the first commit, without a buffer
    while True:
        wl.read_events()


if __name__ == "__main__":
    main()
