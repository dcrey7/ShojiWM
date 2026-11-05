// Clips a backdrop blur to a rounded rectangle: the content rect with
// `radius_px` (logical px) corners. Plasma popups ask for blur behind their
// own shape through KDE's blur protocol, which ShojiWM does not speak; their
// shape is a rounded rect, so this stands in for it.

uniform float radius_px;

vec4 shader_main(EffectContext effect) {
    vec2 size = effect.content_rect_phy_px.zw;
    vec2 p = effect_content_phy_px(effect);
    float r = radius_px * max(effect.scale, 0.0001);
    // Distance to the rounded rect (negative inside).
    vec2 q = abs(p - size * 0.5) - (size * 0.5 - vec2(r));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    float mask = 1.0 - smoothstep(-0.75, 0.75, d);
    vec4 color = texture2D(tex, effect.texture_uv);
    color.a = 1.0;
    return color * mask;
}
