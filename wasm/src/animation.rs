//! Animated GIF support: decoding with frame compositing, and re-encoding.
//!
//! GIF frames are often partial patches drawn over earlier frames, with a
//! per-frame disposal method deciding what is left behind for the next one.
//! Redactions must be applied to the *composited* frame the viewer sees, so
//! `GifDocument` turns the stored patches back into full RGBA frames.
//!
//! `GifEncoder` writes a brand-new file from those (redacted) full frames. Only
//! pixels and timing are carried over: comments, XMP, ICC profiles and other
//! application extensions in the original file are never copied.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::num::NonZeroU64;

use color_quant::NeuQuant;
use gif::{ColorOutput, DecodeOptions, DisposalMethod, Encoder, Frame, MemoryLimit, Repeat};
use wasm_bindgen::prelude::*;

/// Largest canvas (in pixels) we agree to composite.
const MAX_CANVAS_PIXELS: u64 = 4096 * 4096;
/// Upper bound on the decoded (palette-indexed) frame data kept in memory.
/// The page may hold up to three decodes at once (editor, thumbnails, export).
const MAX_FRAME_BYTES: u64 = 256 * 1024 * 1024;
/// Memory budget for the full-canvas snapshots that make random access fast.
const CHECKPOINT_BUDGET: u64 = 64 * 1024 * 1024;
/// NeuQuant sampling factor: 1 is best quality, 30 fastest; 10 is the usual compromise.
const QUANTIZE_SPEED: i32 = 10;
/// Below this many pixels NeuQuant samples too few of them at `QUANTIZE_SPEED`,
/// so small regions are learned from every pixel instead.
const QUANTIZE_FULL_SAMPLE_PIXELS: usize = 256 * 256;
/// Frames whose changed pixels have up to this many distinct colors get a
/// median-cut palette; beyond that (photographic content) NeuQuant learns one
/// from a sample of the pixels, which is faster.
const MEDIAN_CUT_MAX_COLORS: usize = 1 << 16;

struct RawFrame {
    left: usize,
    top: usize,
    width: usize,
    height: usize,
    indices: Vec<u8>,
    /// Local color table; `None` means the global one.
    palette: Option<Vec<u8>>,
    transparent: Option<u8>,
    dispose: DisposalMethod,
    /// Delay in hundredths of a second.
    delay: u16,
}

/// A decoded GIF that renders any frame as full-canvas RGBA.
#[wasm_bindgen]
pub struct GifDocument {
    width: usize,
    height: usize,
    global_palette: Vec<u8>,
    frames: Vec<RawFrame>,
    repeat: i32,
    /// Distance (in frames) between checkpoints.
    interval: usize,
    /// `checkpoints[n]` is the canvas just before frame `n * interval` is drawn.
    checkpoints: Vec<Vec<u8>>,
    /// The canvas just before frame `.0` is drawn, so playing forward is cheap.
    cursor: Option<(usize, Vec<u8>)>,
}

impl GifDocument {
    /// Decode a GIF file. Errors are returned as user-presentable strings.
    pub fn decode(bytes: &[u8]) -> Result<GifDocument, String> {
        let mut options = DecodeOptions::new();
        options.set_color_output(ColorOutput::Indexed);
        options.set_memory_limit(MemoryLimit::Bytes(
            NonZeroU64::new(MAX_CANVAS_PIXELS).unwrap(),
        ));

        let mut decoder = options
            .read_info(bytes)
            .map_err(|e| format!("Not a valid GIF: {e}"))?;

        let width = decoder.width() as usize;
        let height = decoder.height() as usize;
        if width == 0 || height == 0 {
            return Err("GIF has an empty canvas".into());
        }
        if (width * height) as u64 > MAX_CANVAS_PIXELS {
            return Err("GIF is too large to edit in the browser".into());
        }
        let global_palette = decoder
            .global_palette()
            .map(<[u8]>::to_vec)
            .unwrap_or_default();

        let mut frames = Vec::new();
        let mut total_bytes: u64 = 0;
        loop {
            let frame = match decoder.read_next_frame() {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                // Like browsers, show the frames that decoded before a truncated or corrupt one.
                Err(_) if !frames.is_empty() => break,
                Err(e) => return Err(format!("Could not decode GIF: {e}")),
            };
            total_bytes += frame.buffer.len() as u64;
            if total_bytes > MAX_FRAME_BYTES {
                return Err("GIF has too many frames to edit in the browser".into());
            }
            frames.push(RawFrame {
                left: frame.left as usize,
                top: frame.top as usize,
                width: frame.width as usize,
                height: frame.height as usize,
                indices: frame.buffer.to_vec(),
                palette: frame.palette.clone(),
                transparent: frame.transparent,
                dispose: frame.dispose,
                delay: frame.delay,
            });
        }
        if frames.is_empty() {
            return Err("GIF has no frames".into());
        }

        let repeat = match decoder.repeat() {
            Repeat::Infinite => -1,
            Repeat::Finite(n) => n as i32,
        };

        let canvas_bytes = (width * height * 4) as u64;
        let interval =
            ((frames.len() as u64 * canvas_bytes).div_ceil(CHECKPOINT_BUDGET)).max(1) as usize;

        let mut doc = GifDocument {
            width,
            height,
            global_palette,
            frames,
            repeat,
            interval,
            checkpoints: Vec::new(),
            cursor: None,
        };

        // One pass over the animation to record the checkpoints.
        let mut canvas = vec![0u8; width * height * 4];
        for i in 0..doc.frames.len() {
            if i % interval == 0 {
                doc.checkpoints.push(canvas.clone());
            }
            doc.step(&mut canvas, i, None);
        }

        Ok(doc)
    }

    /// Composite frame `index` into a full RGBA canvas.
    pub fn render(&mut self, index: usize) -> Result<Vec<u8>, String> {
        if index >= self.frames.len() {
            return Err(format!("Frame {index} is out of range"));
        }

        let checkpoint = index / self.interval * self.interval;
        let (mut next, mut canvas) = match self.cursor.take() {
            Some((at, canvas)) if at <= index && at >= checkpoint => (at, canvas),
            _ => (checkpoint, self.checkpoints[index / self.interval].clone()),
        };

        while next < index {
            self.step(&mut canvas, next, None);
            next += 1;
        }
        let mut out = vec![0u8; canvas.len()];
        self.step(&mut canvas, index, Some(&mut out));
        self.cursor = Some((index + 1, canvas));
        Ok(out)
    }

    /// Draw frame `index` onto `canvas`, copy the result to `out` if given,
    /// then apply the frame's disposal so `canvas` is ready for the next frame.
    fn step(&self, canvas: &mut [u8], index: usize, out: Option<&mut [u8]>) {
        let frame = &self.frames[index];
        let (x0, y0, x1, y1) = self.clip(frame);

        let saved = (frame.dispose == DisposalMethod::Previous).then(|| {
            let mut saved = Vec::with_capacity((x1 - x0) * (y1 - y0) * 4);
            for y in y0..y1 {
                saved.extend_from_slice(
                    &canvas[(y * self.width + x0) * 4..(y * self.width + x1) * 4],
                );
            }
            saved
        });

        let palette = frame.palette.as_deref().unwrap_or(&self.global_palette);
        for y in y0..y1 {
            let row = (y - frame.top) * frame.width;
            for x in x0..x1 {
                let Some(&color) = frame.indices.get(row + x - frame.left) else {
                    continue;
                };
                if Some(color) == frame.transparent {
                    continue;
                }
                let p = color as usize * 3;
                let Some(rgb) = palette.get(p..p + 3) else {
                    continue;
                };
                let o = (y * self.width + x) * 4;
                canvas[o..o + 3].copy_from_slice(rgb);
                canvas[o + 3] = 255;
            }
        }

        if let Some(out) = out {
            out.copy_from_slice(canvas);
        }

        match frame.dispose {
            // Browsers clear to transparent rather than the background color.
            DisposalMethod::Background => {
                for y in y0..y1 {
                    canvas[(y * self.width + x0) * 4..(y * self.width + x1) * 4].fill(0);
                }
            }
            DisposalMethod::Previous => {
                let saved = saved.unwrap();
                let row_len = (x1 - x0) * 4;
                for (i, y) in (y0..y1).enumerate() {
                    canvas[(y * self.width + x0) * 4..(y * self.width + x1) * 4]
                        .copy_from_slice(&saved[i * row_len..(i + 1) * row_len]);
                }
            }
            DisposalMethod::Keep | DisposalMethod::Any => {}
        }
    }

