use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Apply solid fill redaction to a region of the image
#[wasm_bindgen]
pub fn solid_fill(
    data: &mut [u8],
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    r: u8,
    g: u8,
    b: u8,
) {
    let x_end = (x + w).min(width);
    let y_end = (y + h).min(height);

    for py in y..y_end {
        for px in x..x_end {
            let idx = ((py * width + px) * 4) as usize;
            if idx + 3 < data.len() {
                data[idx] = r;
                data[idx + 1] = g;
                data[idx + 2] = b;
                // Keep alpha unchanged
            }
        }
    }
}

/// Apply pixelation effect to a region of the image
#[wasm_bindgen]
pub fn pixelate(
    data: &mut [u8],
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    block_size: u32,
) {
    let block_size = block_size.max(1);
    let x_end = (x + w).min(width);
    let y_end = (y + h).min(height);

    // Process each block
    let mut by = y;
    while by < y_end {
        let mut bx = x;
        while bx < x_end {
            let block_w = block_size.min(x_end - bx);
            let block_h = block_size.min(y_end - by);

            // Calculate average color for this block
            let mut sum_r: u32 = 0;
            let mut sum_g: u32 = 0;
            let mut sum_b: u32 = 0;
            let mut count: u32 = 0;

            for py in by..(by + block_h) {
                for px in bx..(bx + block_w) {
                    let idx = ((py * width + px) * 4) as usize;
                    if idx + 2 < data.len() {
                        sum_r += data[idx] as u32;
                        sum_g += data[idx + 1] as u32;
                        sum_b += data[idx + 2] as u32;
                        count += 1;
                    }
                }
            }

            if count > 0 {
                let avg_r = (sum_r / count) as u8;
                let avg_g = (sum_g / count) as u8;
                let avg_b = (sum_b / count) as u8;

                // Apply average color to entire block
                for py in by..(by + block_h) {
                    for px in bx..(bx + block_w) {
                        let idx = ((py * width + px) * 4) as usize;
                        if idx + 2 < data.len() {
                            data[idx] = avg_r;
                            data[idx + 1] = avg_g;
                            data[idx + 2] = avg_b;
                        }
                    }
                }
            }

            bx += block_size;
        }
        by += block_size;
    }
}

/// Apply gaussian blur to a region of the image
#[wasm_bindgen]
pub fn gaussian_blur(
    data: &mut [u8],
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    radius: u32,
) {
    if radius == 0 {
        return;
    }

    let x_end = (x + w).min(width);
    let y_end = (y + h).min(height);

    // Create a copy of the region for reading
    let region_w = (x_end - x) as usize;
    let region_h = (y_end - y) as usize;
    let mut temp = vec![0u8; region_w * region_h * 4];

    // Copy region to temp buffer
    for py in y..y_end {
        for px in x..x_end {
            let src_idx = ((py * width + px) * 4) as usize;
            let dst_idx = (((py - y) as usize * region_w + (px - x) as usize) * 4) as usize;
            if src_idx + 3 < data.len() && dst_idx + 3 < temp.len() {
                temp[dst_idx] = data[src_idx];
                temp[dst_idx + 1] = data[src_idx + 1];
                temp[dst_idx + 2] = data[src_idx + 2];
                temp[dst_idx + 3] = data[src_idx + 3];
            }
        }
    }

    // Generate gaussian kernel
    let kernel = generate_gaussian_kernel(radius);
    let kernel_size = (radius * 2 + 1) as i32;
    let half_kernel = radius as i32;

    // Horizontal pass
    let mut h_pass = vec![0u8; region_w * region_h * 4];
    for py in 0..region_h {
        for px in 0..region_w {
            let mut sum_r: f32 = 0.0;
            let mut sum_g: f32 = 0.0;
            let mut sum_b: f32 = 0.0;
            let mut sum_weight: f32 = 0.0;

            for k in 0..kernel_size {
                let sample_x = px as i32 + k - half_kernel;
                if sample_x >= 0 && sample_x < region_w as i32 {
                    let idx = (py * region_w + sample_x as usize) * 4;
                    let weight = kernel[k as usize];
                    sum_r += temp[idx] as f32 * weight;
                    sum_g += temp[idx + 1] as f32 * weight;
                    sum_b += temp[idx + 2] as f32 * weight;
                    sum_weight += weight;
                }
            }

            let idx = (py * region_w + px) * 4;
            h_pass[idx] = (sum_r / sum_weight) as u8;
            h_pass[idx + 1] = (sum_g / sum_weight) as u8;
            h_pass[idx + 2] = (sum_b / sum_weight) as u8;
            h_pass[idx + 3] = temp[idx + 3];
        }
    }

    // Vertical pass and write back
    for py in 0..region_h {
        for px in 0..region_w {
            let mut sum_r: f32 = 0.0;
            let mut sum_g: f32 = 0.0;
            let mut sum_b: f32 = 0.0;
            let mut sum_weight: f32 = 0.0;

            for k in 0..kernel_size {
                let sample_y = py as i32 + k - half_kernel;
                if sample_y >= 0 && sample_y < region_h as i32 {
                    let idx = (sample_y as usize * region_w + px) * 4;
                    let weight = kernel[k as usize];
                    sum_r += h_pass[idx] as f32 * weight;
                    sum_g += h_pass[idx + 1] as f32 * weight;
                    sum_b += h_pass[idx + 2] as f32 * weight;
                    sum_weight += weight;
                }
            }

            let dst_idx = (((py as u32 + y) * width + (px as u32 + x)) * 4) as usize;
            if dst_idx + 2 < data.len() {
                data[dst_idx] = (sum_r / sum_weight) as u8;
                data[dst_idx + 1] = (sum_g / sum_weight) as u8;
                data[dst_idx + 2] = (sum_b / sum_weight) as u8;
            }
        }
    }
}

