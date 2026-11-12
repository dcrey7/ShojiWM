"""Minimize and restore one window N times; print the Magic Lamp frame stats."""

import json
import socket
import sys
import time

SOCK = "/run/user/1000/shojiwm-wayland-1.sock"
FRAME_MS = 1000 / 144
LATE_MS = 1.5 * FRAME_MS


def ipc(method, params=None):
    with socket.socket(socket.AF_UNIX) as s:
        s.connect(SOCK)
        s.sendall((json.dumps({"id": 1, "method": method, "params": params or {}}) + "\n").encode())
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(1 << 20)
            if not chunk:
                break
            buf += chunk
    return json.loads(buf.split(b"\n")[0]).get("result")


label = sys.argv[1]
window = sys.argv[2] if len(sys.argv) > 2 else "0x1cc"
rounds = int(sys.argv[3]) if len(sys.argv) > 3 else 3
start_ms = time.time() * 1000
for _ in range(rounds):
    ipc("windows.minimize", {"windowId": window})
    time.sleep(0.6)
    ipc("windows.activate", {"windowId": window})
    time.sleep(0.6)

runs = [r for r in (ipc("debug.magicLamp", {}) or {}).get("runs", []) if r["startMs"] >= start_ms - 50]
deltas = [d for r in runs for d in r["deltas"][1:]]
deltas.sort()
n = len(deltas)
if n == 0:
    print(label, "no lamp runs")
else:
    late = sum(1 for d in deltas if d > LATE_MS)
    print(
        label,
        f"runs {len(runs)} frames {n} p50 {deltas[n // 2]:.1f} p95 {deltas[int(n * 0.95)]:.1f}",
        f"max {deltas[-1]:.1f} late {late} ({100 * late / n:.0f}%)",
    )
