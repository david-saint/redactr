//! Following a redaction through an animation.
//!
//! The patch under a box on one frame (the anchor) is searched for on the
//! following frames by template matching: normalized cross-correlation on
//! luminance, first on a shrunken copy of the frame around where the patch is
//! expected, then refined at full size. A few scales are tried on every frame
//! so the box follows zooming as well as scrolling.
//!
//! Two templates are tried on every frame: the anchor patch itself, which
//! can't drift, and the per-pixel median of the last few matched patches,
//! which drops anything that moves across the content (such as the mouse
//! cursor being over it when the box was drawn).

use crate::animation::GifDocument;
use wasm_bindgen::prelude::*;

/// Matches scoring below this are treated as lost.
const MIN_SCORE: f32 = 0.55;
/// ...as are matches this far below the run's typical score: a sudden drop
/// usually means a look-alike, not the content itself.
const MAX_SCORE_DROP: f32 = 0.2;
/// Stop after this many lost frames in a row; the box holds its course
/// through shorter dips (e.g. the cursor passing over the text).
const MAX_MISSES: usize = 6;
/// Candidates must overlap the frame by at least this fraction of the template.
const MIN_OVERLAP: f64 = 0.3;
/// Search radius (full-size pixels) around the predicted position.
const BASE_RADIUS: f64 = 48.0;
/// Coarse search scales, relative to the previous frame's scale.
/// (Full-size refinement covers the steps in between.)
const COARSE_SCALES: [f64; 5] = [0.92, 0.96, 1.0, 1.04, 1.08];
/// First refinement scales, relative to the best coarse scale (finer
/// steps follow). Wider than the coarse spacing needs, which lets the scale
/// recover after drifting while something covered the content.
const FINE_SCALES: [f64; 6] = [0.97, 0.98, 0.99, 1.01, 1.02, 1.03];
/// A match found only by the wide fallback search must be this strong:
/// jumping far is how a tracker latches onto look-alike content.
const WIDE_MIN_SCORE: f32 = 0.75;
/// Context kept around template patches (pixels, at the anchor's size), so
/// contrast normalization sees the same surroundings as in the frame.
const CONTEXT: f64 = 12.0;
/// Matched patches kept for the median template.
const HISTORY: usize = 5;
/// Bias towards the predicted position, so a repeated pattern nearby (the
/// same text on the next line) doesn't steal the match.
const DISTANCE_PENALTY: f32 = 0.15;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }

    /// Fraction of the box inside a `width`×`height` frame.
    fn visible_fraction(&self, width: usize, height: usize) -> f64 {
        let x0 = self.x.max(0.0);
        let y0 = self.y.max(0.0);
        let x1 = (self.x + self.w).min(width as f64);
        let y1 = (self.y + self.h).min(height as f64);
        if x1 <= x0 || y1 <= y0 {
            return 0.0;
        }
        (x1 - x0) * (y1 - y0) / (self.w * self.h)
    }
}

/// A grayscale image.
#[derive(Clone, Debug)]
pub struct Luma {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

impl Luma {
    /// Luminance of RGBA pixels, with transparent pixels as black.
    pub fn from_rgba(rgba: &[u8], width: usize, height: usize) -> Luma {
        let data = rgba
            .chunks_exact(4)
            .map(|p| {
                let a = p[3] as f32 / 255.0;
                (0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32) * a
            })
            .collect();
        Luma {
            width,
            height,
            data,
        }
    }

    /// Shrink by an integer factor, averaging each block.
    fn downsample(&self, factor: usize) -> Luma {
        if factor <= 1 {
            return self.clone();
        }
        let width = (self.width / factor).max(1);
        let height = (self.height / factor).max(1);
        let mut data = vec![0.0; width * height];
        for y in 0..height {
            for x in 0..width {
                let mut sum = 0.0;
                let mut n = 0.0;
                for sy in y * factor..((y + 1) * factor).min(self.height) {
                    let row = sy * self.width;
                    for sx in x * factor..((x + 1) * factor).min(self.width) {
                        sum += self.data[row + sx];
                        n += 1.0;
                    }
                }
                data[y * width + x] = if n > 0.0 { sum / n } else { 0.0 };
            }
        }
        Luma {
            width,
            height,
            data,
        }
    }

    /// The area `rect` resampled to a `width`×`height` image: averaging the
    /// covered pixels when shrinking, interpolating when enlarging. Edges
    /// are clamped.
    fn crop(&self, rect: Rect, width: usize, height: usize) -> Luma {
        let cols = axis_taps(rect.x, rect.w, width, self.width);
        let rows = axis_taps(rect.y, rect.h, height, self.height);

        // Horizontal pass over just the source rows the vertical pass reads.
        let first_row = rows.iter().flatten().map(|t| t.0).min().unwrap_or(0);
        let last_row = rows.iter().flatten().map(|t| t.0).max().unwrap_or(0);
        let mut across = vec![0.0f32; (last_row - first_row + 1) * width];
        for r in first_row..=last_row {
            let src = &self.data[r * self.width..(r + 1) * self.width];
            let out = &mut across[(r - first_row) * width..(r - first_row + 1) * width];
            for (o, taps) in out.iter_mut().zip(&cols) {
                *o = taps.iter().map(|&(i, w)| src[i] * w).sum();
            }
        }

        let mut data = vec![0.0f32; width * height];
        for (y, taps) in rows.iter().enumerate() {
            let out = &mut data[y * width..(y + 1) * width];
            for &(r, w) in taps {
                let row = &across[(r - first_row) * width..(r - first_row + 1) * width];
                for (o, v) in out.iter_mut().zip(row) {
                    *o += v * w;
                }
            }
        }
        Luma {
            width,
            height,
            data,
        }
    }

