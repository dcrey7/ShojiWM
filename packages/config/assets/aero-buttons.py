#!/usr/bin/env python3
"""Draw the dark Aero caption buttons (aero-*.svg) next to this file.

Windows 7's caption buttons are one glass strip at the top right: minimize
and maximize 29x19, close 48x19, joined, no top edge, the outer bottom
corners rounded. Measures and gradients follow 7.css (MIT), which rebuilds
the Windows 7 look in CSS; the drawing here is our own.

At rest the buttons are dark and neutral, like the dark bar. Colour shows
only under the pointer, like traffic lights: minimize yellow, maximize
green, close red. Two finishes:
- "glass" (default): Windows 7 gloss, split in two at the middle. The
  colour is a see-through tint between the dark glass and the gloss, so
  both still show through it; pressed is the same tint, stronger.
- "flat": solid fills, a crisp 1 px border, white glyphs.

ShojiWM cannot fade an image, so the fade-in is drawn ahead: the glass tint
comes in TINT_STEPS files, from faint to full, and the config steps
through them.

    aero-glass-{kind}-{rest|inactive|press}.svg
    aero-glass-{kind}-tint{1..TINT_STEPS}.svg
    aero-flat-{kind}-{rest|inactive|hover|press}.svg
    aero-{finish}-glyph-{name}[-dim].svg   name: minimize, maximize,
                                           restore, close; -dim: unfocused

Run: python3 aero-buttons.py [tint strength, default 0.55]
"""

import sys
from pathlib import Path

HERE = Path(__file__).parent
HEIGHT = 19
WIDTH = {"minimize": 29, "maximize": 29, "close": 48}
CORNER = 5
# Where the button sits in the strip: its outer corner gets rounded.
EDGE = {"minimize": "left", "maximize": None, "close": "right"}

# Glass in three bands: top of the upper half, the rest of the upper half,
# the lower half. The hard step at 50% is the Aero gloss line. `glow` lights
# the bottom of a tinted button.
# The tint: a soft, slightly grey version of each traffic light colour.
TINT = {"close": "#e0574c", "minimize": "#e8b03a", "maximize": "#4fb85a"}
# How strong a full tint is (0..1), how much stronger pressing makes it,
# and how many steps the fade has.
TINT_STRENGTH = 0.55
PRESS_EXTRA = 0.2
TINT_STEPS = 4
# Pressing also darkens the glass under the tint a little.
PRESS_SHADE = 0.25

# At rest: dark smoky glass, like the bar. Unfocused: a little fainter.
GLASS_REST = ("#4a4f58", "#33373f", "#22252b", None)
GLASS_INACTIVE = ("#3c4048", "#2c3037", "#202329", None)

# Flat: (fill, border).
FLAT_LIT = {
    "close": {"hover": ("#e0443a", "#a3231b"), "press": ("#a8251c", "#6e120c")},
    "minimize": {"hover": ("#e7a810", "#a87700"), "press": ("#a87a06", "#6e4e00")},
    "maximize": {"hover": ("#35b545", "#1f7f2c"), "press": ("#22812f", "#12561c")},
}
FLAT_REST = ("#2b2f37", "#0b0d11")
FLAT_INACTIVE = ("#23262d", "#0b0d11")

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


def glass_svg(kind: str, bands: tuple, tint: float = 0.0, shade: float = 0.0) -> str:
    """Glass; `tint` (0..1) lays the button's colour over it, under the gloss."""
    width = WIDTH[kind]
    edge = EDGE[kind]
    top, mid, low, glow = bands
    if tint > 0:
        # The tint also lights the bottom, as Windows 7 does on hover.
        glow = TINT[kind]
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
<rect width="{width}" height="{HEIGHT}" fill="#000" fill-opacity="{shade:.3f}"/>
<rect width="{width}" height="{HEIGHT}" fill="{TINT[kind]}" fill-opacity="{tint:.3f}"/>
<g opacity="{min(tint * 1.2, 1):.3f}">{glow_layer}</g>
<rect width="{width}" height="{HEIGHT}" fill="url(#gloss)"/>
<path d="{outline_path(width, edge, 1.5)}" fill="none" stroke="{INNER_LINE}"/>
</g>
<path d="{shape}" fill="none" stroke="{OUTER_LINE}"/>
{left_line}
</svg>
"""


def flat_svg(kind: str, colors: tuple) -> str:
    """One solid fill and a crisp 1 px border; no gloss."""
    width = WIDTH[kind]
    edge = EDGE[kind]
    fill, border = colors
    left_line = (
        f'<line x1="0.5" y1="0" x2="0.5" y2="{HEIGHT}" stroke="{border}"/>'
        if edge == "left"
        else ""
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{HEIGHT}" viewBox="0 0 {width} {HEIGHT}">
<path d="{outline_path(width, edge, 0.5)}" fill="{fill}" stroke="{border}"/>
{left_line}
</svg>
"""


# Glyphs: chunky white shapes with a soft grey fade and a dark outline, on
# the pixel grid of a 29x19 (or 48x19) button, centred by the button.
GLYPH_STYLE = {
    # Glass: a soft white-to-grey fade with a dark outline, as on Windows 7.
    "glass": (
        '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d8dbe2"/>'
        "</linearGradient>",
        "url(#g)",
        'stroke="#23262f" stroke-width="1"',
    ),
    # Flat: plain white, a faint edge so it still reads on yellow.
    "flat": ("", "#ffffff", 'stroke="#00000040" stroke-width="0.6"'),
}
FINISH = "glass"


DIM = False


def glyph_svg(width: int, body: str) -> str:
    defs, fill, stroke = GLYPH_STYLE[FINISH]
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{HEIGHT}" viewBox="0 0 {width} {HEIGHT}">
<defs>{defs}</defs>
<g fill="{fill}" {stroke} stroke-linejoin="round" opacity="{0.55 if DIM else 1}">
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


def glass_files(kind: str, strength: float) -> dict[str, str]:
    """Every glass file of one button, at one tint strength."""
    files = {
        "rest": glass_svg(kind, GLASS_REST),
        "inactive": glass_svg(kind, GLASS_INACTIVE),
        "press": glass_svg(kind, GLASS_REST, min(strength + PRESS_EXTRA, 1), PRESS_SHADE),
    }
    for step in range(1, TINT_STEPS + 1):
        files[f"tint{step}"] = glass_svg(kind, GLASS_REST, strength * step / TINT_STEPS)
    return files


def main() -> None:
    global FINISH, DIM
    strength = float(sys.argv[1]) if len(sys.argv) > 1 else TINT_STRENGTH
    for kind in WIDTH:
        for state, svg in glass_files(kind, strength).items():
            (HERE / f"aero-glass-{kind}-{state}.svg").write_text(svg)
        flat = {"rest": FLAT_REST, "inactive": FLAT_INACTIVE, **FLAT_LIT[kind]}
        for state, colors in flat.items():
            (HERE / f"aero-flat-{kind}-{state}.svg").write_text(flat_svg(kind, colors))
    for FINISH in GLYPH_STYLE:
        for DIM in (False, True):
            suffix = "-dim" if DIM else ""
            for name, svg in glyphs().items():
                (HERE / f"aero-{FINISH}-glyph-{name}{suffix}.svg").write_text(svg)


if __name__ == "__main__":
    main()
