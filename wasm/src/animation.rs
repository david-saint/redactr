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

/// A frame waiting to be written until we know what follows it.
struct Pending {
    pixels: Vec<u8>,
    opaque: bool,
    delay: u16,
}

/// Writes full RGBA frames to a new animated GIF.
///
/// When consecutive frames are opaque, each frame after the first only stores
/// the rectangle that changed. Identical consecutive frames are merged by
/// adding their delays together.
#[wasm_bindgen]
pub struct GifEncoder {
    width: usize,
    height: usize,
    encoder: Encoder<Vec<u8>>,
    pending: Option<Pending>,
    /// Pixels of the last written frame, and how it was disposed of.
    previous: Option<(Vec<u8>, DisposalMethod)>,
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
        Ok(GifEncoder {
            width: width as usize,
            height: height as usize,
            encoder,
            pending: None,
            previous: None,
        })
    }

    pub fn push(&mut self, rgba: &[u8], delay: u16) -> Result<(), String> {
        if rgba.len() != self.width * self.height * 4 {
            return Err("Frame size does not match the GIF".into());
        }

        // GIF transparency is all-or-nothing. Transparent pixels carry no color,
        // so normalize them to keep frame comparisons exact.
        let mut pixels = rgba.to_vec();
        let mut opaque = true;
        for px in pixels.chunks_exact_mut(4) {
            if px[3] >= 128 {
                px[3] = 255;
            } else {
                px.fill(0);
                opaque = false;
            }
        }

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
            self.write(pending, Some(opaque))?;
        }
        self.pending = Some(Pending {
            pixels,
            opaque,
            delay,
        });
        Ok(())
    }

    pub fn finish_bytes(mut self) -> Result<Vec<u8>, String> {
        match self.pending.take() {
            Some(pending) => self.write(pending, None)?,
            None if self.previous.is_none() => return Err("No frames to encode".into()),
            None => {}
        }
        self.encoder.into_inner().map_err(|e| e.to_string())
    }

    fn write(&mut self, frame: Pending, next_opaque: Option<bool>) -> Result<(), String> {
        // Leave this frame on screen under the next one only if the next one is
        // opaque; otherwise its transparent pixels would show this frame through.
        let dispose = if next_opaque == Some(false) {
            DisposalMethod::Background
        } else {
            DisposalMethod::Keep
        };

        // Background disposal clears only the frame's own rectangle, so a frame
        // that will be cleared, or that follows a cleared one, covers the canvas.
        let rect = match &self.previous {
            Some((prev, DisposalMethod::Keep))
                if dispose == DisposalMethod::Keep && frame.opaque =>
            {
                changed_rect(prev, &frame.pixels, self.width, self.height)
            }
            _ => (0, 0, self.width, self.height),
        };
        let (x, y, w, h) = rect;

        let mut sub = Vec::with_capacity(w * h * 4);
        for row in y..y + h {
            sub.extend_from_slice(
                &frame.pixels[(row * self.width + x) * 4..(row * self.width + x + w) * 4],
            );
        }
        let (indices, palette, transparent) = quantize(&sub);

        let gif_frame = Frame {
            left: x as u16,
            top: y as u16,
            width: w as u16,
            height: h as u16,
            delay: frame.delay,
            dispose,
            transparent,
            palette: Some(palette),
            buffer: indices.into(),
            ..Frame::default()
        };
        self.encoder
            .write_frame(&gif_frame)
            .map_err(|e| e.to_string())?;
        self.previous = Some((frame.pixels, dispose));
        Ok(())
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

/// Bounding box `(x, y, w, h)` of the pixels that differ. Never empty.
fn changed_rect(a: &[u8], b: &[u8], width: usize, height: usize) -> (usize, usize, usize, usize) {
    let (mut x0, mut y0, mut x1, mut y1) = (width, height, 0, 0);
    for y in 0..height {
        let row = y * width * 4;
        for x in 0..width {
            let i = row + x * 4;
            if a[i..i + 4] != b[i..i + 4] {
                x0 = x0.min(x);
                x1 = x1.max(x + 1);
                y0 = y0.min(y);
                y1 = y1.max(y + 1);
            }
        }
    }
    if x1 == 0 {
        return (0, 0, 1, 1);
    }
    (x0, y0, x1 - x0, y1 - y0)
}

/// Map RGBA pixels (alpha 0 or 255) to palette indices.
/// Returns `(indices, rgb_palette, transparent_index)`.
fn quantize(pixels: &[u8]) -> (Vec<u8>, Vec<u8>, Option<u8>) {
    let key = |p: &[u8]| u32::from_le_bytes([p[0], p[1], p[2], 0]);
    let has_transparent = pixels.chunks_exact(4).any(|p| p[3] == 0);
    // Reserve the last palette slot for transparency when it is needed.
    let max_colors = if has_transparent { 255 } else { 256 };

    let mut lookup: HashMap<u32, u8> = HashMap::new();
    let mut palette = Vec::new();
    let mut exact = true;
    for p in pixels.chunks_exact(4).filter(|p| p[3] != 0) {
        let k = key(p);
        if !lookup.contains_key(&k) {
            if lookup.len() == max_colors {
                exact = false;
                break;
            }
            lookup.insert(k, lookup.len() as u8);
            palette.extend_from_slice(&p[..3]);
        }
    }

    let neuquant = if exact {
        None
    } else {
        let opaque: Vec<u8> = pixels
            .chunks_exact(4)
            .filter(|p| p[3] != 0)
            .flatten()
            .copied()
            .collect();
        let speed = if opaque.len() / 4 < QUANTIZE_FULL_SAMPLE_PIXELS {
            1
        } else {
            QUANTIZE_SPEED
        };
        let nq = NeuQuant::new(speed, max_colors, &opaque);
        palette = nq.color_map_rgb();
        lookup.clear();
        Some(nq)
    };

    let transparent = has_transparent.then(|| {
        let index = (palette.len() / 3) as u8;
        palette.extend_from_slice(&[0, 0, 0]);
        index
    });

    let indices = pixels
        .chunks_exact(4)
        .map(|p| {
            if p[3] == 0 {
                return transparent.unwrap();
            }
            let k = key(p);
            match &neuquant {
                None => lookup[&k],
                Some(nq) => *lookup.entry(k).or_insert_with(|| nq.index_of(p) as u8),
            }
        })
        .collect();

    (indices, palette, transparent)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
