#!/bin/sh
# Makes the white traffic-light glyphs (x, minus, expand, shrink) from the
# dark SVG ones, as PNGs at the hovered size: 16 px x 1.25 = 20 px.
# A PNG at its drawn size stays sharp, and ShojiWM blends a PNG's edges
# correctly (an SVG's soft edges turn grey).
#
# The glyph gets the same dark edge as the launcher's power glyphs: a soft
# black shadow just below it. launcher-glyph-shutdown.svg has dy 1.6 and
# blur 0.8 inside a 0.622 scale, on a 28-unit light drawn 36 px wide when
# hovered: dy 1.28 px and blur 0.64 px on screen, black at 55%.
# The same pixels here: this glyph shows only on a hovered light, 20 px for
# 28 units, so 1.4 units per px. The workspace numbers use the same shadow
# (shojiwm-setup/bin/patch-workspace-indicator.py).
#
# ShojiWM caches an image by its path, so a changed look gets a new name.
# Run from the repo root: sh tools/make-white-glyphs.sh
set -e
dir=packages/config/assets
shadow_dy=1.792      # 1.28 px x 1.4 units per px
shadow_blur=0.896    # 0.64 px x 1.4 units per px
shadow_opacity=0.55
# The shadow covers the whole 28-unit box: a box sized from the glyph has
# no height for the flat minus line, and its shadow and glyph vanished.
filter="<defs><filter id=\"s\" filterUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"28\" height=\"28\"><feDropShadow dx=\"0\" dy=\"$shadow_dy\" stdDeviation=\"$shadow_blur\" flood-color=\"#000\" flood-opacity=\"$shadow_opacity\"/></filter></defs>"
for name in x minus expand shrink; do
    sed -E 's/#[0-9A-Fa-f]{6}/#FFFFFF/g; s/(fill|stroke)-opacity="[0-9.]+"/\1-opacity="1"/g' \
        "$dir/mac-glass-$name.svg" |
        sed -E "s|^(<svg [^>]*>)|\1$filter|; s|^(  <g )|\1filter=\"url(#s)\" |" |
        rsvg-convert -w 20 -h 20 -o "$dir/mac-glass-glyph-$name.png"
done