    /// The whole image resampled to a new size.
    fn resize(&self, width: usize, height: usize) -> Luma {
        let full = Rect {
            x: 0.0,
            y: 0.0,
            w: self.width as f64,
            h: self.height as f64,
        };
        self.crop(full, width.max(1), height.max(1))
    }

    /// Local contrast, squashed: each pixel minus the average around it,
    /// through a soft clamp. Every stroke then counts about the same, so a small
    /// bright object (a mouse cursor) can't outweigh thin, dim text when
    /// matching, and overall brightness changes don't matter.
    fn normalized(&self) -> Luma {
        const RADIUS: usize = 3;
        const SOFTNESS: f32 = 24.0;
        let (w, h) = (self.width, self.height);
        // Summed-area table for fast box averages.
        let mut sat = vec![0.0f64; (w + 1) * (h + 1)];
        for y in 0..h {
            let mut row = 0.0;
            for x in 0..w {
                row += self.data[y * w + x] as f64;
                sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
            }
        }
        let mut data = Vec::with_capacity(w * h);
        for y in 0..h {
            let (y0, y1) = (y.saturating_sub(RADIUS), (y + RADIUS + 1).min(h));
            for x in 0..w {
                let (x0, x1) = (x.saturating_sub(RADIUS), (x + RADIUS + 1).min(w));
                let sum = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0]
                    + sat[y0 * (w + 1) + x0];
                let mean = (sum / ((x1 - x0) * (y1 - y0)) as f64) as f32;
                let v = (self.data[y * w + x] - mean) / SOFTNESS;
                data.push(v / (1.0 + v.abs()));
            }
        }
        Luma {
            width: w,
            height: h,
            data,
        }
    }

    /// The `width`×`height` pixels starting at (`x`, `y`), clamped to the image.
    fn sub(&self, x: usize, y: usize, width: usize, height: usize) -> Luma {
        let mut data = Vec::with_capacity(width * height);
        for yy in y..y + height {
            let row = yy.min(self.height - 1) * self.width;
            for xx in x..x + width {
                data.push(self.data[row + xx.min(self.width - 1)]);
            }
        }
        Luma {
            width,
            height,
            data,
        }
    }

    /// Per-pixel median of same-sized images.
    fn median(images: &[Luma]) -> Luma {
        let first = &images[0];
        let mut values = Vec::with_capacity(images.len());
        let data = (0..first.data.len())
            .map(|i| {
                values.clear();
                values.extend(images.iter().map(|img| img.data[i]));
                values.sort_by(|a, b| a.total_cmp(b));
                values[values.len() / 2]
            })
            .collect();
        Luma {
            width: first.width,
            height: first.height,
            data,
        }
    }

    fn variance(&self) -> f32 {
        let n = self.data.len() as f32;
        let mean = self.data.iter().sum::<f32>() / n;
        self.data
            .iter()
            .map(|v| (v - mean) * (v - mean))
            .sum::<f32>()
            / n
    }
}

/// For each of `out` samples across the source span `start..start + len` of
/// an axis `size` pixels long: the source pixels to blend and their weights.
fn axis_taps(start: f64, len: f64, out: usize, size: usize) -> Vec<Vec<(usize, f32)>> {
    let step = len / out as f64;
    let clamp = |i: f64| (i.max(0.0) as usize).min(size - 1);
    (0..out)
        .map(|i| {
            if step > 1.0 {
                // Shrinking: average the pixels the sample covers.
                let (a, b) = (start + i as f64 * step, start + (i + 1) as f64 * step);
                let mut taps = Vec::new();
                let mut j = a.floor();
                while j < b {
                    let cover = (b.min(j + 1.0) - a.max(j)) / step;
                    if cover > 0.0 {
                        taps.push((clamp(j), cover as f32));
                    }
                    j += 1.0;
                }
                taps
            } else {
                // Enlarging: interpolate between the two nearest pixels.
                let c = start + (i as f64 + 0.5) * step - 0.5;
                let j = c.floor();
                let f = (c - j) as f32;
                vec![(clamp(j), 1.0 - f), (clamp(j + 1.0), f)]
            }
        })
        .collect()
}

/// Normalized cross-correlation of `template` placed at (`x0`, `y0`) in
/// `frame`, over the part that lies inside the frame. `None` when too little
/// of the template is inside or either side is flat.
fn ncc(frame: &Luma, template: &Luma, x0: i64, y0: i64) -> Option<f32> {
    let tx0 = (-x0).max(0) as usize;
    let ty0 = (-y0).max(0) as usize;
    let tx1 = (frame.width as i64 - x0).clamp(0, template.width as i64) as usize;
    let ty1 = (frame.height as i64 - y0).clamp(0, template.height as i64) as usize;
    if tx1 <= tx0 || ty1 <= ty0 {
        return None;
    }
    let n = ((tx1 - tx0) * (ty1 - ty0)) as f64;
    if n < MIN_OVERLAP * (template.width * template.height) as f64 {
        return None;
    }

    let (mut st, mut sf, mut stt, mut sff, mut stf) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for ty in ty0..ty1 {
        let fy = (y0 + ty as i64) as usize;
        let t_row = &template.data[ty * template.width..(ty + 1) * template.width];
        let f_start = fy * frame.width + (x0 + tx0 as i64) as usize;
        let f_row = &frame.data[f_start..f_start + (tx1 - tx0)];
        for (t, f) in t_row[tx0..tx1].iter().zip(f_row) {
            let (t, f) = (*t as f64, *f as f64);
            st += t;
            sf += f;
            stt += t * t;
            sff += f * f;
            stf += t * f;
        }
    }
    let vt = stt - st * st / n;
    let vf = sff - sf * sf / n;
    // Flat areas (e.g. empty background) can't be matched meaningfully.
    if vt < 1e-3 * n || vf < 1e-3 * n {
        return None;
    }
    Some(((stf - st * sf / n) / (vt * vf).sqrt()) as f32)
}

