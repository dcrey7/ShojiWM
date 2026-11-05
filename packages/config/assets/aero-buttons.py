#!/usr/bin/env python3
"""Draw the dark Aero caption buttons (aero-*.svg) next to this file.

Windows 7's caption buttons are one glass strip at the top right: minimize
and maximize 29x19, close 48x19, joined, no top edge, the outer bottom
corners rounded. Each button is glossy glass split in two at its middle: a
light upper half and a deeper lower half. We keep that shape and gloss, but
colour the buttons like traffic lights: minimize yellow, maximize green,
close red. Measures and gradients follow 7.css (MIT), which rebuilds the
Windows 7 look in CSS; the drawing here is our own.

    aero-{kind}-{state}.svg   kind: minimize, maximize, close
                              state: normal, hover, press, inactive
    aero-glyph-{name}.svg     name: minimize, maximize, restore, close

Run: python3 aero-buttons.py
"""

from pathlib import Path

HERE = Path(__file__).parent
HEIGHT = 19
WIDTH = {"minimize": 29, "maximize": 29, "close": 48}
CORNER = 5
# Where the button sits in the strip: its outer corner gets rounded.
EDGE = {"minimize": "left", "maximize": None, "close": "right"}

# Glass in three bands: top of the upper half, the rest of the upper half,
# the lower half. The hard step at 50% is the Aero gloss line. `glow` lights
# the bottom of a hovered button.
COLORS = {
    "close": {
        "normal": ("#e0a197", "#cf796a", "#d54f36", None),
        "hover": ("#fb9d8b", "#ee6d56", "#d42809", "#f4e676"),
        "press": ("#d1a894", "#b67562", "#7d0d01", "#dcc03f"),
    },
    "minimize": {
        "normal": ("#efd690", "#ddb352", "#d39608", None),
        "hover": ("#ffe9a6", "#f8c64a", "#e09600", "#fff6b0"),
        "press": ("#cfb47e", "#a9842f", "#7a4f00", "#e0c040"),
    },
    "maximize": {
        "normal": ("#a9d99d", "#73be62", "#2f9a1d", None),
        "hover": ("#bff3ae", "#68d64e", "#1ea000", "#e2ffa8"),
        "press": ("#97b78c", "#518c43", "#0d5a03", "#9ad050"),
    },
}
# An unfocused window: clear smoky glass, no colour.
INACTIVE = ("#6b7078", "#4a4f57", "#30343b", None)

OUTER_LINE = "#000000b3"
INNER_LINE = "#ffffff80"


def outline_path(width: int, edge: str | None, inset: float) -> str:
    """The button's outline, rounded at its outer bottom corner only."""
    left, right = inset, width - inset
    top, bottom = -1.0, HEIGHT - inset
    r = max(CORNER - inset, 0)
    bl = r if edge == "left" else 0
    br = r if edge == "right" else 0
    return (
        f"M{left},{top} H{right} V{bottom - br} "
        f"Q{right},{bottom} {right - br},{bottom} "
        f"H{left + bl} Q{left},{bottom} {left},{bottom - bl} Z"
    )


