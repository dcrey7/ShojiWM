"""Read the X11 CLIPBOARD: owner, targets, and the UTF8_STRING text."""

import time

from Xlib import X, display

d = display.Display()
w = d.screen().root.create_window(0, 0, 1, 1, 0, X.CopyFromParent)
CLIP = d.intern_atom("CLIPBOARD")
owner = d.get_selection_owner(CLIP)
print("owner window:", hex(owner.id) if owner else None)


def get(target_name):
    target = d.intern_atom(target_name)
    prop = d.intern_atom("XSEL_DATA")
    w.convert_selection(CLIP, target, prop, X.CurrentTime)
    d.flush()
    end = time.time() + 2
    while time.time() < end:
        while d.pending_events():
            ev = d.next_event()
            if ev.type == X.SelectionNotify:
                if ev.property == X.NONE:
                    return "REFUSED"
                r = w.get_full_property(prop, X.AnyPropertyType)
                return r.value if r else None
        time.sleep(0.02)
    return "TIMEOUT"


targets = get("TARGETS")
if isinstance(targets, str):
    print("targets:", targets)
else:
    print("targets:", [d.get_atom_name(a) for a in targets])
print("utf8:", repr(get("UTF8_STRING"))[:120])