/// A frame prepared for matching: its pixels plus running sums along each
/// row of the values and their squares, so a window's mean and variance
/// cost one lookup per row compared.
struct Field {
    img: Luma,
    sum: Vec<f64>,
    sum2: Vec<f64>,
}

impl Field {
    fn new(img: Luma) -> Field {
        let (w, h) = (img.width, img.height);
        let mut sum = vec![0.0; (w + 1) * h];
        let mut sum2 = vec![0.0; (w + 1) * h];
        for y in 0..h {
            for x in 0..w {
                let v = img.data[y * w + x] as f64;
                let i = y * (w + 1) + x;
                sum[i + 1] = sum[i] + v;
                sum2[i + 1] = sum2[i] + v * v;
            }
        }
        Field { img, sum, sum2 }
    }

    /// Sum and sum of squares of every `step`th row of a window lying inside
    /// the image.
    fn window(&self, x: usize, y: usize, w: usize, h: usize, step: usize) -> (f64, f64) {
        let stride = self.img.width + 1;
        let (mut s, mut s2) = (0.0, 0.0);
        for row in (y..y + h).step_by(step) {
            let (a, b) = (row * stride + x, row * stride + x + w);
            s += self.sum[b] - self.sum[a];
            s2 += self.sum2[b] - self.sum2[a];
        }
        (s, s2)
    }
}

/// A template with its sums precomputed. Tall templates are compared on
/// every `step`th row only: alignment stays exact (no resampling), at a
/// fraction of the cost.
struct Template {
    img: Luma,
    step: usize,
    sum: f64,
    sum2: f64,
}

/// Rows compared from tall templates.
const TEMPLATE_ROWS: usize = 32;

impl Template {
    fn new(img: Luma) -> Template {
        let step = (img.height / TEMPLATE_ROWS).max(1);
        let (mut sum, mut sum2) = (0.0, 0.0);
        for row in (0..img.height).step_by(step) {
            for &v in &img.data[row * img.width..(row + 1) * img.width] {
                sum += v as f64;
                sum2 += (v as f64) * (v as f64);
            }
        }
        Template {
            img,
            step,
            sum,
            sum2,
        }
    }
}

/// Normalized cross-correlation of `t` placed at (`x0`, `y0`) in `field`.
/// Windows inside the frame take a fast path; others fall back to `ncc`.
fn score(field: &Field, t: &Template, x0: i64, y0: i64) -> Option<f32> {
    let (tw, th) = (t.img.width, t.img.height);
    let inside = x0 >= 0
        && y0 >= 0
        && x0 as usize + tw <= field.img.width
        && y0 as usize + th <= field.img.height;
    if !inside {
        return ncc(&field.img, &t.img, x0, y0);
    }
    let (x0, y0) = (x0 as usize, y0 as usize);
    let n = (tw * th.div_ceil(t.step)) as f64;
    let (sf, sff) = field.window(x0, y0, tw, th, t.step);

    // The only per-pixel work: the cross term, in four lanes.
    let mut acc = [0.0f32; 4];
    for ty in (0..th).step_by(t.step) {
        let t_row = &t.img.data[ty * tw..(ty + 1) * tw];
        let f_start = (y0 + ty) * field.img.width + x0;
        let f_row = &field.img.data[f_start..f_start + tw];
        let mut tc = t_row.chunks_exact(4);
        let mut fc = f_row.chunks_exact(4);
        for (a, b) in (&mut tc).zip(&mut fc) {
            for i in 0..4 {
                acc[i] += a[i] * b[i];
            }
        }
        for (a, b) in tc.remainder().iter().zip(fc.remainder()) {
            acc[0] += a * b;
        }
    }
    let stf = acc.iter().map(|&v| v as f64).sum::<f64>();

    let vt = t.sum2 - t.sum * t.sum / n;
    let vf = sff - sf * sf / n;
    if vt < 1e-3 * n || vf < 1e-3 * n {
        return None;
    }
    Some(((stf - t.sum * sf / n) / (vt * vf).sqrt()) as f32)
}

#[derive(Clone, Copy, Debug)]
struct Match {
    rect: Rect,
    scale: f64,
    score: f32,
}

