// The launcher panel's glass, over its backdrop blur: the dark tint
// (style.background), the Aero shine across the top, and the light rim
// (style.border). As in the mock: the shine covers the top 110 px, fading
// from 11% white to 5% at 48%, then gone by 50%.
// 11 Nov 2026: shine off (0.0), so the launcher is plain frosted glass like
// the taskbar and the title bars. 1.0 brings the Aero shine back.
const float SHINE_STRENGTH = 0.0;

vec4 paint_main(PaintContext ctx) {
    vec4 fill = ctx.background * shoji_fill_coverage(ctx);
    // y from the inner edge of the border, in logical px.
    float y = (ctx.frag_phy_px.y - ctx.inner_rect_phy_px.y) / max(ctx.scale, 0.0001);
    float shine = 0.0;
    if (y < 52.8) {
        shine = mix(0.11, 0.05, y / 52.8);
    } else if (y < 55.0) {
        shine = mix(0.05, 0.0, (y - 52.8) / 2.2);
    }
    vec4 gloss = vec4(shine * SHINE_STRENGTH) * shoji_inner_coverage(ctx);
    vec4 rim = shoji_border_color_at(ctx) * shoji_border_coverage(ctx);
    return shoji_over(rim, shoji_over(gloss, fill));
}
