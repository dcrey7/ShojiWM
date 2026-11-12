#!/usr/bin/env python3
"""Copy Wayland clipboard text to the X11 clipboard (for Chrome and other X11 apps).

Why: the bridge inside ShojiWM (xwayland-satellite) can get stuck. Then X11
apps keep pasting an old text, whatever you copy in a Wayland app such as
Konsole. This helper skips that bridge:

  Konsole copy -> Wayland clipboard -> (this helper, every 0.3 s) -> X11 CLIPBOARD -> Chrome

It only handles text. It reads the Wayland clipboard with `wl-paste` and owns
the X11 CLIPBOARD with python-xlib. When an X11 app copies, it takes the X11
clipboard back, and this helper waits for the next Wayland copy.

Run: uv run --no-project --with python-xlib python3 clip-x11-sync.py
"""

import os
import select
import subprocess
import time

from Xlib import X, Xatom, display
from Xlib.protocol import event as xevent

POLL_S = 0.3
TEXT_TYPES = ("text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING", "TEXT")
ENV = dict(os.environ, WAYLAND_DISPLAY=os.environ.get("WAYLAND_DISPLAY", "wayland-1"))


def run_while_serving(args: list[str], serve) -> bytes | None:
    """Run a command and keep answering X11 requests until it ends.

    The bridge can mirror our X11 clipboard back to Wayland, so `wl-paste`
    may end up asking this helper for the text. Blocking here would then
    deadlock; serving X11 while we wait avoids that.
    """
    try:
        proc = subprocess.Popen(args, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError:
        return None
    deadline = time.monotonic() + 2
    while proc.poll() is None:
        serve()
        if time.monotonic() > deadline:
            proc.kill()
            proc.wait()
            return None
        time.sleep(0.005)
    return proc.stdout.read() if proc.stdout else None


def wayland_text(serve) -> bytes | None:
    """The Wayland clipboard text, or None when it holds no text."""
    listing = run_while_serving(["wl-paste", "-l"], serve)
    types = listing.decode(errors="replace").split() if listing else []
    for wanted in ("text/plain;charset=utf-8", "text/plain", "UTF8_STRING"):
        if wanted in types:
            return run_while_serving(["wl-paste", "-n", "-t", wanted], serve)
    return None


def main() -> None:
    d = display.Display()
    window = d.screen().root.create_window(0, 0, 1, 1, 0, X.CopyFromParent)
    clipboard = d.intern_atom("CLIPBOARD")
    targets_atom = d.intern_atom("TARGETS")
    text_atoms = [d.intern_atom(name) for name in TEXT_TYPES]
    owned: dict[str, bytes | None] = {"text": None}

    def serve() -> None:
        """Answer every waiting X11 clipboard request."""
        while d.pending_events():
            event = d.next_event()
            if event.type == X.SelectionClear:
                owned["text"] = None  # an X11 app copied; it owns the clipboard now
            elif event.type == X.SelectionRequest:
                text = owned["text"]
                reply_property = event.property or event.target
                if text is not None and event.target == targets_atom:
                    event.requestor.change_property(reply_property, Xatom.ATOM, 32, [targets_atom, *text_atoms])
                elif text is not None and event.target in text_atoms:
                    event.requestor.change_property(reply_property, event.target, 8, text)
                else:
                    reply_property = X.NONE
                notify = xevent.SelectionNotify(
                    time=event.time,
                    requestor=event.requestor,
                    selection=event.selection,
                    target=event.target,
                    property=reply_property,
                )
                event.requestor.send_event(notify)
                d.flush()

    last_seen: bytes | None = None  # sync the current text at start
    next_poll = 0.0
    while True:
        now = time.monotonic()
        if now >= next_poll:
            next_poll = now + POLL_S
            text = wayland_text(serve)
            # Take the X11 clipboard only when the Wayland text is new.
            if text and text != last_seen:
                last_seen = text
                owned["text"] = text
                window.set_selection_owner(clipboard, X.CurrentTime)
                d.flush()
        serve()
        select.select([d.fileno()], [], [], POLL_S / 3)


if __name__ == "__main__":
    main()
