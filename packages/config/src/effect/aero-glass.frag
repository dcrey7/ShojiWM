// Dark Aero glass (Windows Vista / 7), for title bars.
//
// The pipeline blurs what is behind the bar first. This stage then:
//   1. darkens the blur toward a smoky tint, so text on the bar stays easy
//      to read over any wallpaper;
//   2. adds the soft gloss band on the upper part of the bar;
//   3. adds Aero's faint diagonal reflection streaks;
//   4. lights the top edge with a thin bright line.
// All sizes are in logical px, so the look is the same on every scale.

uniform float darkness;        // 0: clear glass, 1: solid tint
uniform float gloss_strength;  // brightness the gloss band adds
uniform float streak_strength; // brightness one streak adds at its peak

// A fixed random number in [0, 1) per band.
float hash(float n) {
    return fract(sin(n * 12.9898) * 43758.5453);
}

vec4 shader_main(EffectContext effect) {
    vec2 size = effect.content_rect_phy_px.zw;
    vec2 p = effect_content_phy_px(effect);
    float s = max(effect.scale, 0.0001);
    vec2 uv = clamp(effect_texture_uv_from_content_phy_px(effect, p), vec2(0.0), vec2(1.0));
    vec3 color = texture2D(tex, uv).rgb;

    // 1. Smoky tint, a touch of blue as in Windows 7's dark glass.
    color = mix(color, vec3(0.07, 0.08, 0.10), darkness);

    // 2. Gloss: strongest at the top, gone a little past the middle.
    float y = p.y / max(size.y, 1.0);
    float gloss = (1.0 - smoothstep(0.35, 0.6, y)) * (0.55 + 0.45 * (1.0 - y));
    color += vec3(gloss_strength * gloss);

    // 3. Streaks: soft bands at about 54 degrees, each its own width and
    //    strength, 110 logical px apart.
    vec2 q = p / s;
    float d = (q.x * 0.588 + q.y * 0.809) / 110.0;
    float band = floor(d);
    float f = fract(d);
    float width = 0.12 + 0.28 * hash(band);
    float streak = smoothstep(0.0, 0.1, f) * (1.0 - smoothstep(width, width + 0.12, f));
    color += vec3(streak_strength * streak * (0.4 + 0.6 * hash(band + 7.0)));

    // 4. The bright top edge: one logical px.
    color += vec3(0.16) * (1.0 - smoothstep(0.0, 1.2 * s, p.y));

    return vec4(clamp(color, 0.0, 1.0), 1.0);
}
