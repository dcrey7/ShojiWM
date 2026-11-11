// The launcher's moving light, drawn over the whole panel by one paint
// shader, so it moves by uniforms only (no relayout):
//
// 1. The selection ring: the same thin light border and soft glow as a
//    selected tile (a 1 px border, and a box-shadow of blur 8, spread 1),
//    at a rect that glides from tile to tile.
// 2. The press ripple: a soft light circle that grows from the click point,
//    clipped to the pressed tile's (or light's) rounded shape.
//
// Every length here is in logical px, in panel coordinates.

uniform vec4 ring_rect;     // left, top, right, bottom
uniform vec4 ring_style;    // corner radius, alpha, border width, glow blur
uniform vec4 ring_clip;     // left, top, right, bottom: the scroll area
uniform vec4 ring_color;    // the border colour (straight alpha)
uniform vec4 glow_color;    // the glow colour (straight alpha)
uniform vec4 ripple;        // centre x, centre y, radius, alpha
uniform vec4 ripple_clip;   // left, top, right, bottom of the pressed shape
uniform float ripple_corner; // its corner radius

vec4 rect_of(vec4 edges, float scale) {
    return vec4(edges.xy, edges.zw - edges.xy) * scale;
}

float rect_cover(vec2 p, vec4 edges, float scale) {
    vec4 r = rect_of(edges, scale);
    vec2 a = clamp(p - r.xy + 0.5, 0.0, 1.0);
    vec2 b = clamp(r.xy + r.zw - p + 0.5, 0.0, 1.0);
    return a.x * a.y * b.x * b.y;
}

vec4 paint_ring(vec2 p, float s) {
    float alpha = ring_style.y;
    if (alpha <= 0.001 || ring_rect.z - ring_rect.x < 1.0) {
        return vec4(0.0);
    }
    vec4 box = rect_of(ring_rect, s);
    float corner = min(ring_style.x * s, 0.5 * min(box.z, box.w));
    vec4 radius = vec4(corner);
    float border = ring_style.z * s;
    // As the engine's own box-shadow: spread 1, sigma = blur / 2.
    float spread = floor(s + 0.5);
    vec4 shape = vec4(box.xy - vec2(spread), box.zw + vec2(2.0 * spread));
    float glow = shoji_blurred_rrect_coverage(p, shape, radius + vec4(spread), ring_style.w * s * 0.5);
    float outer = shoji_rrect_coverage(p, box, radius);
    vec4 inner_box = vec4(box.xy + vec2(border), box.zw - vec2(2.0 * border));
    float inner = shoji_rrect_coverage(p, inner_box, vec4(max(corner - border, 0.0)));
    vec4 g = shoji_premultiply(glow_color) * glow * (1.0 - outer);
    vec4 b = shoji_premultiply(ring_color) * max(outer - inner, 0.0);
    return shoji_over(b, g) * alpha * rect_cover(p, ring_clip, s);
}

vec4 paint_ripple(vec2 p, float s) {
    float alpha = ripple.w;
    if (alpha <= 0.001 || ripple.z <= 0.0) {
        return vec4(0.0);
    }
    vec4 box = rect_of(ripple_clip, s);
    float clip = shoji_rrect_coverage(p, box, vec4(min(ripple_corner * s, 0.5 * min(box.z, box.w))));
    // A radial gradient: 30% white at the centre, 15% at 64% of the radius,
    // nothing at the rim (the mock's ripple).
    float d = length(p - ripple.xy * s) / (ripple.z * s);
    float a = d < 0.636 ? mix(0.30, 0.15, d / 0.636) : mix(0.15, 0.0, clamp((d - 0.636) / 0.354, 0.0, 1.0));
    return vec4(a) * alpha * clip;
}

vec4 paint_main(PaintContext ctx) {
    vec2 p = ctx.frag_phy_px;
    float s = ctx.scale;
    return shoji_over(paint_ripple(p, s), paint_ring(p, s));
}
