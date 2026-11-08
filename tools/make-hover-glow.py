"""Draw the hover glow of the round glass buttons, copied from the start orb.

The start orb (start-orb-vista-sheet.png, 128 x 384: normal, hover, pressed)
crossfades its hover frame in on hover. Measured against its normal frame
(orb disc radius R = 54 px, glass inside the black rim about 0.955 R), the
hover frame adds three things, all in one light cyan (#5FD6FF):

  1. Halo: a ring outside the rim, the same all round. Alpha 0.45 at the
     rim edge, falling in a straight line to 0 at 0.174 R outside it
     (9.4 px of 54).
  2. Inner light, under the glass and under the white dots:
     - a bottom light, centred on the bottom edge, radius 0.8 R: alpha
       0.95 at the edge, 0.77 / 0.56 / 0.38 / 0.23 / 0.11 at 0.17 / 0.28 /
       0.40 / 0.51 / 0.62 R from it, 0 at 0.8 R;
     - a soft wash in the middle, an ellipse 0.9 R wide and 1.4 R tall
       (half sizes) centred 0.2 R above the centre: alpha 0.30 in the
       middle, 0.19 half way out, 0 at its edge.
  3. Rim: the outer 0.056 R of the glass gets 0.13 (top) to 0.19 (bottom).

Each button gets the same layers, at the same size relative to the button,
in its own lit colour (the colour of the light already in its lower half,
as the orb's cyan is to its dark blue). The glow is drawn over
the button and, like the orb's, only adds light: where the glass is brighter
than the glow colour (a white rim), the glow takes the glass colour, so no
pixel gets darker. It fades in over the button (130 ms, OutCubic) and out
(250 ms). ShojiWM draws an image at full
strength (no opacity), so the fade steps through STEPS drawn strengths:
<name>-1.png (faint) to <name>-6.png (full). The glyph is drawn above.

The glows are PNG, not SVG: ShojiWM multiplies an SVG's colours by its
alpha twice, which turns a see-through glow grey. A PNG keeps its colours.

The glass buttons share one shape: a 28-unit view box, the glass a circle
of radius 12.9 around (14, 14), a soft dark edge out to 13.5. So R = 13.5
here, and the halo ends at 13.5 + 0.174 * 13.5 = 15.85 units.

Writes into packages/config/assets/ (each glow as STEPS strengths, -1 to -6):
  launcher-hover-<id>-<n>.png the launcher's power lights and the avatar
  launcher-glyph-<id>.svg     the power lights' glyphs alone (drawn above the glow)
  launcher-avatar-letter.svg  the avatar's letter alone
  mac-glass-hover-<kind>-<n>.png the title bar traffic lights
With --workspace DIR (the plasmoid's images) it writes only, from the
ws-light-*.svg there, ws-light-glow-active.png and ws-light-glow-inactive.png
(full strength; Qt fades them with opacity) for the panel's workspace numbers.

Needs rsvg-convert. Run: uv run --with numpy --with pillow python tools/make-hover-glow.py [--workspace DIR]
"""
import pathlib
import re
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageFilter

ASSETS = pathlib.Path(__file__).resolve().parent.parent / "packages/config/assets"

R = 13.5  # the button's outer edge (the orb's rim edge)
GLASS = 12.9  # the glass inside the edge
HALO_END = R * (1 + 0.174)
STEPS = 6
PIXELS_PER_UNIT = 3  # the PNGs are drawn larger than shown, then scaled down
HALO_ALPHA = 0.45
# The bottom light: (distance from the bottom edge / R, alpha), radius 0.8 R.
BOTTOM = [(0.0, 0.95), (0.17, 0.77), (0.28, 0.56), (0.40, 0.38), (0.51, 0.23), (0.62, 0.11), (0.80, 0.0)]
# The middle wash: (distance from its centre / its half size, alpha).
WASH = [(0.0, 0.30), (0.25, 0.28), (0.37, 0.235), (0.49, 0.19), (0.61, 0.135), (0.74, 0.075), (0.87, 0.035), (1.0, 0.0)]
WASH_RX, WASH_RY, WASH_UP = 0.9, 1.4, 0.2
RIM_WIDTH = 0.056 * R
RIM_TOP, RIM_BOTTOM = 0.13, 0.19