    /// The part of a frame's rectangle that lies on the canvas.
    fn clip(&self, frame: &RawFrame) -> (usize, usize, usize, usize) {
        let x0 = frame.left.min(self.width);
        let y0 = frame.top.min(self.height);
        let x1 = (frame.left + frame.width).min(self.width);
        let y1 = (frame.top + frame.height).min(self.height);
        (x0, y0, x1, y1)
    }
}

#[wasm_bindgen]
impl GifDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<GifDocument, JsValue> {
        GifDocument::decode(bytes).map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width as u32
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height as u32
    }

    #[wasm_bindgen(getter, js_name = frameCount)]
    pub fn frame_count(&self) -> u32 {
        self.frames.len() as u32
    }

    /// Loop count: -1 loops forever, 0 plays once, n repeats n more times.
    #[wasm_bindgen(getter)]
    pub fn repeat(&self) -> i32 {
        self.repeat
    }

    /// Frame delays in hundredths of a second, as stored in the file.
    #[wasm_bindgen(getter)]
    pub fn delays(&self) -> Vec<u16> {
        self.frames.iter().map(|f| f.delay).collect()
    }

    /// Render frame `index` as full-canvas RGBA.
    #[wasm_bindgen(js_name = renderFrame)]
    pub fn render_frame(&mut self, index: u32) -> Result<Vec<u8>, JsValue> {
        self.render(index as usize)
            .map_err(|e| JsValue::from_str(&e))
    }
}

/// An RGBA pixel packed into one value (red in the low byte) so pixels can be
/// compared and hashed cheaply. Transparent pixels are always `CLEAR`.
type Pixel = u32;

const CLEAR: Pixel = 0;

/// A frame waiting to be written until we know what follows it.
struct Pending {
    pixels: Vec<Pixel>,
    delay: u16,
}

/// Writes full RGBA frames to a new animated GIF.
///
/// The encoder tracks what a decoder shows after each frame, so a frame only
/// stores the rectangle around pixels that differ from it, and pixels inside
/// that rectangle that already show the right color are left transparent.
/// Identical consecutive frames are merged by adding their delays together.
#[wasm_bindgen]
pub struct GifEncoder {
    width: usize,
    height: usize,
    encoder: Encoder<Vec<u8>>,
    pending: Option<Pending>,
    written: bool,
    /// What a decoder shows once the last written frame has been disposed of.
    canvas: Vec<Pixel>,
    /// The input pixels `canvas` shows, exactly or as their nearest palette
    /// color; `CLEAR` exactly where `canvas` is transparent.
    source: Vec<Pixel>,
}

impl GifEncoder {
    pub fn create(width: u32, height: u32, repeat: i32) -> Result<GifEncoder, String> {
        if width == 0 || height == 0 || width > u16::MAX as u32 || height > u16::MAX as u32 {
            return Err("Invalid GIF dimensions".into());
        }
        let mut encoder = Encoder::new(Vec::new(), width as u16, height as u16, &[])
            .map_err(|e| e.to_string())?;
        // No extension means "play once"; a loop count of 0 in the file means "forever".
        let repeat = match repeat {
            r if r < 0 => Some(Repeat::Infinite),
            0 => None,
            r => Some(Repeat::Finite(r.min(u16::MAX as i32) as u16)),
        };
        if let Some(repeat) = repeat {
            encoder.set_repeat(repeat).map_err(|e| e.to_string())?;
        }
        let pixels = width as usize * height as usize;
        Ok(GifEncoder {
            width: width as usize,
            height: height as usize,
            encoder,
            pending: None,
            written: false,
            canvas: vec![CLEAR; pixels],
            source: vec![CLEAR; pixels],
        })
    }

    pub fn push(&mut self, rgba: &[u8], delay: u16) -> Result<(), String> {
        if rgba.len() != self.width * self.height * 4 {
            return Err("Frame size does not match the GIF".into());
        }

        // GIF transparency is all-or-nothing. Transparent pixels carry no color,
        // so normalize them to keep frame comparisons exact.
        let pixels: Vec<Pixel> = rgba
            .chunks_exact(4)
            .map(|p| {
                if p[3] >= 128 {
                    u32::from_le_bytes([p[0], p[1], p[2], 255])
                } else {
                    CLEAR
                }
            })
            .collect();

        if let Some(pending) = &mut self.pending {
            // Browsers show delays of 0 or 1 as 10, so summing those would
            // shorten the animation; keep such frames separate.
            let total = pending.delay.checked_add(delay);
            if let Some(total) = total.filter(|_| pending.delay > 1 && delay > 1) {
                if pending.pixels == pixels {
                    pending.delay = total;
                    return Ok(());
                }
            }
        }
        if let Some(pending) = self.pending.take() {
            self.write(pending, Some(&pixels))?;
        }
        self.pending = Some(Pending { pixels, delay });
        Ok(())
    }

    pub fn finish_bytes(mut self) -> Result<Vec<u8>, String> {
        match self.pending.take() {
            Some(pending) => self.write(pending, None)?,
            None if !self.written => return Err("No frames to encode".into()),
            None => {}
        }
        self.encoder.into_inner().map_err(|e| e.to_string())
    }

    fn write(&mut self, frame: Pending, next: Option<&[Pixel]>) -> Result<(), String> {
        let pixels = &frame.pixels;
        // A frame can only add pixels to the canvas, so leave this one on screen
        // under the next one only if every pixel the next one leaves transparent
        // is transparent here too. Otherwise clear it once it has been shown.
        let keep = next.is_none_or(|next| {
            next.iter()
                .zip(pixels)
                .all(|(&n, &p)| n != CLEAR || p == CLEAR)
        });
        let dispose = if keep {
            DisposalMethod::Keep
        } else {
            DisposalMethod::Background
        };

        // Store the pixels that the canvas does not show yet and, as Background
        // disposal clears only the frame's own rectangle, every pixel that has
        // to be cleared for the next frame.
        let mut bounds = Bounds::default();
        bounds.add_differences(pixels, &self.source, self.width, |p, s| p != s);
        if let Some(next) = next.filter(|_| !keep) {
            bounds.add_differences(next, pixels, self.width, |n, p| n == CLEAR && p != CLEAR);
        }
        let rect = bounds.rect();

        let indexed = self.index_rect(pixels, rect);

        let (x, y, w, h) = rect;
        let gif_frame = Frame {
            left: x as u16,
            top: y as u16,
            width: w as u16,
            height: h as u16,
            delay: frame.delay,
            dispose,
            transparent: indexed.transparent,
            palette: Some(indexed.palette()),
            buffer: (&indexed.lzw[..]).into(),
            ..Frame::default()
        };
        self.encoder
            .write_lzw_pre_encoded_frame(&gif_frame)
            .map_err(|e| e.to_string())?;
        self.written = true;

        // Replay what a decoder does with the frame. Outside the rectangle the
        // canvas already shows `pixels`, and inside it every pixel now does.
        let mut pixels = frame.pixels;
        for row in 0..h {
            let start = (y + row) * self.width + x;
            let line = &indexed.indices[row * w..(row + 1) * w];
            for (i, &index) in (start..start + w).zip(line) {
                if Some(index) != indexed.transparent {
                    self.canvas[i] = indexed.colors[index as usize];
                }
            }
            if dispose == DisposalMethod::Background {
                self.canvas[start..start + w].fill(CLEAR);
                pixels[start..start + w].fill(CLEAR);
            }
        }
        self.source = pixels;
        Ok(())
    }

