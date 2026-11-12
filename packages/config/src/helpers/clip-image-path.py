#!/usr/bin/env python3
"""Make a copied image pasteable as a file path (for Claude Code in Konsole).

When the clipboard gets an image, this helper saves it as a PNG file and
takes over the clipboard with ONE offer that holds both forms:

    app copies image ──> helper reads image/png ──> ~/.cache/clip-images/clip-...png
                                                         │
    helper offers:  image/png        = the image bytes   (WhatsApp, GIMP, ...)
                    text/plain, ...  = the file path     (Konsole Ctrl+V -> Claude)
                    text/uri-list    = file:///...png
                    x-shoji-clip-image-path = marker, so the helper skips its own offer

It skips copies with no image (text, Dolphin file copies), password manager
copies (x-kde-passwordManagerHint), and its own offer (the marker type).

The helper talks the Wayland wire format itself, so it needs no packages.
It uses the wlr data-control protocol (zwlr_data_control_manager_v1), the
same one wl-paste --watch and cliphist use. Wire format in short: every
message is [object id: u32][size << 16 | opcode: u32][arguments], little
endian; a string is [length incl. NUL: u32][bytes][NUL][pad to 4 bytes];
a file descriptor travels beside the bytes as SCM_RIGHTS data.

Usage: clip-image-path.py   (WAYLAND_DISPLAY and XDG_RUNTIME_DIR must be set)
"""

import array
import hashlib
import os
import select
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path

CACHE_DIR = Path.home() / ".cache" / "clip-images"
MAX_FILES = 50
MARKER_TYPE = "x-shoji-clip-image-path"
PASSWORD_HINT = "x-kde-passwordManagerHint"
TEXT_TYPES = ["text/plain", "text/plain;charset=utf-8", "UTF8_STRING", "STRING", "TEXT"]
# Image types we read, best first. Anything else "image/*" comes after these.
IMAGE_PREFERENCE = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]
READ_TIMEOUT_S = 3.0  # give up on a source app that stops sending


def log(message):
    print(f"clip-image-path: {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------- wire format


def pack_string(text):
    data = text.encode() + b"\0"
    padding = (4 - len(data) % 4) % 4
    return struct.pack("<I", len(data)) + data + b"\0" * padding


def unpack_string(body, offset):
    (length,) = struct.unpack_from("<I", body, offset)
    text = body[offset + 4 : offset + 4 + length - 1].decode(errors="replace")
    return text, offset + 4 + (length + 3) // 4 * 4


class Wayland:
    """One connection: send requests, read events, hand out object ids."""

    def __init__(self):
        path = os.path.join(os.environ["XDG_RUNTIME_DIR"], os.environ.get("WAYLAND_DISPLAY", "wayland-0"))
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self.next_id = 2  # id 1 is wl_display
        self.buffer = b""
        self.fds = []  # received fds, in order; events that carry one take it

    def new_id(self):
        object_id = self.next_id
        self.next_id += 1
        return object_id

    def send(self, object_id, opcode, args=b"", fd=None):
        size = 8 + len(args)
        message = struct.pack("<II", object_id, size << 16 | opcode) + args
        ancillary = []
        if fd is not None:
            ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))]
        self.sock.sendmsg([message], ancillary)

    def read_events(self):
        """Block until data comes; return a list of (object id, opcode, body)."""
        fd_bytes = socket.CMSG_SPACE(16 * array.array("i").itemsize)
        data, ancillary, _flags, _addr = self.sock.recvmsg(65536, fd_bytes)
        if not data:
            raise ConnectionError("the compositor closed the connection")
        for level, kind, payload in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                fds = array.array("i")
                fds.frombytes(payload[: len(payload) - len(payload) % fds.itemsize])
                self.fds.extend(fds)
        self.buffer += data
        events = []
        while len(self.buffer) >= 8:
            object_id, size_opcode = struct.unpack_from("<II", self.buffer)
            size = size_opcode >> 16
            if len(self.buffer) < size:
                break
            events.append((object_id, size_opcode & 0xFFFF, self.buffer[8:size]))
            self.buffer = self.buffer[size:]
        return events


# ------------------------------------------------------------- image + files