/// Search only the part of `raw` that can hold a match within `radius` of
/// `center`: preparing a frame for matching is a large share of the work,
/// and the content is never far from where it was.
fn search_region(
    raw: &Luma,
    factor: usize,
    patches: &[&Luma],
    anchor: Rect,
    center: (f64, f64),
    scale: f64,
    radius: f64,
) -> Option<Match> {
    // Room for the largest template tried (coarse, then fine scale steps),
    // its context, and the search radius.
    let grow = scale * COARSE_SCALES[COARSE_SCALES.len() - 1] * FINE_SCALES[FINE_SCALES.len() - 1];
    let d = factor as f64;
    let half_w = anchor.w * grow / 2.0 + CONTEXT * grow + radius + 2.0 * d;
    let half_h = anchor.h * grow / 2.0 + CONTEXT * grow + radius + 2.0 * d;
    let x0 = ((center.0 - half_w).max(0.0) / d).floor() * d;
    let y0 = ((center.1 - half_h).max(0.0) / d).floor() * d;
    let x1 = (center.0 + half_w).min(raw.width as f64).ceil();
    let y1 = (center.1 + half_h).min(raw.height as f64).ceil();
    if x1 - x0 < 1.0 || y1 - y0 < 1.0 {
        return None;
    }
    let region = raw.sub(
        x0 as usize,
        y0 as usize,
        (x1 - x0) as usize,
        (y1 - y0) as usize,
    );
    let frame = Field::new(region.normalized());
    let coarse = Field::new(region.downsample(factor).normalized());
    // When zoomed in, refine on a shrunk frame so templates stay about the
    // size they were drawn at, then place exactly at full size.
    let level = (scale.floor() as usize).clamp(1, factor);
    let shrunk =
        (level > 1 && level != factor).then(|| Field::new(region.downsample(level).normalized()));
    let refine_on = match (level, &shrunk) {
        (1, _) => (&frame, 1),
        (_, Some(f)) => (f, level),
        _ => (&coarse, factor),
    };
    let local = (center.0 - x0, center.1 - y0);
    search(
        &frame, &coarse, factor, refine_on, patches, anchor, local, scale, radius,
    )
    .map(|mut m| {
        m.rect.x += x0;
        m.rect.y += y0;
        m
    })
}

/// `rect` grown by `margin` on every side.
fn expand(rect: Rect, margin: f64) -> Rect {
    Rect {
        x: rect.x - margin,
        y: rect.y - margin,
        w: rect.w + 2.0 * margin,
        h: rect.h + 2.0 * margin,
    }
}

/// A template at scale `s`, prepared exactly like a frame shrunk by
/// `factor`: the raw patch (anchor area plus `CONTEXT`) resized, shrunk,
/// contrast-normalized, then cut to the anchor area.
fn make_template(raw: &Luma, anchor: Rect, s: f64, factor: usize) -> Luma {
    let d = factor as f64;
    let (w, h) = ((anchor.w * s).round().max(d), (anchor.h * s).round().max(d));
    // Context in whole shrunk pixels, so the cut lines up.
    let m = (CONTEXT * s / d).ceil().max(1.0) * d;
    let shrunk = raw
        .resize(((w + 2.0 * m) / d) as usize, ((h + 2.0 * m) / d) as usize)
        .normalized();
    let inner = |v: f64| ((v / d).floor() as usize).max(1);
    shrunk.sub(inner(m), inner(m), inner(w), inner(h))
}

/// Search one frame for any of the template patches around `center`.
fn search(
    frame: &Field,
    coarse: &Field,
    factor: usize,
    refine_on: (&Field, usize),
    patches: &[&Luma],
    anchor: Rect,
    center: (f64, f64),
    scale: f64,
    radius: f64,
) -> Option<Match> {
    let d = factor as f64;
    let r = (radius / d).ceil() as i64;

    // Coarse: every position in the radius, at a few scales. Keep the best
    // overall and the best at the previous scale: shrunk this far, a few
    // percent of zoom barely shows, so the scale is settled at full size.
    let mut coarse_best: Option<(f32, f64, i64, i64)> = None;
    let mut same_scale_best: Option<(f32, f64, i64, i64)> = None;
    for (k, patch) in COARSE_SCALES
        .iter()
        .flat_map(|k| patches.iter().map(move |p| (*k, *p)))
    {
        let s = (scale * k).clamp(0.1, 10.0);
        let (w, h) = (anchor.w * s, anchor.h * s);
        let template = Template::new(make_template(patch, anchor, s, factor));
        let cx = ((center.0 - w / 2.0) / d).round() as i64;
        let cy = ((center.1 - h / 2.0) / d).round() as i64;
        for dy in -r..=r {
            for dx in -r..=r {
                let Some(score) = score(coarse, &template, cx + dx, cy + dy) else {
                    continue;
                };
                let dist = ((dx * dx + dy * dy) as f64).sqrt() / r.max(1) as f64;
                let biased = score - DISTANCE_PENALTY * (dist * dist) as f32;
                let candidate = Some((biased, s, cx + dx, cy + dy));
                if coarse_best.is_none_or(|(b, ..)| biased > b) {
                    coarse_best = candidate;
                }
                if k == 1.0 && same_scale_best.is_none_or(|(b, ..)| biased > b) {
                    same_scale_best = candidate;
                }
            }
        }
    }
    // Fine: full size, around each coarse candidate.
    let mut best: Option<Match> = None;
    let same =
        same_scale_best.filter(|c| coarse_best.is_none_or(|b| (b.1, b.2, b.3) != (c.1, c.2, c.3)));
    let to_center = |(_, s, bx, by): (f32, f64, i64, i64)| {
        (
            s,
            (
                bx as f64 * d + anchor.w * s / 2.0,
                by as f64 * d + anchor.h * s / 2.0,
            ),
        )
    };
    // Also where the motion predicts it: shrunk frames can miss content that
    // moved by a fraction of the shrink factor, especially fine textures.
    let predicted = (scale, center);
    let candidates = [
        coarse_best.map(to_center),
        same.map(to_center),
        Some(predicted),
    ];
    for (coarse_scale, center) in candidates.into_iter().flatten() {
        let refined = refine(
            frame,
            refine_on,
            patches,
            anchor,
            center,
            coarse_scale,
            factor,
        );
        if refined.is_some_and(|r| best.is_none_or(|b| r.score > b.score)) {
            best = refined;
        }
        if best.is_some_and(|b| b.score >= 0.98) {
            break;
        }
    }
    best
}

