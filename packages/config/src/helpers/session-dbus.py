#!/usr/bin/env python3
"""KWin's session D-Bus object, so Plasma's Log Out (and Restart, Shut Down) works.

Plasma's logout (plasma-shutdown) asks KWin two things on
org.kde.KWin /Session (interface org.kde.KWin.Session):

1. closeWaylandWindows() -> bool: may the session end? With no KWin the call
   fails, plasma-shutdown cancels the logout, and nothing happens.
2. quit(): end the compositor. Then plasmalogin shows the login screen, or
   plasma-shutdown goes on to restart / shut down.

This service owns org.kde.KWin, says yes to (1) and runs `shoji_wm --quit`
for (2). The other session methods do nothing.

    Kickoff "Log Out" ──> plasma-shutdown ──closeWaylandWindows──> true
                                          ──quit──> shoji_wm --quit

Usage: session-dbus.py
"""

import subprocess
import sys

from gi.repository import Gio, GLib

BUS_NAME = "org.kde.KWin"
OBJECT_PATH = "/Session"
INTERFACE_XML = """
<node>
  <interface name="org.kde.KWin.Session">
    <method name="setState">
      <arg name="state" type="u" direction="in"/>
    </method>
    <method name="loadSession">
      <arg name="name" type="s" direction="in"/>
    </method>
    <method name="aboutToSaveSession">
      <arg name="name" type="s" direction="in"/>
    </method>
    <method name="finishSaveSession">
      <arg name="name" type="s" direction="in"/>
    </method>
    <method name="closeWaylandWindows">
      <arg type="b" direction="out"/>
    </method>
    <method name="quit"/>
  </interface>
</node>
"""

# Time for the reply to reach plasma-shutdown before the compositor goes.
QUIT_DELAY_MS = 200


def quit_compositor() -> bool:
    subprocess.run(["shoji_wm", "--quit"], check=False)
    return False


def on_method_call(_connection, _sender, _path, _interface, method, _parameters, invocation):
    if method == "closeWaylandWindows":
        invocation.return_value(GLib.Variant("(b)", (True,)))
    elif method == "quit":
        invocation.return_value(None)
        GLib.timeout_add(QUIT_DELAY_MS, quit_compositor)
    elif method in ("setState", "loadSession", "aboutToSaveSession", "finishSaveSession"):
        invocation.return_value(None)
    else:
        invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)


def on_bus_acquired(connection, _name):
    # Register the object before the name shows up, so Plasma never sees
    # the name without the object.
    interface = Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML).interfaces[0]
    connection.register_object(OBJECT_PATH, interface, on_method_call, None, None)


def on_name_lost(_connection, _name):
    print(f"session-dbus: {BUS_NAME} is taken (is KWin running?)", file=sys.stderr)
    sys.exit(1)


Gio.bus_own_name(
    Gio.BusType.SESSION,
    BUS_NAME,
    Gio.BusNameOwnerFlags.NONE,
    on_bus_acquired,
    None,
    on_name_lost,
)
GLib.MainLoop().run()
