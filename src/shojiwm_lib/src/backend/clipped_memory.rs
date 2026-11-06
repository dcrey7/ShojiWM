use smithay::{
    backend::renderer::{
        element::{
            Element, Id, Kind, RenderElement, UnderlyingStorage,
            memory::MemoryRenderBufferRenderElement,
        },
        gles::{GlesError, GlesFrame, GlesRenderer, GlesTexProgram, Uniform, UniformName},
        utils::{CommitCounter, DamageSet, OpaqueRegions},
    },
    utils::{Buffer, Logical, Physical, Point, Rectangle, Scale, Size, Transform},
};

use crate::backend::visual::{PreciseLogicalRect, snapped_precise_logical_rect_in_area_space};
use crate::ssd::LogicalRect;

/// A memory buffer drawn into an exact physical rectangle.
///
/// Smithay sizes memory elements in whole logical pixels, which cannot express
/// a layout box of e.g. 29 physical px at 1.5x (19.33 logical). Decoration
/// text and icons are rasterized at the layout scale to exactly their layout
/// box, so this pins the destination to that box and the buffer is sampled
/// one texel per output pixel.
#[derive(Debug)]
pub struct ExactMemoryElement {
    inner: MemoryRenderBufferRenderElement<GlesRenderer>,
    geometry: Option<Rectangle<i32, Physical>>,
    /// A source rect that may reach past the buffer, for a buffer drawn at a
    /// fractional position and size (see `with_subpixel_rect`).
    src: Option<Rectangle<f64, Buffer>>,
}

impl ExactMemoryElement {
    pub fn new(
        inner: MemoryRenderBufferRenderElement<GlesRenderer>,
        geometry: Option<Rectangle<i32, Physical>>,
    ) -> Self {
        Self {
            inner,
            geometry,
            src: None,
        }
    }

    /// Draws the whole buffer at `rect` (physical pixels, not snapped). The
    /// element covers the whole pixels around `rect`, and its source rect
    /// reaches past the buffer by the same fraction, so the buffer lands on
    /// `rect` exactly. Draw it through `ClippedMemoryElement`: its shader
    /// fades the texels past the buffer edge to transparent.
    pub fn with_subpixel_rect(mut self, rect: Rectangle<f64, Physical>) -> Self {
        if let Some((geometry, src)) = subpixel_cover(rect, self.texture_size()) {
            self.geometry = Some(geometry);
            self.src = Some(src);
        }
        self
    }

    /// The buffer size in texels.
    pub fn texture_size(&self) -> Size<f64, Buffer> {
        self.inner.src().size
    }

    fn is_subpixel(&self) -> bool {
        self.src.is_some()
    }
}

impl Element for ExactMemoryElement {
    fn id(&self) -> &Id {
        self.inner.id()
    }

    fn current_commit(&self) -> CommitCounter {
        self.inner.current_commit()
    }

    fn geometry(&self, scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.geometry.unwrap_or_else(|| self.inner.geometry(scale))
    }

    fn src(&self) -> Rectangle<f64, Buffer> {
        self.src.unwrap_or_else(|| self.inner.src())
    }

    fn transform(&self) -> Transform {
        self.inner.transform()
    }

    fn damage_since(
        &self,
        scale: Scale<f64>,
        commit: Option<CommitCounter>,
    ) -> DamageSet<i32, Physical> {
        let damage = self.inner.damage_since(scale, commit);
        match self.geometry {
            // Inner damage is in the inner element's own (unpinned) space;
            // any change repaints the whole pinned box.
            Some(geometry) if !damage.is_empty() => {
                DamageSet::from_slice(&[Rectangle::from_size(geometry.size)])
            }
            _ => damage,
        }
    }

    fn opaque_regions(&self, _scale: Scale<f64>) -> OpaqueRegions<i32, Physical> {
        OpaqueRegions::default()
    }

    fn alpha(&self) -> f32 {
        self.inner.alpha()
    }

    fn kind(&self) -> Kind {
        self.inner.kind()
    }
}

impl RenderElement<GlesRenderer> for ExactMemoryElement {
    fn draw(
        &self,
        frame: &mut GlesFrame<'_, '_>,
        src: Rectangle<f64, Buffer>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        opaque_regions: &[Rectangle<i32, Physical>],
        cache: Option<&smithay::utils::user_data::UserDataMap>,
    ) -> Result<(), GlesError> {
        RenderElement::<GlesRenderer>::draw(
            &self.inner,
            frame,
            src,
            dst,
            damage,
            opaque_regions,
            cache,
        )
    }

    fn underlying_storage(&self, _renderer: &mut GlesRenderer) -> Option<UnderlyingStorage<'_>> {
        None
    }
}