    /// Palette and indices for the pixels in `rect`. Only pixels that differ
    /// from `source` must be drawn; the others may be left transparent.
    fn index_rect(&self, pixels: &[Pixel], rect: (usize, usize, usize, usize)) -> Indexed {
        let (x, y, w, h) = rect;
        let rows = || (y..y + h).map(move |row| row * self.width + x..row * self.width + x + w);

        // Use an exact palette when the changed pixels have few enough colors.
        let mut lookup = ColorMap::default();
        let mut colors = Vec::new();
        let mut exact = true;
        for i in rows().flatten() {
            let p = pixels[i];
            if p != self.source[i] && !lookup.contains_key(&p) {
                if colors.len() == 256 {
                    exact = false;
                    break;
                }
                lookup.insert(p, colors.len() as u8);
                colors.push(p);
            }
        }
        if exact {
            let mut map = |p: Pixel| lookup.get(&p).copied();
            if let Some(indexed) = self.smallest(pixels, rect, colors, &mut map) {
                return indexed;
            }
            // 256 colors leave no index for transparency, and some unchanged
            // pixel has a color that is not in the palette.
        }

        // Too many colors: choose a palette for the pixels that will be drawn,
        // keeping an index free for transparency.
        let mut histogram: ColorMap<u32> = ColorMap::default();
        for i in rows().flatten() {
            if pixels[i] != self.source[i] {
                *histogram.entry(pixels[i]).or_default() += 1;
            }
        }
        let colors = if histogram.len() <= MEDIAN_CUT_MAX_COLORS {
            let mut counts: Vec<(Pixel, u32)> = histogram.into_iter().collect();
            median_cut(&mut counts, 255)
        } else {
            let changed: Vec<u8> = rows()
                .flatten()
                .filter(|&i| pixels[i] != self.source[i])
                .flat_map(|i| pixels[i].to_le_bytes())
                .collect();
            let speed = if changed.len() / 4 < QUANTIZE_FULL_SAMPLE_PIXELS {
                1
            } else {
                QUANTIZE_SPEED
            };
            NeuQuant::new(speed, 255, &changed)
                .color_map_rgb()
                .chunks_exact(3)
                .map(|c| u32::from_le_bytes([c[0], c[1], c[2], 255]))
                .collect()
        };
        let nearest = Nearest::new(&colors);
        let mut cache = ColorMap::default();
        let mut map = |p: Pixel| Some(*cache.entry(p).or_insert_with(|| nearest.find(p)));
        self.smallest(pixels, rect, colors, &mut map)
            .expect("a transparent index is always available")
    }

    /// Index the pixels a few different ways and keep the one that compresses
    /// best. Leaving unchanged pixels transparent usually wins, but it can
    /// break up runs of a color where most pixels changed (as in scrolling),
    /// and a transparent index can make every code a bit longer.
    fn smallest(
        &self,
        pixels: &[Pixel],
        rect: (usize, usize, usize, usize),
        colors: Vec<Pixel>,
        map: &mut dyn FnMut(Pixel) -> Option<u8>,
    ) -> Option<Indexed> {
        let (x, y, w, h) = rect;
        let unchanged = (y..y + h)
            .flat_map(|row| row * self.width + x..row * self.width + x + w)
            .any(|i| pixels[i] == self.source[i] && pixels[i] != CLEAR);
        let free = (colors.len() < 256).then_some(colors.len() as u8);
        let options: &[_] = match free {
            None => &[(None, false)],
            // Only unchanged pixels can prefer transparency.
            Some(_) if !unchanged => &[(free, false), (None, false)],
            Some(_) => &[(free, true), (free, false), (None, false)],
        };

        let mut best: Option<(usize, Indexed)> = None;
        for &(transparent, prefer_transparent) in options {
            let Some(indices) =
                self.assign(pixels, rect, &colors, transparent, prefer_transparent, map)
            else {
                continue;
            };
            let mut frame = Frame {
                buffer: (&indices[..]).into(),
                ..Frame::default()
            };
            frame.make_lzw_pre_encoded();
            // Color tables are padded to a power of two.
            let entries = colors.len() + transparent.is_some() as usize;
            let size = entries.max(2).next_power_of_two() * 3 + frame.buffer.len();
            if best.as_ref().is_none_or(|(best, _)| size < *best) {
                let lzw = frame.buffer.into_owned();
                best = Some((
                    size,
                    Indexed {
                        indices,
                        lzw,
                        colors: Vec::new(),
                        transparent,
                    },
                ));
            }
        }
        best.map(|(_, indexed)| Indexed { colors, ..indexed })
    }

    /// Choose an index for every pixel in `rect`. `map` gives the palette
    /// index for a pixel's color; it must succeed for every pixel that differs
    /// from `source`. Fails only without a transparent index, when an unchanged
    /// pixel can't be drawn with a palette color.
    ///
    /// A pixel is left transparent only if the canvas already shows what would
    /// be drawn there: the same input color (exactly, or quantized in an
    /// earlier frame), or the same palette color. Where there is a choice, the
    /// previous pixel's index is continued, which makes longer runs for the
    /// LZW compression; failing that, unchanged pixels are left transparent if
    /// `prefer_transparent` and drawn in their own color otherwise.
    fn assign(
        &self,
        pixels: &[Pixel],
        rect: (usize, usize, usize, usize),
        colors: &[Pixel],
        transparent: Option<u8>,
        prefer_transparent: bool,
        map: &mut dyn FnMut(Pixel) -> Option<u8>,
    ) -> Option<Vec<u8>> {
        let (x, y, w, h) = rect;
        let color = |index: u8| colors.get(index as usize).copied();
        let mut indices = Vec::with_capacity(w * h);
        let mut prev: Option<u8> = None;
        let mut last: Option<(Pixel, Option<u8>)> = None;
        let mut lookup = |p: Pixel| match last {
            Some((color, index)) if color == p => index,
            _ => {
                let index = map(p);
                last = Some((p, index));
                index
            }
        };
        for row in y..y + h {
            for i in row * self.width + x..row * self.width + x + w {
                let (p, shown) = (pixels[i], self.canvas[i]);
                let index = if p != self.source[i] {
                    debug_assert_ne!(p, CLEAR, "only transparent pixels are cleared");
                    let index = lookup(p).expect("changed pixels have a palette color");
                    match transparent {
                        Some(t) if prev != Some(index) && color(index) == Some(shown) => t,
                        _ => index,
                    }
                } else if p == CLEAR {
                    transparent?
                } else {
                    match prev {
                        Some(q) if Some(q) == transparent => q,
                        Some(q) if color(q) == Some(shown) || color(q) == Some(p) => q,
                        _ => match transparent.filter(|_| prefer_transparent) {
                            Some(t) => t,
                            // Never re-quantize an unchanged pixel: draw it
                            // only if its exact color is in the palette.
                            None => match lookup(p).filter(|&index| color(index) == Some(p)) {
                                Some(index) => index,
                                None => transparent?,
                            },
                        },
                    }
                };
                prev = Some(index);
                indices.push(index);
            }
        }
        Some(indices)
    }
}