/// Best match of any template at scale `s`, with its center within
/// `radius` (x, y) pixels of `center`.
fn match_at(
    (frame, level): (&Field, usize),
    patches: &[&Luma],
    anchor: Rect,
    center: (f64, f64),
    s: f64,
    radius: (i64, i64),
) -> Option<Match> {
    let l = level as f64;
    let (w, h) = (anchor.w * s, anchor.h * s);
    let x0 = ((center.0 - w / 2.0) / l).round() as i64;
    let y0 = ((center.1 - h / 2.0) / l).round() as i64;
    // Radius given in full-size pixels.
    let radius = (
        (radius.0 as f64 / l).ceil() as i64,
        (radius.1 as f64 / l).ceil() as i64,
    );
    let mut best: Option<Match> = None;
    for patch in patches {
        let template = Template::new(make_template(patch, anchor, s, level));
        for dy in -radius.1..=radius.1 {
            for dx in -radius.0..=radius.0 {
                let Some(score) = score(frame, &template, x0 + dx, y0 + dy) else {
                    continue;
                };
                if best.is_none_or(|b| score > b.score) {
                    best = Some(Match {
                        rect: Rect {
                            x: (x0 + dx) as f64 * l,
                            y: (y0 + dy) as f64 * l,
                            w,
                            h,
                        },
                        scale: s,
                        score,
                    });
                }
            }
        }
    }
    best
}

/// Settle position and scale at full size. Matches of thin text are sharp in
/// both (1% of scale is a couple of pixels at the edges of a wide box), so
/// scale is narrowed in steps, each search staying close to the last.
fn refine(
    full: &Field,
    on: (&Field, usize),
    patches: &[&Luma],
    anchor: Rect,
    center: (f64, f64),
    scale: f64,
    factor: usize,
) -> Option<Match> {
    // The coarse grid is accurate to half a shrunk pixel.
    let r = factor as i64 / 2 + 2;
    // Settle on whichever template fits best, then refine with it alone.
    let (mut best, patch) = patches
        .iter()
        .filter_map(|p| match_at(on, &[*p], anchor, center, scale, (r, r)).map(|m| (m, *p)))
        .max_by(|a, b| a.0.score.total_cmp(&b.0.score))?;
    let patches = &[patch][..];
    // Refined on a shrunk frame: place it exactly at full size.
    let place = |m: Match| {
        if on.1 == 1 {
            return m;
        }
        let l = on.1 as i64;
        match_at((full, 1), patches, anchor, m.rect.center(), m.scale, (l, l)).unwrap_or(m)
    };
    // Near-perfect already (the usual case for still or scrolling content).
    if best.score >= 0.98 {
        return Some(place(best));
    }
    for steps in [FINE_SCALES.as_slice(), &[0.995, 1.005], &[0.9975, 1.0025]] {
        let base = best;
        for k in steps {
            // Zooming moves the box's center unless it's the zoom center:
            // allow up to half the change in size, plus a pixel.
            let grow = |side: f64| ((side * base.scale * (k - 1.0).abs()) / 2.0).ceil() as i64 + 1;
            let radius = (grow(anchor.w), grow(anchor.h));
            let m = match_at(
                on,
                patches,
                anchor,
                base.rect.center(),
                base.scale * k,
                radius,
            );
            if m.is_some_and(|m| m.score > best.score) {
                best = m.unwrap();
            }
        }
    }
    Some(place(best))
}

/// One frame of a tracking run.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackStep {
    pub frame: usize,
    pub rect: Rect,
    /// Match quality, up to 1; 0 when the box was held on its course
    /// because the content wasn't found.
    pub score: f32,
}

