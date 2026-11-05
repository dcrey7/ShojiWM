#!/usr/bin/env python3
"""Tell the config which title bar look the user picked: "aero" or "mac".

The config has no file reading of its own, so this helper reads the choice
and sends it over the IPC socket as "theme.set" {"titlebar": ...}:

    System Settings > Global Theme ──> ~/.config/kdeglobals
                                        [KDE] LookAndFeelPackage
                 shoji-theme script ──> ~/.config/shojiwm/theme.json
                                        {"titlebar": "aero" | "mac"}
                        this helper ──"theme.set"──> config: title bars redraw

kdeglobals wins when it names one of our two Global Themes; else theme.json;
else "aero". The helper looks at the files' change times every half second
(a stat, nothing more) and sends the look when it changes, and again when
the socket is new (the config reloaded and forgot it).

Usage: theme-watch.py [IPC socket path]
"""

import configparser
import json
import os
import socket
import sys
import time

CONFIG_HOME = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
KDEGLOBALS = os.path.join(CONFIG_HOME, "kdeglobals")
THEME_JSON = os.path.join(CONFIG_HOME, "shojiwm", "theme.json")
LOOK_AND_FEEL = {
    "org.shojiwm.aero.desktop": "aero",
    "org.shojiwm.mac.desktop": "mac",
}
STYLES = {"aero", "mac"}
POLL_SECONDS = 0.5


def default_socket_path() -> str:
    runtime = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
    display = os.environ.get("WAYLAND_DISPLAY", "wayland-1")
    return os.path.join(runtime, f"shojiwm-{display}.sock")


SOCKET_PATH = sys.argv[1] if len(sys.argv) > 1 else default_socket_path()


def from_kdeglobals() -> str | None:
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    try:
        parser.read(KDEGLOBALS, encoding="utf-8")
    except (configparser.Error, UnicodeDecodeError):
        return None
    package = parser.get("KDE", "LookAndFeelPackage", fallback="")
    return LOOK_AND_FEEL.get(package.strip())


def from_theme_json() -> str | None:
    try:
        with open(THEME_JSON, encoding="utf-8") as file:
            style = json.load(file).get("titlebar")
    except (OSError, ValueError, AttributeError):
        return None
    return style if style in STYLES else None


def current_style() -> str:
    return from_kdeglobals() or from_theme_json() or "aero"


def stamp(path: str) -> tuple | None:
    """What changes when the file changes (or appears, or goes)."""
    try:
        info = os.stat(path)
    except OSError:
        return None
    return (info.st_ino, info.st_mtime_ns, info.st_size)


def send(style: str) -> bool:
    message = {"id": 1, "method": "theme.set", "params": {"titlebar": style}}
    try:
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(2)
            sock.connect(SOCKET_PATH)
            sock.sendall(json.dumps(message).encode() + b"\n")
            sock.recv(4096)
    except OSError:
        return False
    return True


def main() -> None:
    seen = None
    while True:
        now = (stamp(KDEGLOBALS), stamp(THEME_JSON), stamp(SOCKET_PATH))
        if now != seen and now[2] is not None:
            # Seen only once sent: a failed send tries again next round.
            if send(current_style()):
                seen = now
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