/// For a buffer of `texture` texels drawn at `rect`: the whole pixels that
/// cover `rect`, and the source rect that maps the buffer onto `rect` inside
/// them. The source reaches past the buffer where the pixels do past `rect`.
fn subpixel_cover(
    rect: Rectangle<f64, Physical>,
    texture: Size<f64, Buffer>,
) -> Option<(Rectangle<i32, Physical>, Rectangle<f64, Buffer>)> {
    if rect.size.w <= 0.0 || rect.size.h <= 0.0 || texture.w <= 0.0 || texture.h <= 0.0 {
        return None;
    }
    let left = rect.loc.x.floor();
    let top = rect.loc.y.floor();
    let right = (rect.loc.x + rect.size.w).ceil();
    let bottom = (rect.loc.y + rect.size.h).ceil();
    let texels_x = texture.w / rect.size.w;
    let texels_y = texture.h / rect.size.h;
    let geometry = Rectangle::new(
        Point::from((left as i32, top as i32)),
        ((right - left) as i32, (bottom - top) as i32).into(),
    );
    let src = Rectangle::new(
        Point::from((
            (left - rect.loc.x) * texels_x,
            (top - rect.loc.y) * texels_y,
        )),
        ((right - left) * texels_x, (bottom - top) * texels_y).into(),
    );
    Some((geometry, src))
}

#[derive(Debug)]
pub struct ClippedMemoryElement {
    inner: ExactMemoryElement,
    program: GlesTexProgram,
    clip_enabled: bool,
    clip_rect: PreciseLogicalRect,
    clip_radius: f32,
    scale: f32,
}

#[derive(Debug)]
struct ClippedMemoryProgram(GlesTexProgram);

impl ClippedMemoryElement {
    pub fn new(
        renderer: &mut GlesRenderer,
        inner: ExactMemoryElement,
        scale: Scale<f64>,
        element_rect: LogicalRect,
        clip_rect: LogicalRect,
        clip_radius: i32,
        element_rect_precise: Option<PreciseLogicalRect>,
        clip_rect_precise: Option<PreciseLogicalRect>,
        clip_radius_precise: Option<f32>,
    ) -> Result<Self, GlesError> {
        let program = Self::program(renderer)?;

        // The clip is in texel space: the whole buffer spans the element rect.
        let size = inner.texture_size();
        let area_width = (size.w.round().max(1.0)) as i32;
        let area_height = (size.h.round().max(1.0)) as i32;
        let element_rect_precise = element_rect_precise.unwrap_or(PreciseLogicalRect {
            x: element_rect.x as f32,
            y: element_rect.y as f32,
            width: element_rect.width as f32,
            height: element_rect.height as f32,
        });
        let clip_rect_precise = clip_rect_precise.unwrap_or(PreciseLogicalRect {
            x: clip_rect.x as f32,
            y: clip_rect.y as f32,
            width: clip_rect.width as f32,
            height: clip_rect.height as f32,
        });
        let clip_rect = snapped_precise_logical_rect_in_area_space(
            clip_rect_precise,
            element_rect_precise,
            area_width,
            area_height,
            Point::<i32, Logical>::from((0, 0)),
            scale,
        );
        let radius_scale_x = area_width as f32 / element_rect_precise.width.max(0.0001);
        let radius_scale_y = area_height as f32 / element_rect_precise.height.max(0.0001);
        let radius_scale = radius_scale_x.min(radius_scale_y).max(0.0);

        Ok(Self {
            inner,
            program,
            clip_enabled: true,
            clip_rect: PreciseLogicalRect {
                x: clip_rect.x,
                y: clip_rect.y,
                width: clip_rect.width,
                height: clip_rect.height,
            },
            clip_radius: clip_radius_precise.unwrap_or(clip_radius as f32).max(0.0) * radius_scale,
            scale: 1.0,
        })
    }

    /// No clip: only the edge fade of a buffer drawn at a fractional rect
    /// (see `ExactMemoryElement::with_subpixel_rect`).
    pub fn unclipped(
        renderer: &mut GlesRenderer,
        inner: ExactMemoryElement,
    ) -> Result<Self, GlesError> {
        Ok(Self {
            inner,
            program: Self::program(renderer)?,
            clip_enabled: false,
            clip_rect: PreciseLogicalRect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
            clip_radius: 0.0,
            scale: 1.0,
        })
    }