def glow_svg(color: str, margin: float, strength: float = 1.0) -> str:
    """The overlay for a 28-unit glass button, `margin` units of room around
    it, every alpha times `strength`."""
    side = 28 + 2 * margin
    bottom_r = 0.8 * R
    bottom_stops = "".join(
        f'<stop offset="{d / 0.8:.4f}" stop-color="{color}" stop-opacity="{a * strength:.4f}"/>' for d, a in BOTTOM
    )
    wash_stops = "".join(f'<stop offset="{d}" stop-color="{color}" stop-opacity="{a * strength:.4f}"/>' for d, a in WASH)
    edge = 13.2 / HALO_END
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{side:.4f}" height="{side:.4f}" viewBox="{-margin:.4f} {-margin:.4f} {side:.4f} {side:.4f}">
  <!-- The start orb's hover glow (tools/make-hover-glow.py). -->
  <defs>
    <radialGradient id="halo" cx="14" cy="14" r="{HALO_END:.4f}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{color}" stop-opacity="0"/>
      <stop offset="{edge:.4f}" stop-color="{color}" stop-opacity="0"/>
      <stop offset="{R / HALO_END:.4f}" stop-color="{color}" stop-opacity="{HALO_ALPHA * strength:.4f}"/>
      <stop offset="1" stop-color="{color}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bottom" cx="14" cy="{14 + R:.4f}" r="{bottom_r:.4f}" gradientUnits="userSpaceOnUse">{bottom_stops}</radialGradient>
    <radialGradient id="wash">{wash_stops}</radialGradient>
    <linearGradient id="rim" x1="0" y1="{14 - GLASS:.4f}" x2="0" y2="{14 + GLASS:.4f}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{color}" stop-opacity="{RIM_TOP * strength:.4f}"/>
      <stop offset="1" stop-color="{color}" stop-opacity="{RIM_BOTTOM * strength:.4f}"/>
    </linearGradient>
    <clipPath id="glass"><circle cx="14" cy="14" r="{GLASS}"/></clipPath>
  </defs>
  <circle cx="14" cy="14" r="{HALO_END:.4f}" fill="url(#halo)"/>
  <g clip-path="url(#glass)">
    <ellipse cx="14" cy="{14 - WASH_UP * R:.4f}" rx="{WASH_RX * R:.4f}" ry="{WASH_RY * R:.4f}" fill="url(#wash)"/>
    <circle cx="14" cy="{14 + R:.4f}" r="{bottom_r:.4f}" fill="url(#bottom)"/>
  </g>
  <circle cx="14" cy="14" r="{GLASS - RIM_WIDTH / 2:.4f}" fill="none" stroke="url(#rim)" stroke-width="{RIM_WIDTH:.4f}"/>
</svg>
"""


def hover_margin(size: int) -> float:
    """Room (units) so the overlay of a `size` px light, grown to size + 6 px
    on hover, ends on whole pixels: 3 px each side when grown."""
    return 84 / (size + 6)


def glyph_svg(icon: str, size: int, glyph: int) -> str:
    """A 24-unit glyph placed as `glyph` px inside a `size` px light, alone."""
    units = 28 / size
    offset = (size - glyph) / 2 * units
    scale = glyph * units / 24
    shadow = re.search(r"<filter id=\"s\".*?</filter>", icon, re.S).group(0)
    group = re.search(r"<g .*?</g>", icon, re.S).group(0)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
  <defs>{shadow}</defs>
  <g transform="translate({offset:.4f} {offset:.4f}) scale({scale:.6f})">{group}</g>
</svg>
"""


# id, body, lit colour (the light's own glow colour), light size px, glyph size px
LIGHTS = [
    ("lock", "launcher-light-yellow.svg", "#FFE27A", 26, 14),
    ("sleep", "launcher-light-blue.svg", "#7DB6FF", 26, 14),
    ("logout", "launcher-light-orange.svg", "#ffb67a", 26, 14),
    ("restart", "launcher-light-green.svg", "#86EE6E", 26, 14),
    ("shutdown", "launcher-light-red.svg", "#FF9A90", 30, 16),
]
AVATAR = ("avatar", "launcher-light-blue.svg", "#7DB6FF", 30)
TRAFFIC = [
    ("close", "mac-glass-close.svg", "#FF9A90"),
    ("minimize", "mac-glass-minimize.svg", "#FFE27A"),
    ("maximize", "mac-glass-maximize.svg", "#86EE6E"),
]
WORKSPACE_BLUE = "#7DB6FF"
# The traffic lights and workspace lights grow 1.2x; 2 units holds the halo.
TRAFFIC_MARGIN = 2.0


def roomy(svg: str, margin: float) -> str:
    """A 28-unit button SVG with `margin` units of empty room around it."""
    side = 28 + 2 * margin
    return re.sub(
        r'width="28" height="28" viewBox="0 0 28 28"',
        f'width="{side:.4f}" height="{side:.4f}" viewBox="{-margin:.4f} {-margin:.4f} {side:.4f} {side:.4f}"',
        svg,
        count=1,
    )