/// Follow the patch under `anchor` on frame `from` to each frame towards `to`
/// (either direction). Stops early when the patch is lost for several frames
/// or leaves the frame. `frame_at` supplies frames; `progress` is called with
/// the number of frames done.
pub fn track(
    mut frame_at: impl FnMut(usize) -> Result<Luma, String>,
    from: usize,
    anchor: Rect,
    to: usize,
    mut progress: impl FnMut(usize),
) -> Result<Vec<TrackStep>, String> {
    let first = frame_at(from)?;
    if anchor.w < 2.0 || anchor.h < 2.0 || anchor.visible_fraction(first.width, first.height) < 0.5
    {
        return Err("Draw the box over the content to follow".into());
    }
    let size = (anchor.w.round() as usize, anchor.h.round() as usize);
    if first.crop(anchor, size.0, size.1).variance() < 4.0 {
        return Err("There is no detail under the box to follow".into());
    }
    // Raw patches with context, all at the anchor's size.
    let patch_size = (
        (anchor.w + 2.0 * CONTEXT).round() as usize,
        (anchor.h + 2.0 * CONTEXT).round() as usize,
    );
    let anchor_patch = first.crop(expand(anchor, CONTEXT), patch_size.0, patch_size.1);
    let mut history = std::collections::VecDeque::from([anchor_patch.clone()]);
    let mut median = anchor_patch.clone();

    // How far to shrink frames for the coarse search: enough to keep the
    // template small at the size the box was drawn (but at least 3px thick;
    // at most 4x for thin boxes, which thin text survives, more for big ones
    // so they stay quick), times the zoom since then.
    let min_side = anchor.w.min(anchor.h);
    let cap = ((min_side / 24.0).floor() as usize).clamp(4, 8);
    let base_factor = ((anchor.w * anchor.h / 400.0).sqrt().ceil() as usize)
        .min((min_side / 3.0).floor().max(1.0) as usize)
        .clamp(1, cap);
    let coarse_factor = |scale: f64| (base_factor * (scale.round() as usize).max(1)).min(32);

    let mut steps = Vec::new();
    let mut prev = Match {
        rect: anchor,
        scale: 1.0,
        score: 1.0,
    };
    let mut velocity = (0.0, 0.0);
    let mut misses = 0;
    // Running average of accepted scores.
    let mut typical: Option<f32> = None;
    let frames: Vec<usize> = if to >= from {
        (from + 1..=to).collect()
    } else {
        (to..from).rev().collect()
    };

    for (done, frame_index) in frames.into_iter().enumerate() {
        let raw = frame_at(frame_index)?;
        let factor = coarse_factor(prev.scale);
        let (pcx, pcy) = prev.rect.center();
        let width_height = (raw.width, raw.height);
        let prev_visible = prev.rect.visible_fraction(width_height.0, width_height.1);
        let mut predicted = (pcx + velocity.0, pcy + velocity.1);
        let speed = (velocity.0 * velocity.0 + velocity.1 * velocity.1).sqrt();
        let (w, h) = (prev.rect.w, prev.rect.h);
        let mut course = Rect {
            x: predicted.0 - w / 2.0,
            y: predicted.1 - h / 2.0,
            w,
            h,
        };
        if course.visible_fraction(width_height.0, width_height.1) == 0.0 {
            if prev_visible < 1.0 {
                // It was already leaving and is now gone.
                break;
            }
            // Fully in view a frame ago: the motion estimate is off, not the
            // content gone. Look where it was.
            velocity = (0.0, 0.0);
            predicted = (pcx, pcy);
            course = prev.rect;
        }
        // Partly out and moving further out: misses here are the content
        // leaving, not being lost, so the box keeps covering what's left.
        let leaving =
            course.visible_fraction(width_height.0, width_height.1) < prev_visible.min(1.0);

        // The median adds nothing until other patches have been matched.
        let both = [&anchor_patch, &median];
        let patches = if history.len() > 1 {
            &both[..]
        } else {
            &both[..1]
        };
        let mut found = search_region(
            &raw,
            factor,
            patches,
            anchor,
            predicted,
            prev.scale,
            BASE_RADIUS + speed * 1.5,
        );
        if found.is_none_or(|m| m.score < MIN_SCORE.max(typical.unwrap_or(0.0) - MAX_SCORE_DROP)) {
            // Lost: look further afield before giving up on this frame.
            let wide = raw.width.max(raw.height) as f64 / 3.0;
            // Shrunk twice as far: a wide search is otherwise very costly.
            let retry = search_region(
                &raw,
                (factor * 2).min(32),
                patches,
                anchor,
                predicted,
                prev.scale,
                wide,
            );
            if let Some(r) = retry.filter(|r| r.score >= WIDE_MIN_SCORE) {
                found = Some(r);
            }
        }

        let threshold = typical.map_or(MIN_SCORE, |t| (t - MAX_SCORE_DROP).max(MIN_SCORE));
        // A weaker match is still trusted where the motion says the content
        // should be (zooming and resampling lower scores); a look-alike sits
        // a line or more away.
        let on_course = |m: &Match| {
            let (cx, cy) = m.rect.center();
            let off = ((cx - predicted.0).powi(2) + (cy - predicted.1).powi(2)).sqrt();
            m.score >= MIN_SCORE && off <= (0.5 * prev.rect.h).max(6.0)
        };
        match found {
            Some(m) if m.score >= threshold || on_course(&m) => {
                let (cx, cy) = m.rect.center();
                velocity = (cx - pcx, cy - pcy);
                typical = Some(typical.map_or(m.score, |t| 0.7 * t + 0.3 * m.score));
                prev = m;
                misses = 0;
                history.push_back(raw.crop(
                    expand(m.rect, CONTEXT * m.scale),
                    patch_size.0,
                    patch_size.1,
                ));
                if history.len() > HISTORY {
                    history.pop_front();
                }
                median = Luma::median(history.make_contiguous());
            }
            _ => {
                // Hold the course so the box keeps covering where the content
                // is most likely to be.
                if !leaving {
                    misses += 1;
                }
                prev = Match {
                    rect: course,
                    scale: prev.scale,
                    // Estimated, not matched.
                    score: 0.0,
                };
            }
        }

        steps.push(TrackStep {
            frame: frame_index,
            rect: prev.rect,
            score: prev.score,
        });
        progress(done + 1);
        // Stop when lost for a while, or once the box is entirely outside the
        // frame (until then it covers whatever part is still showing).
        if misses >= MAX_MISSES || prev.rect.visible_fraction(raw.width, raw.height) == 0.0 {
            break;
        }
    }
    Ok(steps)
}