/// A frame's pixels as palette indices.
struct Indexed {
    indices: Vec<u8>,
    /// The indices compressed for the file.
    lzw: Vec<u8>,
    colors: Vec<Pixel>,
    transparent: Option<u8>,
}

impl Indexed {
    /// The color table, with black for the transparent index.
    fn palette(&self) -> Vec<u8> {
        let mut palette = Vec::with_capacity((self.colors.len() + 1) * 3);
        for &c in &self.colors {
            palette.extend_from_slice(&c.to_le_bytes()[..3]);
        }
        if self.transparent.is_some() {
            palette.extend_from_slice(&[0, 0, 0]);
        }
        palette
    }
}

#[wasm_bindgen]
impl GifEncoder {
    /// `repeat`: -1 loops forever, 0 plays once, n repeats n more times.
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, repeat: i32) -> Result<GifEncoder, JsValue> {
        GifEncoder::create(width, height, repeat).map_err(|e| JsValue::from_str(&e))
    }

    /// Add a full-canvas RGBA frame shown for `delay` hundredths of a second.
    #[wasm_bindgen(js_name = addFrame)]
    pub fn add_frame(&mut self, rgba: &[u8], delay: u16) -> Result<(), JsValue> {
        self.push(rgba, delay).map_err(|e| JsValue::from_str(&e))
    }

    /// Write the remaining frames and return the GIF file.
    pub fn finish(self) -> Result<Vec<u8>, JsValue> {
        self.finish_bytes().map_err(|e| JsValue::from_str(&e))
    }
}

/// Bounding box of a set of pixels.
#[derive(Default)]
struct Bounds {
    /// `(x0, y0, x1, y1)`, exclusive at the end.
    rect: Option<(usize, usize, usize, usize)>,
}

impl Bounds {
    /// Add the pixels where `test(a, b)` holds.
    fn add_differences(
        &mut self,
        a: &[Pixel],
        b: &[Pixel],
        width: usize,
        test: impl Fn(Pixel, Pixel) -> bool,
    ) {
        for (y, (a, b)) in a.chunks_exact(width).zip(b.chunks_exact(width)).enumerate() {
            let Some(first) = a.iter().zip(b).position(|(&a, &b)| test(a, b)) else {
                continue;
            };
            let last = a.iter().zip(b).rposition(|(&a, &b)| test(a, b)).unwrap();
            self.rect = Some(match self.rect {
                None => (first, y, last + 1, y + 1),
                Some((x0, y0, x1, y1)) => {
                    (x0.min(first), y0.min(y), x1.max(last + 1), y1.max(y + 1))
                }
            });
        }
    }

    /// `(x, y, w, h)`; a single pixel at the origin when empty.
    fn rect(&self) -> (usize, usize, usize, usize) {
        match self.rect {
            Some((x0, y0, x1, y1)) => (x0, y0, x1 - x0, y1 - y0),
            None => (0, 0, 1, 1),
        }
    }
}

/// Choose up to `max` colors for pixels counted in `histogram` (which gets
/// reordered). The box of colors with the largest squared error is split at
/// its weighted median along its widest channel until there are `max` boxes;
/// each box becomes its weighted mean. Colors that cover many pixels end up
/// alone in a box and are kept exactly, which suits flat screen content.
fn median_cut(histogram: &mut [(Pixel, u32)], max: usize) -> Vec<Pixel> {
    struct ColorBox {
        start: usize,
        end: usize,
        error: f64,
        channel: usize,
        mean: Pixel,
    }

    let channel = |p: Pixel, c: usize| (p >> (c * 8)) as u8 as f64;
    let measure = |colors: &[(Pixel, u32)], start: usize| {
        let (mut weight, mut sum, mut squares) = (0.0, [0.0; 3], [0.0; 3]);
        for &(p, n) in colors {
            let n = n as f64;
            weight += n;
            for c in 0..3 {
                sum[c] += channel(p, c) * n;
                squares[c] += channel(p, c) * channel(p, c) * n;
            }
        }
        let variance: Vec<f64> = (0..3)
            .map(|c| squares[c] - sum[c] * sum[c] / weight)
            .collect();
        let widest = (0..3)
            .max_by(|&a, &b| variance[a].total_cmp(&variance[b]))
            .unwrap();
        let mean = (0..3).fold(0xFF00_0000, |mean, c| {
            mean | ((sum[c] / weight).round() as u32) << (c * 8)
        });
        ColorBox {
            start,
            end: start + colors.len(),
            error: if colors.len() > 1 {
                variance.iter().sum()
            } else {
                0.0
            },
            channel: widest,
            mean,
        }
    };

    let mut boxes = vec![measure(histogram, 0)];
    while boxes.len() < max {
        let (index, worst) = boxes
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.error.total_cmp(&b.1.error))
            .unwrap();
        if worst.error <= 0.0 {
            break;
        }
        let (start, end, c) = (worst.start, worst.end, worst.channel);
        let colors = &mut histogram[start..end];
        colors.sort_unstable_by_key(|&(p, _)| (p >> (c * 8)) as u8);
        let half = colors.iter().map(|&(_, n)| n as u64).sum::<u64>() / 2;
        let mut seen = 0;
        let mut split = colors
            .iter()
            .position(|&(_, n)| {
                seen += n as u64;
                seen > half
            })
            .unwrap_or(0);
        // Keep both halves non-empty.
        split = split.clamp(1, colors.len() - 1);
        let (low, high) = colors.split_at(split);
        let (low, high) = (measure(low, start), measure(high, start + split));
        boxes[index] = low;
        boxes.push(high);
    }
    boxes.iter().map(|b| b.mean).collect()
}

/// Finds the closest palette color to a pixel.
struct Nearest {
    /// Palette colors with their index, sorted by green.
    colors: Vec<([i32; 3], u8)>,
}

impl Nearest {
    fn new(palette: &[Pixel]) -> Nearest {
        let mut colors: Vec<([i32; 3], u8)> = palette
            .iter()
            .enumerate()
            .map(|(i, &p)| (rgb(p), i as u8))
            .collect();
        colors.sort_unstable_by_key(|&(c, _)| c[1]);
        Nearest { colors }
    }

    fn find(&self, p: Pixel) -> u8 {
        let p = rgb(p);
        let distance = |c: &[i32; 3]| (0..3).map(|i| (c[i] - p[i]).pow(2)).sum::<i32>();
        // Search outwards from the colors with the same green, stopping once
        // the green difference alone is larger than the best distance.
        let start = self.colors.partition_point(|&(c, _)| c[1] < p[1]);
        let (mut best, mut best_distance) = (0, i32::MAX);
        for (c, i) in self.colors[start..].iter() {
            if (c[1] - p[1]).pow(2) >= best_distance {
                break;
            }
            let d = distance(c);
            if d < best_distance {
                (best, best_distance) = (*i, d);
            }
        }
        for (c, i) in self.colors[..start].iter().rev() {
            if (c[1] - p[1]).pow(2) >= best_distance {
                break;
            }
            let d = distance(c);
            if d < best_distance {
                (best, best_distance) = (*i, d);
            }
        }
        best
    }
}

fn rgb(p: Pixel) -> [i32; 3] {
    let [r, g, b, _] = p.to_le_bytes();
    [r as i32, g as i32, b as i32]
}

/// Hashes a `Pixel` with one multiplication; much faster than the default
/// hasher for the millions of lookups an export makes.
#[derive(Default)]
struct PixelHasher(u64);

impl Hasher for PixelHasher {
    fn write(&mut self, _: &[u8]) {
        unreachable!("only pixels are hashed");
    }