def draw(svg: str) -> np.ndarray:
    """Draw an SVG (straight alpha, 0..1 floats) at PIXELS_PER_UNIT."""
    with tempfile.TemporaryDirectory() as tmp:
        source = pathlib.Path(tmp) / "in.svg"
        drawn = pathlib.Path(tmp) / "out.png"
        source.write_text(svg)
        width = float(re.search(r'width="([0-9.]+)"', svg).group(1))
        side = round(width * PIXELS_PER_UNIT)
        subprocess.run(["rsvg-convert", "-w", str(side), "-h", str(side), str(source), "-o", str(drawn)], check=True)
        return np.asarray(Image.open(drawn).convert("RGBA")).astype(float) / 255


def glow_overlay(body_svg: str, color: str, margin: float) -> np.ndarray:
    """The glow drawn over the button: the orb's layers, never darker than
    the button. A glow pixel takes the brighter of the glow colour and the
    brightest glass near it (within a pixel or so, as shown), per channel.
    Drawn over the glass, it can only add light, also when ShojiWM scales
    the image a little differently from the glass under it."""
    body = draw(roomy(body_svg, margin))
    glow = draw(glow_svg(color, margin))
    rgb = (body[..., :3] * (body[..., 3:] > 0) * 255 + 0.5).astype(np.uint8)
    reach = 2 * PIXELS_PER_UNIT + 1
    nearby = np.asarray(Image.fromarray(rgb).filter(ImageFilter.MaxFilter(reach))).astype(float) / 255
    tint = np.array([int(color[i : i + 2], 16) for i in (1, 3, 5)], float) / 255
    return np.concatenate([np.maximum(nearby, tint), glow[..., 3:]], axis=-1)


def save(glow: np.ndarray, out: pathlib.Path, strength: float = 1.0) -> None:
    pixels = glow.copy()
    pixels[..., 3] *= strength
    Image.fromarray((pixels.clip(0, 1) * 255 + 0.5).astype(np.uint8)).save(out, optimize=True)


def write_steps(name: str, glow: np.ndarray) -> None:
    """The glow at STEPS strengths, drawn over the button to fade in."""
    for step in range(1, STEPS + 1):
        save(glow, ASSETS / f"{name}-{step}.png", step / STEPS)


def main() -> None:
    for light_id, body, color, size, glyph in LIGHTS:
        glow = glow_overlay((ASSETS / body).read_text(), color, hover_margin(size))
        write_steps(f"launcher-hover-{light_id}", glow)
        icon = (ASSETS / f"launcher-icon-{light_id}.svg").read_text()
        (ASSETS / f"launcher-glyph-{light_id}.svg").write_text(glyph_svg(icon, size, glyph))
    name, body, color, size = AVATAR
    write_steps(f"launcher-hover-{name}", glow_overlay((ASSETS / body).read_text(), color, hover_margin(size)))
    avatar = (ASSETS / "launcher-avatar-a.svg").read_text()
    letter = "\n".join(line for line in avatar.splitlines() if "M527 0 472 168" in line)
    (ASSETS / "launcher-avatar-letter.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">\n'
        f"{letter}\n</svg>\n"
    )
    for kind, body, color in TRAFFIC:
        write_steps(f"mac-glass-hover-{kind}", glow_overlay((ASSETS / body).read_text(), color, TRAFFIC_MARGIN))
    print("wrote", ASSETS)


def write_workspace(images: pathlib.Path) -> None:
    """The workspace lights: the current one is blue glass; a hovered other
    one is grey glass with the blue at 55% (patch-workspace-indicator.py)."""
    active = (images / "ws-light-active.svg").read_text()
    inactive = (images / "ws-light-inactive.svg").read_text()
    save(glow_overlay(active, WORKSPACE_BLUE, TRAFFIC_MARGIN), images / "ws-light-glow-active.png")
    tinted = re.sub(r"<svg [^>]*>", "", active, count=1).replace("</svg>", "")
    tinted = re.sub(r'id="(\w+)"', r'id="t\1"', tinted).replace("url(#", "url(#t")
    mixed = inactive.replace("</svg>", f'<g opacity="0.55">{tinted}</g>\n</svg>')
    save(glow_overlay(mixed, WORKSPACE_BLUE, TRAFFIC_MARGIN), images / "ws-light-glow-inactive.png")
    print("wrote", images)


if __name__ == "__main__":
    if "--workspace" in sys.argv:
        write_workspace(pathlib.Path(sys.argv[sys.argv.index("--workspace") + 1]))
    else:
        main()
