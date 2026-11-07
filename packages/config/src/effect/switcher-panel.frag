// The Windows 7 thumbnail card behind a switcher's selected window: a frosted
// white panel a little larger than the window (Seven-Black's
// taskbarhover.svg "active" frame: a pale blue-white body, a bright
// #e8f2ff rim). It is drawn only outside the window, so it never covers it.
//
//   strength  0 = no panel (the built-in look only), 1 = full panel
//   unit      logical px of this window per px on screen (the card is
//             drawn scaled down, so the panel grows to keep its size)
uniform float strength;
uniform float unit;

// Sizes on screen, in logical px.
const float PADDING = 14.0;
const float RADIUS = 7.0;
const float SHADOW_SIGMA = 3.0;
// The body: a white vertical gradient, light blue-white like the theme.
const vec4 TOP = vec4(0.93, 0.965, 1.0, 0.42);
const vec4 BOTTOM = vec4(0.76, 0.87, 0.99, 0.13);
// The 1 px inner rim and the soft shadow around the panel.
const vec4 RIM = vec4(0.91, 0.95, 1.0, 0.75);
const float SHADOW_ALPHA = 0.45;

vec4 paint_main(PaintContext ctx) {
    vec4 own = shoji_default_paint(ctx);
    if (strength <= 0.0) {
        return own;
    }
    vec2 p = ctx.frag_phy_px;
    vec4 frame = vec4(vec2(0.0), ctx.size_phy_px);
    float outside = 1.0 - shoji_outer_coverage(ctx);
    if (outside <= 0.0) {
        return own;
    }
    float px = ctx.scale * unit;
    float pad = PADDING * px;
    vec4 panel_rect = frame + vec4(-pad, -pad, 2.0 * pad, 2.0 * pad);
    vec4 radius = vec4(RADIUS * px);
    float d = shoji_rrect_sdf(p, panel_rect, radius);
    // One screen pixel, in this window's physical px.
    float edge = max(px, 1.0);
    float body = clamp(0.5 - d / edge, 0.0, 1.0);
    float rim = body * clamp(1.5 + d / edge, 0.0, 1.0);
    float t = clamp((p.y - panel_rect.y) / panel_rect.w, 0.0, 1.0);
    vec4 fill = shoji_premultiply(mix(TOP, BOTTOM, t)) * body;
    fill = shoji_over(shoji_premultiply(RIM) * rim, fill);
    float shadow = SHADOW_ALPHA *
        shoji_blurred_rrect_coverage(p, panel_rect + vec4(0.0, 2.0 * px, 0.0, 0.0), radius, SHADOW_SIGMA * px);
    vec4 panel = shoji_over(fill, vec4(0.0, 0.0, 0.0, shadow * (1.0 - body)));
    return shoji_over(own, panel * (strength * outside));
}