/// Follow the patch under a box on frame `from` towards frame `to`.
///
/// Returns `[frame, x, y, width, height, score]` for each frame tracked, in
/// order. `progress` is called with the number of frames done.
#[wasm_bindgen(js_name = trackRegion)]
pub fn track_region(
    doc: &mut GifDocument,
    from: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    to: u32,
    progress: &js_sys::Function,
) -> Result<Vec<f64>, JsValue> {
    let (w, h) = (doc.width() as usize, doc.height() as usize);
    let last = doc.frame_count().saturating_sub(1);
    let steps = track(
        |i| doc.render(i).map(|rgba| Luma::from_rgba(&rgba, w, h)),
        from as usize,
        Rect {
            x,
            y,
            w: width,
            h: height,
        },
        to.min(last) as usize,
        |done| {
            let _ = progress.call1(&JsValue::NULL, &JsValue::from(done as u32));
        },
    )
    .map_err(|e| JsValue::from_str(&e))?;

    Ok(steps
        .iter()
        .flat_map(|s| {
            [
                s.frame as f64,
                s.rect.x,
                s.rect.y,
                s.rect.w,
                s.rect.h,
                s.score as f64,
            ]
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic scene, `size`×`size`, standing in for a screen of
    /// text: lines of "words" (bars of random length and brightness) over a
    /// little noise.
    fn scene(size: usize) -> Luma {
        let mut seed = 12345u32;
        let mut rand = move |n: u32| {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            (seed >> 16) % n
        };
        let mut data: Vec<f32> = (0..size * size).map(|_| rand(30) as f32).collect();
        for line in (4..size.saturating_sub(12)).step_by(18) {
            let mut x = rand(12) as usize;
            while x < size {
                let len = 6 + rand(30) as usize;
                let shade = 120.0 + rand(120) as f32;
                for y in line..line + 9 {
                    for xx in x..(x + len).min(size) {
                        // Letter-like gaps inside each word.
                        if (xx + y * 3) % 7 != 0 {
                            data[y * size + xx] += shade;
                        }
                    }
                }
                x += len + 4 + rand(10) as usize;
            }
        }
        Luma {
            width: size,
            height: size,
            data,
        }
    }

    /// A camera over the scene: the frame shows `view` (scene coordinates)
    /// at `width`×`height`.
    fn shot(scene: &Luma, view: Rect, width: usize, height: usize) -> Luma {
        scene.crop(view, width, height)
    }

    /// Where a scene rectangle appears in a shot of `view`.
    fn project(r: Rect, view: Rect, width: usize) -> Rect {
        let s = width as f64 / view.w;
        Rect {
            x: (r.x - view.x) * s,
            y: (r.y - view.y) * s,
            w: r.w * s,
            h: r.h * s,
        }
    }

    fn assert_close(a: Rect, b: Rect, tolerance: f64) {
        for (p, q) in [(a.x, b.x), (a.y, b.y), (a.w, b.w), (a.h, b.h)] {
            assert!((p - q).abs() <= tolerance, "{a:?} vs {b:?}");
        }
    }

    #[test]
    fn follows_scrolling_content() {
        let world = scene(400);
        let target = Rect {
            x: 140.0,
            y: 148.0,
            w: 60.0,
            h: 14.0,
        };
        let view = |i: usize| Rect {
            x: 50.0,
            y: 40.0 + i as f64 * 9.0,
            w: 240.0,
            h: 160.0,
        };
        let frames: Vec<Luma> = (0..12).map(|i| shot(&world, view(i), 240, 160)).collect();

        let steps = track(
            |i| Ok(frames[i].clone()),
            0,
            project(target, view(0), 240),
            11,
            |_| {},
        )
        .unwrap();

        assert_eq!(steps.len(), 11);
        for s in &steps {
            assert!(s.score > 0.9, "{s:?}");
            assert_close(s.rect, project(target, view(s.frame), 240), 1.0);
        }
    }

    #[test]
    fn follows_zooming_content_backwards() {
        let world = scene(400);
        let target = Rect {
            x: 180.0,
            y: 190.0,
            w: 50.0,
            h: 12.0,
        };
        // Zooms in by 4% a frame around the target.
        let view = |i: usize| {
            let w = 240.0 / 1.04f64.powi(i as i32);
            let h = w * 2.0 / 3.0;
            Rect {
                x: 205.0 - w / 2.0,
                y: 196.0 - h / 2.0,
                w,
                h,
            }
        };
        let frames: Vec<Luma> = (0..10).map(|i| shot(&world, view(i), 240, 160)).collect();

        // Drawn on the last (most zoomed-in) frame, tracked back to the first.
        let steps = track(
            |i| Ok(frames[i].clone()),
            9,
            project(target, view(9), 240),
            0,
            |_| {},
        )
        .unwrap();

        assert_eq!(
            steps.iter().map(|s| s.frame).collect::<Vec<_>>(),
            (0..9).rev().collect::<Vec<_>>()
        );
        for s in &steps {
            assert!(s.score > 0.6, "{s:?}");
            let expected = project(target, view(s.frame), 240);
            assert_close(s.rect, expected, 0.06 * expected.w.max(8.0));
        }
    }

    #[test]
    fn stops_when_content_leaves_the_frame() {
        let world = scene(400);
        let target = Rect {
            x: 140.0,
            y: 60.0,
            w: 60.0,
            h: 14.0,
        };
        // Scrolls down 12px a frame, so the target moves up and out.
        let view = |i: usize| Rect {
            x: 50.0,
            y: 40.0 + i as f64 * 12.0,
            w: 240.0,
            h: 160.0,
        };
        let frames: Vec<Luma> = (0..20).map(|i| shot(&world, view(i), 240, 160)).collect();

        let steps = track(
            |i| Ok(frames[i].clone()),
            0,
            project(target, view(0), 240),
            19,
            |_| {},
        )
        .unwrap();

        // A box on every frame while any of the content shows, following it.
        let visible = |i: usize| project(target, view(i), 240).visible_fraction(240, 160) > 0.0;
        for i in 1..20 {
            if visible(i) {
                let step = steps
                    .iter()
                    .find(|s| s.frame == i)
                    .expect("frame with content has a box");
                assert_close(step.rect, project(target, view(i), 240), 1.5);
            }
        }
        // ...and it stops soon after the content is gone.
        let gone = (1..20).find(|&i| !visible(i)).unwrap();
        assert!(steps.last().unwrap().frame <= gone, "{:?}", steps.last());
    }

    #[test]
    fn covers_a_wide_box_slowly_leaving_the_frame() {
        let world = scene(500);
        let target = Rect {
            x: 120.0,
            y: 150.0,
            w: 200.0,
            h: 16.0,
        };
        // Pans right 6px a frame, so the target slides out to the left.
        let view = |i: usize| Rect {
            x: 60.0 + i as f64 * 6.0,
            y: 80.0,
            w: 240.0,
            h: 160.0,
        };
        let frames: Vec<Luma> = (0..60).map(|i| shot(&world, view(i), 240, 160)).collect();

        let steps = track(
            |i| Ok(frames[i].clone()),
            0,
            project(target, view(0), 240),
            59,
            |_| {},
        )
        .unwrap();

        for i in 1..60 {
            let truth = project(target, view(i), 240);
            if truth.visible_fraction(240, 160) == 0.0 {
                break;
            }
            let step = steps
                .iter()
                .find(|s| s.frame == i)
                .unwrap_or_else(|| panic!("no box on frame {i} with {truth:?} visible"));
            // The visible part of the content is inside the box.
            assert!(
                step.rect.x + step.rect.w >= truth.x + truth.w - 1.5,
                "{step:?} vs {truth:?}"
            );
            assert!(
                (step.rect.y - truth.y).abs() <= 1.5,
                "{step:?} vs {truth:?}"
            );
        }
    }

    #[test]
    fn prefers_the_nearby_copy_of_repeated_content() {
        // Two identical lines 20px apart; the box is on the lower one.
        let base = scene(300);
        let mut world = base.clone();
        for y in 0..14 {
            for x in 0..60 {
                let v = base.data[(100 + y) * 300 + 100 + x];
                world.data[(120 + y) * 300 + 100 + x] = v;
            }
        }
        let target = Rect {
            x: 100.0,
            y: 120.0,
            w: 60.0,
            h: 14.0,
        };
        let view = |i: usize| Rect {
            x: 40.0,
            y: 40.0 + i as f64 * 4.0,
            w: 200.0,
            h: 150.0,
        };
        let frames: Vec<Luma> = (0..8).map(|i| shot(&world, view(i), 200, 150)).collect();

        let steps = track(
            |i| Ok(frames[i].clone()),
            0,
            project(target, view(0), 200),
            7,
            |_| {},
        )
        .unwrap();

        for s in &steps {
            assert_close(s.rect, project(target, view(s.frame), 200), 1.0);
        }
    }

    #[test]
    fn holds_course_through_a_short_occlusion() {
        let world = scene(400);
        let target = Rect {
            x: 140.0,
            y: 148.0,
            w: 60.0,
            h: 14.0,
        };
        let view = |i: usize| Rect {
            x: 50.0,
            y: 40.0 + i as f64 * 5.0,
            w: 240.0,
            h: 160.0,
        };
        let mut frames: Vec<Luma> = (0..12).map(|i| shot(&world, view(i), 240, 160)).collect();
        // Frames 4 and 5: something covers the target entirely.
        for i in [4, 5] {
            let r = project(target, view(i), 240);
            for y in (r.y as usize).saturating_sub(4)..(r.y + r.h) as usize + 4 {
                for x in (r.x as usize).saturating_sub(4)..(r.x + r.w) as usize + 4 {
                    frames[i].data[y * 240 + x] = 255.0;
                }
            }
        }

        let steps = track(
            |i| Ok(frames[i].clone()),
            0,
            project(target, view(0), 240),
            11,
            |_| {},
        )
        .unwrap();

        assert_eq!(
            steps.len(),
            11,
            "kept tracking after the occlusion: {steps:?}"
        );
        for s in &steps {
            if s.frame == 4 || s.frame == 5 {
                assert_eq!(s.score, 0.0, "estimated, not matched");
            }
            assert_close(s.rect, project(target, view(s.frame), 240), 1.5);
        }
    }

    #[test]
    fn rejects_boxes_without_detail() {
        let flat = Luma {
            width: 50,
            height: 50,
            data: vec![10.0; 2500],
        };
        let err = track(
            |_| Ok(flat.clone()),
            0,
            Rect {
                x: 5.0,
                y: 5.0,
                w: 20.0,
                h: 10.0,
            },
            3,
            |_| {},
        );
        assert!(err.unwrap_err().contains("no detail"));
    }
}