def save_png(png_bytes):
    """Save the PNG once per content; return its path. Keep MAX_FILES files."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    short_hash = hashlib.sha256(png_bytes).hexdigest()[:10]
    existing = sorted(CACHE_DIR.glob(f"clip-*-{short_hash}.png"))
    if existing:
        path = existing[0]
        path.touch()  # now the newest, so the clean-up keeps it
    else:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        path = CACHE_DIR / f"clip-{stamp}-{short_hash}.png"
        temp = path.with_suffix(".tmp")
        temp.write_bytes(png_bytes)
        temp.rename(path)
    files = sorted(CACHE_DIR.glob("clip-*.png"), key=lambda p: p.stat().st_mtime)
    for old in files[:-MAX_FILES]:
        old.unlink(missing_ok=True)
    return path


def to_png(image_bytes, mime_type):
    if mime_type == "image/png":
        return image_bytes
    # [0] takes the first frame of a GIF or other multi-frame image.
    # No date chunks, so the same image always gives the same PNG and hash.
    command = ["magick", "-[0]", "-define", "png:exclude-chunks=date,time", "png:-"]
    result = subprocess.run(command, input=image_bytes, capture_output=True, timeout=20)
    if result.returncode != 0 or not result.stdout:
        raise ValueError(f"magick could not convert {mime_type}")
    return result.stdout


def pick_image_type(mime_types):
    for mime_type in IMAGE_PREFERENCE:
        if mime_type in mime_types:
            return mime_type
    for mime_type in mime_types:
        if mime_type.startswith("image/") and mime_type != "image/svg+xml":
            return mime_type
    return None


def write_all(fd, data):
    """Give the bytes to a pasting app, then close its pipe."""
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
    except OSError:
        pass  # the app closed its end early; nothing to do
    finally:
        os.close(fd)


# ------------------------------------------------------------------ the helper


class ClipImagePath:
    def __init__(self):
        self.wl = Wayland()
        self.kinds = {1: "display"}  # object id -> interface name
        self.offer_types = {}  # offer id -> list of MIME types
        self.seat = None
        self.manager = None
        self.device = None
        self.source = None  # our current data source id
        self.source_data = {}  # MIME type -> bytes our source gives out

    # --- setup

    def connect(self):
        registry = self.wl.new_id()
        self.kinds[registry] = "registry"
        self.wl.send(1, 1, struct.pack("<I", registry))  # wl_display.get_registry
        self.roundtrip()
        if self.seat is None or self.manager is None:
            raise SystemExit("clip-image-path: no wl_seat or zwlr_data_control_manager_v1")
        self.device = self.wl.new_id()
        self.kinds[self.device] = "device"
        # zwlr_data_control_manager_v1.get_data_device(new id, seat)
        self.wl.send(self.manager, 1, struct.pack("<II", self.device, self.seat))

    def roundtrip(self):
        callback = self.wl.new_id()
        self.kinds[callback] = "callback"
        self.wl.send(1, 0, struct.pack("<I", callback))  # wl_display.sync
        while callback in self.kinds:
            self.dispatch(self.wl.read_events())

    def bind(self, name, interface, version):
        object_id = self.wl.new_id()
        args = struct.pack("<I", name) + pack_string(interface) + struct.pack("<II", version, object_id)
        self.wl.send(self.registry_id(), 0, args)  # wl_registry.bind
        return object_id

    def registry_id(self):
        return next(i for i, kind in self.kinds.items() if kind == "registry")

    # --- events

    def dispatch(self, events):
        for object_id, opcode, body in events:
            kind = self.kinds.get(object_id)
            if kind == "display" and opcode == 0:  # error
                _obj, code = struct.unpack_from("<II", body)
                message, _ = unpack_string(body, 8)
                raise SystemExit(f"clip-image-path: Wayland error {code}: {message}")
            elif kind == "display" and opcode == 1:  # delete_id
                pass
            elif kind == "registry" and opcode == 0:  # global
                (name,) = struct.unpack_from("<I", body)
                interface, offset = unpack_string(body, 4)
                (version,) = struct.unpack_from("<I", body, offset)
                if interface == "wl_seat" and self.seat is None:
                    self.seat = self.bind(name, "wl_seat", 1)
                    self.kinds[self.seat] = "seat"
                elif interface == "zwlr_data_control_manager_v1":
                    self.manager = self.bind(name, interface, min(version, 2))
                    self.kinds[self.manager] = "manager"
            elif kind == "callback":  # done
                del self.kinds[object_id]
            elif kind == "device":
                self.on_device_event(opcode, body)
            elif kind == "offer" and opcode == 0:  # offer: one MIME type
                mime_type, _ = unpack_string(body, 0)
                self.offer_types[object_id].append(mime_type)
            elif kind == "source":
                self.on_source_event(object_id, opcode, body)
            # wl_seat events (capabilities, name) need no answer.

    def on_device_event(self, opcode, body):
        if opcode == 0:  # data_offer(new id): MIME types follow, then selection
            (offer,) = struct.unpack_from("<I", body)
            self.kinds[offer] = "offer"
            self.offer_types[offer] = []
        elif opcode == 1:  # selection(offer or 0): the clipboard changed
            (offer,) = struct.unpack_from("<I", body)
            if offer:
                self.on_new_clipboard(offer)
                self.destroy_offer(offer)
        elif opcode == 2:  # finished: the device is gone
            raise SystemExit("clip-image-path: data device finished")
        elif opcode == 3:  # primary_selection: we ignore the middle-click buffer
            (offer,) = struct.unpack_from("<I", body)
            if offer:
                self.destroy_offer(offer)

    def on_source_event(self, source, opcode, body):
        if opcode == 0:  # send(MIME type, fd): an app pastes from us
            mime_type, _ = unpack_string(body, 0)
            fd = self.wl.fds.pop(0)
            data = self.source_data.get(mime_type, b"") if source == self.source else b""
            # A thread, so a slow app never blocks the clipboard watch.
            threading.Thread(target=write_all, args=(fd, data), daemon=True).start()
        elif opcode == 1:  # cancelled: another copy replaced ours
            self.wl.send(source, 1)  # zwlr_data_control_source_v1.destroy
            del self.kinds[source]
            if source == self.source:
                self.source = None
                self.source_data = {}

    def destroy_offer(self, offer):
        self.wl.send(offer, 1)  # zwlr_data_control_offer_v1.destroy
        self.kinds.pop(offer, None)
        self.offer_types.pop(offer, None)

    # --- the work

    def on_new_clipboard(self, offer):
        mime_types = self.offer_types.get(offer, [])
        if MARKER_TYPE in mime_types:  # our own offer: stop here, no loop
            return
        if PASSWORD_HINT in mime_types:
            return
        image_type = pick_image_type(mime_types)
        if image_type is None:  # text, file copies, anything without an image
            return
        try:
            image_bytes = self.receive(offer, image_type)
            png = to_png(image_bytes, image_type)
            path = save_png(png)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            log(f"skipped one copy: {error}")
            return
        self.offer_path(png, path)
        log(f"offered {path}")

    def receive(self, offer, mime_type):
        """Ask the source app for one type and read all bytes it sends."""
        read_end, write_end = os.pipe()
        # zwlr_data_control_offer_v1.receive(MIME type, fd)
        self.wl.send(offer, 0, pack_string(mime_type), fd=write_end)
        os.close(write_end)  # the source app holds its own copy now
        chunks = []
        try:
            while True:
                ready, _, _ = select.select([read_end], [], [], READ_TIMEOUT_S)
                if not ready:
                    raise ValueError(f"no data for {mime_type} after {READ_TIMEOUT_S} s")
                chunk = os.read(read_end, 1 << 20)
                if not chunk:
                    break
                chunks.append(chunk)
        finally:
            os.close(read_end)
        data = b"".join(chunks)
        if not data:
            raise ValueError(f"empty {mime_type}")
        return data

    def offer_path(self, png, path):
        """Take over the clipboard: the image plus its path as text."""
        path_text = str(path).encode()
        data = {"image/png": png, MARKER_TYPE: b"1"}
        data["text/uri-list"] = ("file://" + urllib.parse.quote(str(path))).encode()
        for text_type in TEXT_TYPES:
            data[text_type] = path_text
        source = self.wl.new_id()
        self.kinds[source] = "source"
        # zwlr_data_control_manager_v1.create_data_source(new id)
        self.wl.send(self.manager, 0, struct.pack("<I", source))
        for mime_type in data:
            self.wl.send(source, 0, pack_string(mime_type))  # source.offer
        # zwlr_data_control_device_v1.set_selection(source)
        self.wl.send(self.device, 0, struct.pack("<I", source))
        self.source = source
        self.source_data = data

    def run(self):
        self.connect()
        while True:  # sleeps in recvmsg until the compositor sends something
            self.dispatch(self.wl.read_events())


if __name__ == "__main__":
    ClipImagePath().run()