fn generate_gaussian_kernel(radius: u32) -> Vec<f32> {
    let size = (radius * 2 + 1) as usize;
    let sigma = radius as f32 / 2.0;
    let mut kernel = vec![0.0f32; size];

    let two_sigma_sq = 2.0 * sigma * sigma;
    let norm = 1.0 / (std::f32::consts::PI * two_sigma_sq).sqrt();

    for i in 0..size {
        let x = i as f32 - radius as f32;
        kernel[i] = norm * (-x * x / two_sigma_sq).exp();
    }

    kernel
}

/// Apply redaction to freehand brush strokes (array of points)
#[wasm_bindgen]
pub fn brush_solid_fill(
    data: &mut [u8],
    width: u32,
    height: u32,
    points: &[f32], // Flat array: [x1, y1, x2, y2, ...]
    brush_size: u32,
    r: u8,
    g: u8,
    b: u8,
) {
    let radius = (brush_size / 2) as i32;
    let radius_sq = (radius * radius) as f32;

    for i in (0..points.len()).step_by(2) {
        if i + 1 >= points.len() {
            break;
        }
        let cx = points[i] as i32;
        let cy = points[i + 1] as i32;

        for dy in -radius..=radius {
            for dx in -radius..=radius {
                if (dx * dx + dy * dy) as f32 <= radius_sq {
                    let px = cx + dx;
                    let py = cy + dy;
                    if px >= 0 && px < width as i32 && py >= 0 && py < height as i32 {
                        let idx = ((py as u32 * width + px as u32) * 4) as usize;
                        if idx + 2 < data.len() {
                            data[idx] = r;
                            data[idx + 1] = g;
                            data[idx + 2] = b;
                        }
                    }
                }
            }
        }
    }
}

/// Apply pixelation to brush strokes
#[wasm_bindgen]
pub fn brush_pixelate(
    data: &mut [u8],
    width: u32,
    height: u32,
    points: &[f32],
    brush_size: u32,
    block_size: u32,
) {
    // Create a mask of affected pixels
    let mut mask = vec![false; (width * height) as usize];
    let radius = (brush_size / 2) as i32;
    let radius_sq = (radius * radius) as f32;

    // Mark pixels in brush path
    for i in (0..points.len()).step_by(2) {
        if i + 1 >= points.len() {
            break;
        }
        let cx = points[i] as i32;
        let cy = points[i + 1] as i32;

        for dy in -radius..=radius {
            for dx in -radius..=radius {
                if (dx * dx + dy * dy) as f32 <= radius_sq {
                    let px = cx + dx;
                    let py = cy + dy;
                    if px >= 0 && px < width as i32 && py >= 0 && py < height as i32 {
                        mask[(py as u32 * width + px as u32) as usize] = true;
                    }
                }
            }
        }
    }

    // Find bounding box
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0u32;
    let mut max_y = 0u32;

    for y in 0..height {
        for x in 0..width {
            if mask[(y * width + x) as usize] {
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }

    if min_x > max_x {
        return;
    }

    // Pixelate with mask
    let block_size = block_size.max(1);
    let mut by = min_y;
    while by <= max_y {
        let mut bx = min_x;
        while bx <= max_x {
            let block_w = block_size.min(max_x + 1 - bx);
            let block_h = block_size.min(max_y + 1 - by);

            // Check if any pixel in block is masked
            let mut has_masked = false;
            for py in by..(by + block_h) {
                for px in bx..(bx + block_w) {
                    if mask[(py * width + px) as usize] {
                        has_masked = true;
                        break;
                    }
                }
                if has_masked {
                    break;
                }
            }

            if has_masked {
                // Calculate average and apply only to masked pixels
                let mut sum_r: u32 = 0;
                let mut sum_g: u32 = 0;
                let mut sum_b: u32 = 0;
                let mut count: u32 = 0;

                for py in by..(by + block_h) {
                    for px in bx..(bx + block_w) {
                        let idx = ((py * width + px) * 4) as usize;
                        sum_r += data[idx] as u32;
                        sum_g += data[idx + 1] as u32;
                        sum_b += data[idx + 2] as u32;
                        count += 1;
                    }
                }

                if count > 0 {
                    let avg_r = (sum_r / count) as u8;
                    let avg_g = (sum_g / count) as u8;
                    let avg_b = (sum_b / count) as u8;

                    for py in by..(by + block_h) {
                        for px in bx..(bx + block_w) {
                            if mask[(py * width + px) as usize] {
                                let idx = ((py * width + px) * 4) as usize;
                                data[idx] = avg_r;
                                data[idx + 1] = avg_g;
                                data[idx + 2] = avg_b;
                            }
                        }
                    }
                }
            }

            bx += block_size;
        }
        by += block_size;
    }
}
