#!/bin/sh
# Makes the white traffic-light glyphs (x, minus, expand, shrink) from the
# dark SVG ones, as PNGs at the hovered size: 16 px x 1.25 = 20 px.
# A PNG at its drawn size stays sharp, and ShojiWM blends a PNG's edges
# correctly (an SVG's soft edges turn grey).
# Run from the repo root: sh tools/make-white-glyphs.sh
set -e
dir=packages/config/assets
for name in x minus expand shrink; do
    sed -E 's/#[0-9A-Fa-f]{6}/#FFFFFF/g; s/(fill|stroke)-opacity="[0-9.]+"/\1-opacity="1"/g' \
        "$dir/mac-glass-$name.svg" |
        rsvg-convert -w 20 -h 20 -o "$dir/mac-glass-white-$name.png"
done