    fn program(renderer: &mut GlesRenderer) -> Result<GlesTexProgram, GlesError> {
        if renderer
            .egl_context()
            .user_data()
            .get::<ClippedMemoryProgram>()
            .is_none()
        {
            let compiled = ClippedMemoryProgram(renderer.compile_custom_texture_shader(
                include_str!("clipped_memory.frag"),
                &[
                    UniformName::new(
                        "element_size",
                        smithay::backend::renderer::gles::UniformType::_2f,
                    ),
                    UniformName::new(
                        "render_scale",
                        smithay::backend::renderer::gles::UniformType::_1f,
                    ),
                    UniformName::new(
                        "clip_enabled",
                        smithay::backend::renderer::gles::UniformType::_1f,
                    ),
                    UniformName::new(
                        "clip_rect",
                        smithay::backend::renderer::gles::UniformType::_4f,
                    ),
                    UniformName::new(
                        "clip_radius",
                        smithay::backend::renderer::gles::UniformType::_4f,
                    ),
                    UniformName::new(
                        "edge_fade",
                        smithay::backend::renderer::gles::UniformType::_1f,
                    ),
                ],
            )?);
            renderer
                .egl_context()
                .user_data()
                .insert_if_missing(|| compiled);
        }

        Ok(renderer
            .egl_context()
            .user_data()
            .get::<ClippedMemoryProgram>()
            .expect("clipped memory shader should be cached")
            .0
            .clone())
    }

    fn uniforms(&self) -> Vec<Uniform<'static>> {
        let size = self.inner.texture_size();
        let element_width = size.w as f32;
        let element_height = size.h as f32;
        let radius = self.clip_radius.max(0.0);
        let flag = |on: bool| if on { 1.0f32 } else { 0.0f32 };

        vec![
            Uniform::new("element_size", [element_width, element_height]),
            Uniform::new("render_scale", self.scale.max(0.0001)),
            Uniform::new("clip_enabled", flag(self.clip_enabled)),
            Uniform::new("edge_fade", flag(self.inner.is_subpixel())),
            Uniform::new(
                "clip_rect",
                [
                    self.clip_rect.x,
                    self.clip_rect.y,
                    self.clip_rect.width,
                    self.clip_rect.height,
                ],
            ),
            Uniform::new("clip_radius", [radius, radius, radius, radius]),
        ]
    }
}

impl Element for ClippedMemoryElement {
    fn id(&self) -> &Id {
        self.inner.id()
    }

    fn current_commit(&self) -> CommitCounter {
        self.inner.current_commit()
    }

    fn geometry(&self, scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.inner.geometry(scale)
    }

    fn src(&self) -> Rectangle<f64, Buffer> {
        self.inner.src()
    }

    fn transform(&self) -> Transform {
        self.inner.transform()
    }

    fn damage_since(
        &self,
        scale: Scale<f64>,
        commit: Option<CommitCounter>,
    ) -> DamageSet<i32, Physical> {
        self.inner.damage_since(scale, commit)
    }

    fn opaque_regions(&self, _scale: Scale<f64>) -> OpaqueRegions<i32, Physical> {
        OpaqueRegions::default()
    }

    fn alpha(&self) -> f32 {
        self.inner.alpha()
    }

    fn kind(&self) -> Kind {
        self.inner.kind()
    }
}

impl RenderElement<GlesRenderer> for ClippedMemoryElement {
    fn draw(
        &self,
        frame: &mut GlesFrame<'_, '_>,
        src: Rectangle<f64, Buffer>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        opaque_regions: &[Rectangle<i32, Physical>],
        cache: Option<&smithay::utils::user_data::UserDataMap>,
    ) -> Result<(), GlesError> {
        frame.override_default_tex_program(self.program.clone(), self.uniforms());
        let result = RenderElement::<GlesRenderer>::draw(
            &self.inner,
            frame,
            src,
            dst,
            damage,
            opaque_regions,
            cache,
        );
        frame.clear_tex_program_override();
        result
    }

    fn underlying_storage(&self, _renderer: &mut GlesRenderer) -> Option<UnderlyingStorage<'_>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subpixel_cover_maps_the_buffer_onto_the_exact_rect() {
        // An 18 texel light drawn 17.6 px wide from x = -0.8.
        let rect = Rectangle::new(Point::from((-0.8, -0.8)), (17.6, 17.6).into());
        let (geometry, src) = subpixel_cover(rect, Size::from((18.0, 18.0))).expect("a cover");
        assert_eq!(
            geometry,
            Rectangle::new(Point::from((-1, -1)), (18, 18).into())
        );
        let texel = 18.0 / 17.6;
        assert!((src.loc.x + 0.2 * texel).abs() < 1e-9);
        assert!((src.size.w - 18.0 * texel).abs() < 1e-9);
        // The pixel grid's left edge maps to -0.2 px of the rect, so the
        // buffer's first texel starts 0.2 px inside the cover.
        let buffer_left_px = geometry.loc.x as f64 + (0.0 - src.loc.x) / texel;
        assert!((buffer_left_px - rect.loc.x).abs() < 1e-9);
    }

    #[test]
    fn subpixel_cover_skips_an_empty_rect() {
        let rect = Rectangle::new(Point::from((0.5, 0.5)), (0.0, 4.0).into());
        assert!(subpixel_cover(rect, Size::from((4.0, 4.0))).is_none());
    }
}