def button_svg(kind: str, bands: tuple) -> str:
    width = WIDTH[kind]
    edge = EDGE[kind]
    top, mid, low, glow = bands
    shape = outline_path(width, edge, 0.5)
    glow_layer = (
        f'<ellipse cx="{width / 2}" cy="{HEIGHT * 1.35}" rx="{width * 0.6}" '
        f'ry="{HEIGHT * 0.8}" fill="url(#glow)"/>'
        if glow
        else ""
    )
    glow_def = (
        f'<radialGradient id="glow"><stop offset="0.2" stop-color="{glow}"/>'
        f'<stop offset="1" stop-color="{glow}" stop-opacity="0"/></radialGradient>'
        if glow
        else ""
    )
    # Separators: every button draws its right edge; the first one its left.
    left_line = (
        f'<line x1="0.5" y1="0" x2="0.5" y2="{HEIGHT}" stroke="{OUTER_LINE}"/>'
        if edge == "left"
        else ""
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{HEIGHT}" viewBox="0 0 {width} {HEIGHT}">
<defs>
<clipPath id="shape"><path d="{shape}"/></clipPath>
<linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="{top}"/><stop offset="0.25" stop-color="{mid}"/>
<stop offset="0.5" stop-color="{mid}"/><stop offset="0.5" stop-color="{low}"/>
<stop offset="1" stop-color="{low}"/></linearGradient>
<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#fff" stop-opacity="0.5"/>
<stop offset="0.45" stop-color="#fff" stop-opacity="0.3"/>
<stop offset="0.5" stop-color="#000" stop-opacity="0.1"/>
<stop offset="0.75" stop-color="#000" stop-opacity="0.1"/>
<stop offset="1" stop-color="#fff" stop-opacity="0.35"/></linearGradient>
<radialGradient id="side" cx="0.5" cy="0.5" r="0.75">
<stop offset="0.55" stop-color="#000" stop-opacity="0"/>
<stop offset="1" stop-color="#000" stop-opacity="0.35"/></radialGradient>
{glow_def}
</defs>
<g clip-path="url(#shape)">
<rect width="{width}" height="{HEIGHT}" fill="url(#body)"/>
<rect width="{width}" height="{HEIGHT}" fill="url(#side)"/>
{glow_layer}
<rect width="{width}" height="{HEIGHT}" fill="url(#gloss)"/>
<path d="{outline_path(width, edge, 1.5)}" fill="none" stroke="{INNER_LINE}"/>
</g>
<path d="{shape}" fill="none" stroke="{OUTER_LINE}"/>
{left_line}
</svg>
"""


# Glyphs: chunky white shapes with a soft grey fade and a dark outline, on
# the pixel grid of a 29x19 (or 48x19) button, centred by the button.
GLYPH_FILL = (
    '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
    '<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d8dbe2"/>'
    "</linearGradient>"
)
GLYPH_LINE = "#23262f"


def glyph_svg(width: int, body: str) -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{HEIGHT}" viewBox="0 0 {width} {HEIGHT}">
<defs>{GLYPH_FILL}</defs>
<g fill="url(#g)" stroke="{GLYPH_LINE}" stroke-width="1" stroke-linejoin="round">
{body}
</g>
</svg>
"""


def glyphs() -> dict[str, str]:
    w = WIDTH["minimize"]
    cx = w / 2
    close_w = WIDTH["close"]
    x0 = close_w / 2
    # The close X: two bold crossing bars, 4 px thick, 11 x 10 px.
    arm = 4.0
    half_w, half_h = 5.5, 5.0
    pinch = 2.0
    cy = 9.5
    xs = [
        (x0 - half_w, cy - half_h),
        (x0 - half_w + arm, cy - half_h),
        (x0, cy - pinch),
        (x0 + half_w - arm, cy - half_h),
        (x0 + half_w, cy - half_h),
        (x0 + pinch, cy),
        (x0 + half_w, cy + half_h),
        (x0 + half_w - arm, cy + half_h),
        (x0, cy + pinch),
        (x0 - half_w + arm, cy + half_h),
        (x0 - half_w, cy + half_h),
        (x0 - pinch, cy),
    ]
    x_points = " ".join(f"{x:.2f},{y:.2f}" for x, y in xs)
    return {
        # A low bar, as on Windows 7.
        "minimize": glyph_svg(w, f'<rect x="{cx - 5}" y="10.5" width="10" height="3.5" rx="0.6"/>'),
        # A window: thick top bar, thin walls.
        "maximize": glyph_svg(
            w,
            f'<path fill-rule="evenodd" d="M{cx - 5},4.5 h10 v9 h-10 Z '
            f'M{cx - 3},7.5 h6 v4 h-6 Z"/>',
        ),
        # Two windows, the back one up and right.
        "restore": glyph_svg(
            w,
            f'<path fill-rule="evenodd" d="M{cx - 2.5},3.5 h8 v7 h-2 v-4 h-6 Z"/>'
            f'<path fill-rule="evenodd" d="M{cx - 5.5},6.5 h8 v7.5 h-8 Z '
            f'M{cx - 3.5},9 h4 v3 h-4 Z"/>',
        ),
        "close": glyph_svg(close_w, f'<polygon points="{x_points}"/>'),
    }


def main() -> None:
    for kind, states in COLORS.items():
        for state, bands in states.items():
            (HERE / f"aero-{kind}-{state}.svg").write_text(button_svg(kind, bands))
        (HERE / f"aero-{kind}-inactive.svg").write_text(button_svg(kind, INACTIVE))
    for name, svg in glyphs().items():
        (HERE / f"aero-glyph-{name}.svg").write_text(svg)


if __name__ == "__main__":
    main()