    fn write_u32(&mut self, n: u32) {
        self.0 = (n as u64)
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
            .rotate_left(32);
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

type ColorMap<V = u8> = HashMap<Pixel, V, BuildHasherDefault<PixelHasher>>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const RED: [u8; 3] = [255, 0, 0];
    const GREEN: [u8; 3] = [0, 255, 0];
    const BLUE: [u8; 3] = [0, 0, 255];

    struct TestFrame {
        rect: (u16, u16, u16, u16),
        /// One palette index per pixel; index 3 is transparent.
        indices: Vec<u8>,
        dispose: DisposalMethod,
        delay: u16,
    }

    /// Build a GIF whose global palette is [red, green, blue, black] and whose
    /// frames use index 3 as transparent.
    fn build_gif(width: u16, height: u16, frames: &[TestFrame], comment: Option<&[u8]>) -> Vec<u8> {
        let palette = [RED, GREEN, BLUE, [0, 0, 0]].concat();
        let mut out = Vec::new();
        {
            let mut encoder = Encoder::new(&mut out, width, height, &palette).unwrap();
            encoder.set_repeat(Repeat::Infinite).unwrap();
            if let Some(comment) = comment {
                encoder
                    .write_raw_extension(gif::Extension::Comment.into(), &[comment])
                    .unwrap();
            }
            for f in frames {
                let (left, top, w, h) = f.rect;
                let frame = Frame {
                    left,
                    top,
                    width: w,
                    height: h,
                    delay: f.delay,
                    dispose: f.dispose,
                    transparent: Some(3),
                    buffer: f.indices.clone().into(),
                    ..Frame::default()
                };
                encoder.write_frame(&frame).unwrap();
            }
        }
        out
    }

    fn pixel(rgba: &[u8], width: usize, x: usize, y: usize) -> [u8; 4] {
        let i = (y * width + x) * 4;
        rgba[i..i + 4].try_into().unwrap()
    }

    fn rgba(c: [u8; 3]) -> [u8; 4] {
        [c[0], c[1], c[2], 255]
    }

    fn solid(width: usize, height: usize, c: [u8; 3]) -> Vec<u8> {
        rgba(c).repeat(width * height)
    }

    #[test]
    fn composites_partial_frames_with_disposal() {
        let gif = build_gif(
            4,
            4,
            &[
                // Frame 0: whole canvas red, kept.
                TestFrame {
                    rect: (0, 0, 4, 4),
                    indices: vec![0; 16],
                    dispose: DisposalMethod::Keep,
                    delay: 5,
                },
                // Frame 1: green patch at (1,1), restored to previous afterwards.
                TestFrame {
                    rect: (1, 1, 2, 2),
                    indices: vec![1; 4],
                    dispose: DisposalMethod::Previous,
                    delay: 6,
                },
                // Frame 2: blue pixel at (3,3) with a transparent pixel next to it, cleared afterwards.
                TestFrame {
                    rect: (2, 3, 2, 1),
                    indices: vec![3, 2],
                    dispose: DisposalMethod::Background,
                    delay: 7,
                },
                // Frame 3: nothing but a transparent pixel.
                TestFrame {
                    rect: (0, 0, 1, 1),
                    indices: vec![3],
                    dispose: DisposalMethod::Keep,
                    delay: 8,
                },
            ],
            None,
        );

        let mut doc = GifDocument::decode(&gif).unwrap();
        assert_eq!(doc.frames.len(), 4);
        assert_eq!(doc.delays(), vec![5, 6, 7, 8]);
        assert_eq!(doc.repeat(), -1);

        let f0 = doc.render(0).unwrap();
        assert!(f0.chunks_exact(4).all(|p| p == rgba(RED)));

        let f1 = doc.render(1).unwrap();
        assert_eq!(pixel(&f1, 4, 1, 1), rgba(GREEN));
        assert_eq!(pixel(&f1, 4, 2, 2), rgba(GREEN));
        assert_eq!(pixel(&f1, 4, 0, 0), rgba(RED));

        // The green patch was restored to red; the transparent pixel shows red.
        let f2 = doc.render(2).unwrap();
        assert_eq!(pixel(&f2, 4, 1, 1), rgba(RED));
        assert_eq!(pixel(&f2, 4, 2, 3), rgba(RED));
        assert_eq!(pixel(&f2, 4, 3, 3), rgba(BLUE));

        // Frame 2's rectangle was cleared to transparent.
        let f3 = doc.render(3).unwrap();
        assert_eq!(pixel(&f3, 4, 2, 3), [0, 0, 0, 0]);
        assert_eq!(pixel(&f3, 4, 3, 3), [0, 0, 0, 0]);
        assert_eq!(pixel(&f3, 4, 0, 0), rgba(RED));

        // Random access gives the same result as playing forward.
        assert_eq!(doc.render(1).unwrap(), f1);
        assert_eq!(doc.render(3).unwrap(), f3);
        assert_eq!(doc.render(0).unwrap(), f0);
        assert!(doc.render(4).is_err());
    }

    #[test]
    fn random_access_works_across_checkpoints() {
        let frames: Vec<TestFrame> = (0..10)
            .map(|i| TestFrame {
                rect: (i % 4, 0, 1, 1),
                indices: vec![(i % 3) as u8],
                dispose: DisposalMethod::Keep,
                delay: 1,
            })
            .collect();
        let gif = build_gif(4, 1, &frames, None);

        let mut sequential = GifDocument::decode(&gif).unwrap();
        let expected: Vec<Vec<u8>> = (0..10).map(|i| sequential.render(i).unwrap()).collect();

        let mut doc = GifDocument::decode(&gif).unwrap();
        doc.interval = 3;
        // With only Keep disposal, the canvas before frame i is frame i - 1.
        doc.checkpoints = (0..10)
            .step_by(3)
            .map(|i| {
                if i == 0 {
                    vec![0; 16]
                } else {
                    expected[i - 1].clone()
                }
            })
            .collect();
        for i in [9, 2, 7, 0, 5, 5, 6, 1] {
            assert_eq!(doc.render(i).unwrap(), expected[i], "frame {i}");
        }
    }

    #[test]
    fn rejects_invalid_input() {
        assert!(GifDocument::decode(b"not a gif").is_err());
        assert!(GifDocument::decode(&[]).is_err());
    }

    fn encode(width: usize, height: usize, frames: &[(Vec<u8>, u16)], repeat: i32) -> Vec<u8> {
        let mut encoder = GifEncoder::create(width as u32, height as u32, repeat).unwrap();
        for (pixels, delay) in frames {
            encoder.push(pixels, *delay).unwrap();
        }
        encoder.finish_bytes().unwrap()
    }

    fn decode_all(bytes: &[u8]) -> (GifDocument, Vec<Vec<u8>>) {
        let mut doc = GifDocument::decode(bytes).unwrap();
        let frames = (0..doc.frames.len())
            .map(|i| doc.render(i).unwrap())
            .collect();
        (doc, frames)
    }

    #[test]
    fn encoder_round_trips_opaque_frames() {
        let a = solid(8, 6, RED);
        let mut b = a.clone();
        b[(2 * 8 + 3) * 4..(2 * 8 + 3) * 4 + 4].copy_from_slice(&rgba(BLUE));
        let mut c = b.clone();
        c[(5 * 8 + 7) * 4..(5 * 8 + 7) * 4 + 4].copy_from_slice(&rgba(GREEN));

        let bytes = encode(
            8,
            6,
            &[(a.clone(), 10), (b.clone(), 20), (c.clone(), 30)],
            -1,
        );
        let (doc, frames) = decode_all(&bytes);
        assert_eq!(frames, vec![a, b, c]);
        assert_eq!(doc.delays(), vec![10, 20, 30]);
        assert_eq!(doc.repeat(), -1);
        // Frames after the first only store the changed rectangle.
        assert_eq!((doc.frames[1].width, doc.frames[1].height), (1, 1));
        assert_eq!((doc.frames[2].left, doc.frames[2].top), (7, 5));
    }

    #[test]
    fn encoder_round_trips_transparent_frames() {
        let mut a = solid(4, 4, GREEN);
        a[0..4].fill(0);
        let b = solid(4, 4, BLUE);
        let mut c = solid(4, 4, RED);
        c[60..64].fill(0);

        let bytes = encode(4, 4, &[(a.clone(), 5), (b.clone(), 5), (c.clone(), 5)], 0);
        let (doc, frames) = decode_all(&bytes);
        assert_eq!(frames, vec![a, b, c]);
        assert_eq!(doc.repeat(), 0);
    }

    #[test]
    fn encoder_merges_identical_frames() {
        let a = solid(2, 2, RED);
        let b = solid(2, 2, BLUE);
        let bytes = encode(
            2,
            2,
            &[
                (a.clone(), 10),
                (a.clone(), 15),
                (b.clone(), 5),
                (b.clone(), 5),
            ],
            3,
        );
        let (doc, frames) = decode_all(&bytes);
        assert_eq!(frames, vec![a, b]);
        assert_eq!(doc.delays(), vec![25, 10]);
        assert_eq!(doc.repeat(), 3);
    }

    #[test]
    fn encoder_keeps_identical_frames_with_tiny_delays() {
        let a = solid(2, 2, RED);
        let bytes = encode(
            2,
            2,
            &[
                (a.clone(), 0),
                (a.clone(), 1),
                (a.clone(), 1),
                (a.clone(), 5),
            ],
            -1,
        );
        let (doc, frames) = decode_all(&bytes);
        // Browsers play 0 and 1 as 10, so merging them would shorten the animation.
        assert_eq!(doc.delays(), vec![0, 1, 1, 5]);
        assert_eq!(frames.len(), 4);
    }

    #[test]
    fn encoder_does_not_overflow_merged_delays() {
        let a = solid(2, 2, RED);
        let bytes = encode(2, 2, &[(a.clone(), u16::MAX - 1), (a.clone(), 10)], -1);
        let (doc, _) = decode_all(&bytes);
        assert_eq!(doc.delays(), vec![u16::MAX - 1, 10]);
    }

    #[test]
    fn encoder_quantizes_frames_with_many_colors() {
        let (w, h) = (32, 32);
        let mut gradient = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                gradient.extend_from_slice(&[(x * 8) as u8, (y * 8) as u8, 128, 255]);
            }
        }
        // Make one pixel transparent so the palette must reserve a slot for it.
        gradient[3] = 0;
        let bytes = encode(w, h, &[(gradient.clone(), 10)], -1);
        let (doc, frames) = decode_all(&bytes);
        let palette = doc.frames[0].palette.as_ref().unwrap();
        assert!(palette.len() <= 256 * 3);
        assert_eq!(frames[0][3], 0, "transparent pixel stays transparent");
        let mut total_error = 0;
        for (out, src) in frames[0]
            .chunks_exact(4)
            .zip(gradient.chunks_exact(4))
            .skip(1)
        {
            assert_eq!(out[3], 255, "opaque pixels stay opaque");
            for c in 0..3 {
                let error = (out[c] as i32 - src[c] as i32).abs();
                assert!(error <= 48, "{out:?} vs {src:?}");
                total_error += error;
            }
        }
        // 1024 colors squeezed into 255: close on average.
        assert!(
            total_error / ((w * h - 1) * 3) as i32 <= 8,
            "mean error {total_error}"
        );
    }

    #[test]
    fn re_encoding_drops_metadata() {
        let secret = b"SECRET-COMMENT-1234";
        let gif = build_gif(
            2,
            2,
            &[TestFrame {
                rect: (0, 0, 2, 2),
                indices: vec![0, 1, 2, 0],
                dispose: DisposalMethod::Keep,
                delay: 4,
            }],
            Some(secret),
        );
        assert!(gif.windows(secret.len()).any(|w| w == secret));

        let mut doc = GifDocument::decode(&gif).unwrap();
        let frame = doc.render(0).unwrap();
        let out = encode(2, 2, &[(frame, 4)], doc.repeat());
        assert!(!out.windows(secret.len()).any(|w| w == secret));
    }

    #[test]
    fn redacted_pixels_never_reappear_in_later_frames() {
        // Frame 0 paints a "secret" blue square; later frames only touch other
        // pixels, so the secret stays visible through the whole animation.
        let mut frames = vec![TestFrame {
            rect: (0, 0, 4, 4),
            indices: vec![0; 16],
            dispose: DisposalMethod::Keep,
            delay: 1,
        }];
        frames[0].indices[5] = 2;
        for i in 0..3u16 {
            frames.push(TestFrame {
                rect: (3, i, 1, 1),
                indices: vec![1],
                dispose: DisposalMethod::Keep,
                delay: 1,
            });
        }
        let gif = build_gif(4, 4, &frames, None);
        let mut doc = GifDocument::decode(&gif).unwrap();

        let mut encoder = GifEncoder::create(4, 4, -1).unwrap();
        for i in 0..doc.frames.len() {
            let mut rgba = doc.render(i).unwrap();
            assert_eq!(pixel(&rgba, 4, 1, 1), [0, 0, 255, 255]);
            crate::solid_fill(&mut rgba, 4, 4, 1, 1, 1, 1, 0, 0, 0);
            encoder.push(&rgba, 1).unwrap();
        }
        let (_, out) = decode_all(&encoder.finish_bytes().unwrap());
        assert_eq!(out.len(), 4);
        for frame in out {
            assert_eq!(pixel(&frame, 4, 1, 1), [0, 0, 0, 255]);
        }
    }

    #[test]
    fn encoder_leaves_unchanged_pixels_transparent() {
        // A wide frame where only two distant pixels change: the stored
        // rectangle spans both, and everything between them is transparent.
        let (w, h) = (64, 8);
        let mut a = Vec::with_capacity(w * h * 4);
        for i in 0..w * h {
            a.extend_from_slice(&rgba([(i % 7) as u8 * 30, (i % 5) as u8 * 50, 90]));
        }
        let mut b = a.clone();
        b[(w + 2) * 4..(w + 2) * 4 + 4].copy_from_slice(&rgba(RED));
        b[(6 * w + 60) * 4..(6 * w + 60) * 4 + 4].copy_from_slice(&rgba(GREEN));

        let bytes = encode(w, h, &[(a.clone(), 10), (b.clone(), 10)], -1);
        let (doc, frames) = decode_all(&bytes);
        assert_eq!(frames, vec![a, b]);
        let f = &doc.frames[1];
        assert_eq!((f.left, f.top, f.width, f.height), (2, 1, 59, 6));
        let transparent = f.transparent.expect("unchanged pixels are transparent");
        let drawn = f.indices.iter().filter(|&&i| i != transparent).count();
        assert!(
            drawn < 59,
            "only {drawn} of {} pixels drawn",
            f.indices.len()
        );
    }

    #[test]
    fn encoder_clears_pixels_that_become_transparent() {
        let a = solid(6, 4, RED);
        // A hole in the middle of the next frame must not show `a` through it.
        let mut b = solid(6, 4, BLUE);
        for y in 1..3 {
            b[(y * 6 + 2) * 4..(y * 6 + 4) * 4].fill(0);
        }
        // Then the hole moves, and the old one is filled again.
        let mut c = solid(6, 4, BLUE);
        c[0..4].fill(0);
        let d = solid(6, 4, GREEN);

        let frames = vec![(a, 4), (b, 4), (c, 4), (d, 4)];
        let bytes = encode(6, 4, &frames, -1);
        let (doc, decoded) = decode_all(&bytes);
        assert_eq!(decoded.len(), 4);
        for (i, (out, (input, _))) in decoded.iter().zip(&frames).enumerate() {
            assert_eq!(out, input, "frame {i}");
        }
        assert_eq!(doc.frames[0].dispose, DisposalMethod::Background);
        assert_eq!(doc.frames[1].dispose, DisposalMethod::Background);
    }

    #[test]
    fn encoder_handles_256_colors_with_unchanged_pixels() {
        // 256 new colors leave no index for transparency, so unchanged pixels
        // inside the rectangle are drawn with a palette color instead.
        let (w, h) = (32, 9);
        let base = solid(w, h, [7, 7, 7]);
        let mut next = base.clone();
        for i in 0..256 {
            // Rows 0..8 get 256 distinct colors; row 8 keeps one unchanged
            // pixel inside the rectangle, between two changed ones.
            let o = i * 4;
            next[o..o + 4].copy_from_slice(&[i as u8, 255 - i as u8, 3, 255]);
        }
        let o = (8 * w) * 4;
        next[o..o + 4].copy_from_slice(&[0, 255, 3, 255]);
        let o = (8 * w + 31) * 4;
        next[o..o + 4].copy_from_slice(&[1, 254, 3, 255]);
        // (7, 7, 7) is not among the 256 colors, so the encoder can't keep
        // the unchanged pixels exact without a transparent index; it may
        // quantize, but alpha must survive and nothing may be far off.
        let bytes = encode(w, h, &[(base.clone(), 10), (next.clone(), 10)], -1);
        let (_, frames) = decode_all(&bytes);
        assert_eq!(frames[0], base);
        for (out, src) in frames[1].chunks_exact(4).zip(next.chunks_exact(4)) {
            assert_eq!(out[3], src[3]);
            for c in 0..3 {
                assert!(out[c].abs_diff(src[c]) <= 8, "{out:?} vs {src:?}");
            }
        }

        // When the unchanged pixels' color is one of the 256, it is used for
        // them and everything stays exact.
        let x = [0, 255, 3, 255];
        let mut base2 = base.clone();
        base2[(8 * w) * 4..].copy_from_slice(&x.repeat(w));
        base2[(3 * w + 5) * 4..(3 * w + 6) * 4].copy_from_slice(&x);
        let mut next2 = base2.clone();
        for i in 0..256 {
            next2[i * 4..i * 4 + 4].copy_from_slice(&[i as u8, 255 - i as u8, 3, 255]);
        }
        // Pixel (5, 3) keeps its color, so color 101 moves to (0, 8).
        next2[(3 * w + 5) * 4..(3 * w + 6) * 4].copy_from_slice(&x);
        next2[(8 * w) * 4..(8 * w) * 4 + 4].copy_from_slice(&[101, 154, 3, 255]);
        let bytes = encode(w, h, &[(base2.clone(), 10), (next2.clone(), 10)], -1);
        let (doc, frames) = decode_all(&bytes);
        assert_eq!(frames, vec![base2, next2]);
        assert_eq!(doc.frames[1].transparent, None);
        assert_eq!((doc.frames[1].width, doc.frames[1].height), (w, h));
    }

    #[test]
    fn unchanged_pixels_are_never_requantized() {
        // The canvas shows blue, and so does the input. A quantized palette
        // learned from the changed pixels (here only red) must not be used
        // to redraw the blue pixels, even when transparency is not preferred.
        let mut encoder = GifEncoder::create(4, 1, -1).unwrap();
        let blue = u32::from_le_bytes(rgba(BLUE));
        let red = u32::from_le_bytes(rgba(RED));
        encoder.canvas = vec![blue; 4];
        encoder.source = vec![blue; 4];
        let pixels = [red, blue, blue, red];
        let mut nearest = |_| Some(0);
        let indices = encoder
            .assign(&pixels, (0, 0, 4, 1), &[red], Some(1), false, &mut nearest)
            .unwrap();
        assert_eq!(indices, vec![0, 1, 1, 0]);
        // Without a transparent index, they can't be drawn at all.
        assert_eq!(
            encoder.assign(&pixels, (0, 0, 4, 1), &[red], None, false, &mut nearest),
            None
        );
    }

    #[test]
    fn median_cut_keeps_dominant_colors_exact() {
        // Screen-like content: two flat colors plus a long tail of
        // anti-aliasing shades. The flat colors must come through exactly.
        let mut histogram = vec![
            (u32::from_le_bytes([30, 30, 36, 255]), 50_000),
            (u32::from_le_bytes([220, 220, 220, 255]), 20_000),
        ];
        for i in 0..2000u32 {
            let v = (i % 190) as u8 + 30;
            histogram.push((
                u32::from_le_bytes([v, v, v.wrapping_add((i / 190) as u8), 255]),
                1,
            ));
        }
        let colors = median_cut(&mut histogram.clone(), 255);
        assert!(colors.len() <= 255);
        assert!(colors.contains(&histogram[0].0));
        assert!(colors.contains(&histogram[1].0));
        // Few enough colors are all kept.
        let mut few: Vec<(Pixel, u32)> = histogram[..100].to_vec();
        let colors = median_cut(&mut few, 255);
        let mut expected: Vec<Pixel> = histogram[..100].iter().map(|&(p, _)| p).collect();
        let mut got = colors.clone();
        expected.sort();
        expected.dedup();
        got.sort();
        assert_eq!(got, expected);
    }

    #[test]
    fn nearest_finds_the_closest_color() {
        let mut rng = Rng(0x1234_5678);
        let palette: Vec<Pixel> = (0..200).map(|_| rng.color()).collect();
        let nearest = Nearest::new(&palette);
        for _ in 0..2000 {
            let p = rng.color();
            let distance = |c: Pixel| {
                let (a, b) = (rgb(c), rgb(p));
                (0..3).map(|i| (a[i] - b[i]).pow(2)).sum::<i32>()
            };
            let best = palette.iter().map(|&c| distance(c)).min().unwrap();
            assert_eq!(distance(palette[nearest.find(p) as usize]), best);
        }
    }

    /// A small deterministic random number generator (xorshift64*).
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }

        fn chance(&mut self, percent: usize) -> bool {
            self.below(100) < percent
        }

        fn color(&mut self) -> Pixel {
            (self.next() as u32) | 0xFF00_0000
        }
    }

    /// The frames and delays a decoder should show for the pushed frames:
    /// identical neighbors are merged unless either delay is 0 or 1.
    fn expected_frames(frames: &[(Vec<u8>, u16)]) -> Vec<(Vec<u8>, u16)> {
        let mut out: Vec<(Vec<u8>, u16)> = Vec::new();
        for (pixels, delay) in frames {
            let mut pixels = pixels.clone();
            for p in pixels.chunks_exact_mut(4) {
                if p[3] >= 128 {
                    p[3] = 255;
                } else {
                    p.fill(0);
                }
            }
            if let Some((last, last_delay)) = out.last_mut() {
                if *last == pixels && *last_delay > 1 && *delay > 1 {
                    if let Some(total) = last_delay.checked_add(*delay) {
                        *last_delay = total;
                        continue;
                    }
                }
            }
            out.push((pixels, *delay));
        }
        out
    }

    /// Random frames for round-trip tests. Each frame is mostly a copy of the
    /// previous one with some rectangles repainted (or made transparent);
    /// some frames repeat exactly, some are new. When `noisy` is given, that
    /// percentage of frames also gets a patch of random colors, too many for
    /// one palette.
    fn random_frames(
        rng: &mut Rng,
        width: usize,
        height: usize,
        count: usize,
        noisy: usize,
    ) -> Vec<(Vec<u8>, u16)> {
        let palette: Vec<Pixel> = (0..1 + rng.below(12)).map(|_| rng.color()).collect();
        let pick = |rng: &mut Rng| {
            if rng.chance(15) {
                CLEAR
            } else {
                palette[rng.below(palette.len())]
            }
        };
        let mut frames: Vec<(Vec<u8>, u16)> = Vec::new();
        let mut pixels: Vec<Pixel> = Vec::new();
        for i in 0..count {
            if i == 0 || rng.chance(10) {
                pixels = (0..width * height).map(|_| pick(rng)).collect();
            } else if !rng.chance(20) {
                for _ in 0..1 + rng.below(3) {
                    let (x, y) = (rng.below(width), rng.below(height));
                    let (w, h) = (1 + rng.below(width - x), 1 + rng.below(height - y));
                    let fill = pick(rng);
                    let speckle = rng.chance(30);
                    for row in y..y + h {
                        for p in &mut pixels[row * width + x..row * width + x + w] {
                            *p = if speckle && rng.chance(50) {
                                pick(rng)
                            } else {
                                fill
                            };
                        }
                    }
                }
            }
            if noisy > 0 && rng.chance(noisy) {
                // A patch of mostly unique colors, with a few transparent ones.
                let (w, h) = (width.min(24), height.min(24));
                let (x, y) = (rng.below(width - w + 1), rng.below(height - h + 1));
                for row in y..y + h {
                    for p in &mut pixels[row * width + x..row * width + x + w] {
                        *p = if rng.chance(3) { CLEAR } else { rng.color() };
                    }
                }
            }
            let delay = [0, 1, 2, 5, 10, u16::MAX - 3][rng.below(6)];
            let mut rgba: Vec<u8> = pixels.iter().flat_map(|p| p.to_le_bytes()).collect();
            // Inputs may use any alpha; the encoder rounds it.
            for p in rgba.chunks_exact_mut(4) {
                if p[3] == 255 && rng.chance(5) {
                    p[3] = 128 + rng.below(127) as u8;
                } else if p[3] == 0 && rng.chance(20) {
                    p.copy_from_slice(&[rng.below(256) as u8, 9, 9, rng.below(128) as u8]);
                }
            }
            frames.push((rgba, delay));
        }
        frames
    }

    #[test]
    fn encoder_round_trips_random_animations_exactly() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for case in 0..400 {
            let (width, height) = (1 + rng.below(14), 1 + rng.below(10));
            let count = 1 + rng.below(12);
            let frames = random_frames(&mut rng, width, height, count, 0);
            let repeat = [-1, 0, 3][rng.below(3)];
            let bytes = encode(width, height, &frames, repeat);
            let (doc, decoded) = decode_all(&bytes);

            let expected = expected_frames(&frames);
            assert_eq!(decoded.len(), expected.len(), "case {case}");
            for (i, (out, (pixels, _))) in decoded.iter().zip(&expected).enumerate() {
                assert_eq!(out, pixels, "case {case}, frame {i}");
            }
            let delays: Vec<u16> = expected.iter().map(|&(_, d)| d).collect();
            assert_eq!(doc.delays(), delays, "case {case}");
            assert_eq!(doc.repeat(), repeat);
        }
    }

    #[test]
    fn encoder_round_trips_random_animations_with_many_colors() {
        let mut rng = Rng(0xD1B5_4A32_D192_ED03);
        for case in 0..60 {
            let (width, height) = (20 + rng.below(30), 20 + rng.below(20));
            let count = 2 + rng.below(10);
            let mut frames = random_frames(&mut rng, width, height, count, 40);
            // Delays of 1 are never merged, so decoded frames match the inputs
            // one to one (merging is covered by the exact test).
            for frame in &mut frames {
                frame.1 = 1;
            }
            let bytes = encode(width, height, &frames, -1);
            let (_, decoded) = decode_all(&bytes);
            let expected = expected_frames(&frames);
            assert_eq!(decoded.len(), expected.len(), "case {case}");

            // Pixels whose current color may have been drawn by a quantized frame.
            let mut approximate = vec![false; width * height];
            for (i, (out, (pixels, _))) in decoded.iter().zip(&expected).enumerate() {
                let px = |frame: &[u8], p: usize| -> [u8; 4] {
                    frame[p * 4..p * 4 + 4].try_into().unwrap()
                };
                let changed = |p: usize| i == 0 || px(&expected[i - 1].0, p) != px(pixels, p);
                // A frame must be redrawn where the previous one was cleared, so
                // it may be quantized when the pixels it changes, or (after a
                // clear) all of its pixels, have more colors than fit.
                let cleared = i > 0
                    && (0..width * height)
                        .any(|p| px(pixels, p)[3] == 0 && px(&expected[i - 1].0, p)[3] != 0);
                let drawn: HashSet<[u8; 4]> = (0..width * height)
                    .filter(|&p| px(pixels, p)[3] != 0 && (cleared || changed(p)))
                    .map(|p| px(pixels, p))
                    .collect();
                let quantized = drawn.len() > 255;

                for p in 0..width * height {
                    let (o, s) = (px(out, p), px(pixels, p));
                    assert_eq!(o[3], s[3], "case {case}, frame {i}: alpha at {p}");
                    if quantized {
                        approximate[p] = true;
                    } else if changed(p) {
                        approximate[p] = false;
                    }
                    if approximate[p] {
                        let error = (0..3).map(|c| o[c].abs_diff(s[c])).max().unwrap();
                        assert!(error <= 96, "case {case}, frame {i}: {o:?} vs {s:?}");
                    } else {
                        assert_eq!(o, s, "case {case}, frame {i}: pixel {p}");
                    }
                }
            }
        }
    }

    #[test]
    fn redactions_hold_in_quantized_frames() {
        // A noisy background forces every frame through the quantizer. A
        // magenta "secret" is visible in the first frames, then a redaction
        // covers it; no later frame may show the secret through transparency.
        let (w, h) = (48, 32);
        let mut rng = Rng(42);
        let secret = [255, 0, 255, 255];
        let mut frames = Vec::new();
        for i in 0..8 {
            // A new background every frame, far from magenta.
            let background: Vec<u8> = (0..w * h)
                .flat_map(|_| {
                    let c = rng.color().to_le_bytes();
                    [c[0] / 2, 128 + c[1] / 2, c[2] / 2, 255]
                })
                .collect();
            let mut frame = background.clone();
            for y in 8..20 {
                for x in 10..40 {
                    if (x + y) % 3 != 0 {
                        frame[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&secret);
                    }
                }
            }
            if i >= 3 {
                crate::pixelate(&mut frame, w as u32, h as u32, 10, 8, 30, 12, 6);
                if i % 2 == 0 {
                    crate::solid_fill(&mut frame, w as u32, h as u32, 10, 8, 30, 12, 0, 0, 0);
                }
            }
            frames.push((frame, 5));
        }
        let (_, decoded) = decode_all(&encode(w, h, &frames, -1));
        assert_eq!(decoded.len(), 8);
        for (i, out) in decoded.iter().enumerate().skip(3) {
            for y in 8..20 {
                for x in 10..40 {
                    assert_ne!(
                        pixel(out, w, x, y),
                        secret,
                        "frame {i} shows the secret at ({x}, {y})"
                    );
                }
            }
        }
        // The secret is visible before the redaction starts.
        assert_eq!(pixel(&decoded[0], w, 11, 8), secret);
    }
}
