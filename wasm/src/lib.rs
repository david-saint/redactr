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

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_image(width: u32, height: u32) -> Vec<u8> {
        let size = (width * height * 4) as usize;
        let mut data = vec![0u8; size];
        // Fill with a pattern for testing
        for y in 0..height {
            for x in 0..width {
                let idx = ((y * width + x) * 4) as usize;
                data[idx] = (x % 256) as u8;     // R
                data[idx + 1] = (y % 256) as u8; // G
                data[idx + 2] = 128;             // B
                data[idx + 3] = 255;             // A
            }
        }
        data
    }

    #[test]
    fn test_solid_fill_basic() {
        let mut data = create_test_image(10, 10);
        
        solid_fill(&mut data, 10, 10, 2, 2, 3, 3, 255, 0, 0);
        
        // Check that pixels inside the region are filled
        for y in 2..5 {
            for x in 2..5 {
                let idx = ((y * 10 + x) * 4) as usize;
                assert_eq!(data[idx], 255, "Red channel at ({}, {})", x, y);
                assert_eq!(data[idx + 1], 0, "Green channel at ({}, {})", x, y);
                assert_eq!(data[idx + 2], 0, "Blue channel at ({}, {})", x, y);
            }
        }
        
        // Check that pixels outside are not affected
        let idx = (0 * 10 + 0) * 4;
        assert_eq!(data[idx as usize], 0); // Original R value
    }

    #[test]
    fn test_solid_fill_clamps_to_bounds() {
        let mut data = create_test_image(10, 10);
        
        // Try to fill beyond image bounds
        solid_fill(&mut data, 10, 10, 8, 8, 5, 5, 128, 128, 128);
        
        // Only 8-9, 8-9 should be affected (2x2 area)
        for y in 8..10 {
            for x in 8..10 {
                let idx = ((y * 10 + x) * 4) as usize;
                assert_eq!(data[idx], 128);
            }
        }
    }

    #[test]
    fn test_solid_fill_preserves_alpha() {
        let mut data = create_test_image(10, 10);
        
        // Set a custom alpha value
        data[0 * 4 + 3] = 100;
        
        solid_fill(&mut data, 10, 10, 0, 0, 1, 1, 255, 255, 255);
        
        // Alpha should be preserved
        assert_eq!(data[0 * 4 + 3], 100);
    }

    #[test]
    fn test_pixelate_basic() {
        let mut data = create_test_image(10, 10);
        
        // Fill with known values for predictable averaging
        for i in 0..data.len() {
            data[i] = 100;
        }
        
        pixelate(&mut data, 10, 10, 0, 0, 4, 4, 2);
        
        // All pixels in the 4x4 region should have the same averaged color
        let first_r = data[0];
        let first_g = data[1];
        let first_b = data[2];
        
        for y in 0..4 {
            for x in 0..4 {
                let idx = ((y * 10 + x) * 4) as usize;
                assert_eq!(data[idx], first_r);
                assert_eq!(data[idx + 1], first_g);
                assert_eq!(data[idx + 2], first_b);
            }
        }
    }

    #[test]
    fn test_pixelate_block_size_one_no_change() {
        let original = create_test_image(10, 10);
        let mut data = original.clone();
        
        pixelate(&mut data, 10, 10, 0, 0, 10, 10, 1);
        
        // With block_size=1, each pixel is its own block, so no change
        assert_eq!(data, original);
    }

    #[test]
    fn test_pixelate_clamps_block_size() {
        let mut data = create_test_image(10, 10);
        
        // Block size 0 should be treated as 1
        pixelate(&mut data, 10, 10, 0, 0, 4, 4, 0);
        
        // Should not panic or produce invalid data
        assert_eq!(data.len(), 400);
    }

    #[test]
    fn test_gaussian_blur_zero_radius() {
        let original = create_test_image(10, 10);
        let mut data = original.clone();
        
        gaussian_blur(&mut data, 10, 10, 0, 0, 10, 10, 0);
        
        // Zero radius should do nothing
        assert_eq!(data, original);
    }

    #[test]
    fn test_gaussian_blur_basic() {
        let mut data = create_test_image(20, 20);
        
        // Put a bright spot in the center
        for y in 8..12 {
            for x in 8..12 {
                let idx = ((y * 20 + x) * 4) as usize;
                data[idx] = 255;
                data[idx + 1] = 255;
                data[idx + 2] = 255;
            }
        }
        
        gaussian_blur(&mut data, 20, 20, 5, 5, 10, 10, 2);
        
        // The bright spot should be blurred (values < 255 in the region)
        // Just verify no panic and reasonable output
        assert_eq!(data.len(), 1600);
    }

    #[test]
    fn test_generate_gaussian_kernel() {
        let kernel = generate_gaussian_kernel(2);
        
        // Kernel size should be 2*radius + 1 = 5
        assert_eq!(kernel.len(), 5);
        
        // Center should be the largest value
        let center_idx = 2;
        for (i, &val) in kernel.iter().enumerate() {
            if i != center_idx {
                assert!(kernel[center_idx] >= val);
            }
        }
        
        // Kernel should be symmetric
        assert!((kernel[0] - kernel[4]).abs() < 0.0001);
        assert!((kernel[1] - kernel[3]).abs() < 0.0001);
    }

    #[test]
    fn test_brush_solid_fill_basic() {
        let mut data = create_test_image(20, 20);
        
        let points = vec![10.0, 10.0];
        brush_solid_fill(&mut data, 20, 20, &points, 4, 255, 0, 0);
        
        // Center should be filled
        let center_idx = (10 * 20 + 10) * 4;
        assert_eq!(data[center_idx as usize], 255);
        assert_eq!(data[center_idx as usize + 1], 0);
        assert_eq!(data[center_idx as usize + 2], 0);
    }

    #[test]
    fn test_brush_solid_fill_circular() {
        let mut data = vec![0u8; 100 * 100 * 4];
        
        let points = vec![50.0, 50.0];
        brush_solid_fill(&mut data, 100, 100, &points, 10, 255, 255, 255);
        
        // Check that the fill is approximately circular
        // Center should be filled
        let center_idx = (50 * 100 + 50) * 4;
        assert_eq!(data[center_idx as usize], 255);
        
        // Far corner should not be filled
        let corner_idx = (0 * 100 + 0) * 4;
        assert_eq!(data[corner_idx as usize], 0);
    }

    #[test]
    fn test_brush_solid_fill_multiple_points() {
        let mut data = vec![0u8; 50 * 50 * 4];
        
        let points = vec![10.0, 10.0, 20.0, 10.0, 30.0, 10.0];
        brush_solid_fill(&mut data, 50, 50, &points, 4, 128, 128, 128);
        
        // All three points should be filled
        for x in [10, 20, 30] {
            let idx = (10 * 50 + x) * 4;
            assert_eq!(data[idx as usize], 128);
        }
    }

    #[test]
    fn test_brush_solid_fill_empty_points() {
        let original = create_test_image(10, 10);
        let mut data = original.clone();
        
        let points: Vec<f32> = vec![];
        brush_solid_fill(&mut data, 10, 10, &points, 4, 255, 0, 0);
        
        // No change with empty points
        assert_eq!(data, original);
    }

    #[test]
    fn test_brush_solid_fill_odd_points_count() {
        let mut data = vec![0u8; 50 * 50 * 4];
        
        // Odd number of points (last one should be ignored)
        let points = vec![10.0, 10.0, 20.0];
        brush_solid_fill(&mut data, 50, 50, &points, 4, 255, 0, 0);
        
        // First point should still be processed
        let idx = (10 * 50 + 10) * 4;
        assert_eq!(data[idx as usize], 255);
    }

    #[test]
    fn test_brush_pixelate_basic() {
        let mut data = create_test_image(50, 50);
        
        let points = vec![25.0, 25.0];
        brush_pixelate(&mut data, 50, 50, &points, 10, 4);
        
        // Should not panic and data should still be valid
        assert_eq!(data.len(), 50 * 50 * 4);
    }

    #[test]
    fn test_brush_pixelate_empty_points() {
        let original = create_test_image(10, 10);
        let mut data = original.clone();
        
        let points: Vec<f32> = vec![];
        brush_pixelate(&mut data, 10, 10, &points, 4, 2);
        
        // No change with empty points
        assert_eq!(data, original);
    }

    #[test]
    fn test_brush_pixelate_out_of_bounds() {
        let mut data = create_test_image(10, 10);
        
        // Points outside the image
        let points = vec![-10.0, -10.0, 100.0, 100.0];
        brush_pixelate(&mut data, 10, 10, &points, 4, 2);
        
        // Should not panic
        assert_eq!(data.len(), 400);
    }
}
