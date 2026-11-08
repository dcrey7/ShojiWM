// The launcher's search pill: a dark inset glass, black at 45% at the top to
// 25% at the bottom, inside a near-black border (as in the mock).

vec4 paint_main(PaintContext ctx) {
    float t = clamp(
        (ctx.frag_phy_px.y - ctx.inner_rect_phy_px.y) / max(ctx.inner_rect_phy_px.w, 1.0),
        0.0, 1.0);
    vec4 fill = vec4(0.0, 0.0, 0.0, mix(0.45, 0.25, t)) * shoji_fill_coverage(ctx);
    vec4 rim = shoji_border_color_at(ctx) * shoji_border_coverage(ctx);
    return shoji_over(rim, fill);
}
