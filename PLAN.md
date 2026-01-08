# Redactr - Browser-Local Image Redaction Tool

## Overview

A privacy-focused PWA for redacting sensitive content from images. All processing happens locally via Rust/WASM - no server uploads.

## Tech Stack

- **Frontend**: Svelte 5 + Vite + TypeScript
- **Image Processing**: Rust compiled to WebAssembly
- **PWA**: Vite PWA plugin with service worker for offline support
- **Styling**: CSS with custom properties for theming (minimalist aesthetic)

## Architecture

```
redactr/
├── src/
│   ├── lib/
│   │   ├── components/        # Svelte components
│   │   │   ├── Canvas.svelte      # Main editing canvas
│   │   │   ├── Toolbar.svelte     # Tool selection
│   │   │   ├── StylePanel.svelte  # Redaction style/intensity
│   │   │   └── ExportPanel.svelte # Export options
│   │   ├── stores/            # Svelte stores
│   │   │   ├── image.ts           # Current image state
│   │   │   ├── history.ts         # Undo/redo stack
│   │   │   └── settings.ts        # Tool settings
│   │   └── wasm/              # WASM bindings
│   │       └── redactor.ts        # TypeScript wrapper for WASM
│   ├── App.svelte
│   └── main.ts
├── wasm/                      # Rust WASM crate
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs                 # WASM entry point
│       ├── redaction.rs           # Redaction algorithms
│       │   ├── solid_fill()
│       │   ├── pixelate()
│       │   └── gaussian_blur()
│       └── detection.rs           # Face detection
└── public/
    └── manifest.json          # PWA manifest
```

## Key Design Decisions

### 1. Image Processing in Rust/WASM

All pixel manipulation happens in Rust for performance:

- **Solid fill**: Direct pixel replacement in specified region
- **Pixelation**: Average color blocks at configurable block size
- **Gaussian blur**: Separable convolution kernel for speed

The WASM module receives image data as `Uint8Array` (RGBA), processes it, and returns the modified buffer.

### 2. Face Detection Strategy

Use browser's native `FaceDetector` API (Shape Detection API) when available, with fallback to a lightweight WASM-based detector using the `rustface` crate (SeetaFace detector).

```typescript
// Detection priority
1. navigator.FaceDetector (Chrome, Edge - hardware accelerated)
2. rustface WASM fallback (Firefox, Safari, older browsers)
```

### 3. Undo/Redo System

Command pattern with an immutable history stack:

- Each redaction operation creates a "command" object
- Commands contain: region, style, intensity, timestamp
- Store as lightweight diffs rather than full image copies
- Re-apply from original when undoing (more memory efficient)

### 4. Canvas Rendering

Two-layer canvas system:

- **Base layer**: Original image + applied redactions
- **Overlay layer**: Selection UI, brush preview, face detection boxes

### 5. PWA Configuration

- Service worker caches all assets for offline use
- App installable on desktop/mobile
- No network requests required after initial load

### 6. Theme System

- Three modes: Light, Dark, System (follows OS preference)
- CSS custom properties for all colors
- Theme toggle in UI with localStorage persistence
- `prefers-color-scheme` media query for system mode

## Implementation Phases

### Phase 1: Project Setup ✅

- Initialize Svelte 5 + Vite + TypeScript project
- Configure Rust/WASM toolchain with wasm-pack
- Set up PWA manifest and service worker
- Create basic app shell with minimalist styling
- Implement theme system (light/dark/system toggle)

### Phase 2: Core WASM Module ✅

- Implement solid fill redaction
- Implement pixelation with configurable block size
- Implement gaussian blur with adjustable radius
- Create TypeScript bindings

### Phase 3: Canvas & Tools ✅

- Implement canvas component with image loading (drag-drop, file picker)
- Rectangle selection tool
- Freehand brush tool with configurable size
- Tool switching and cursor feedback

### Phase 4: Redaction UI ✅

- Style selection panel (solid/pixelate/blur)
- Intensity slider (maps to block size or blur radius)
- Color picker for solid fill
- Apply redaction button

### Phase 5: History & Export ✅

- Implement undo/redo stack
- Keyboard shortcuts (Ctrl+Z, Ctrl+Shift+Z)
- Export to PNG/JPEG with quality options
- Download or copy to clipboard

### Phase 6: Auto-Detect AI Feature ✅

Client-side AI detection of privacy-sensitive content (faces, text, license plates, documents).

**Technology Stack:**
| Detection | Library | Model Size | Status |
|-----------|---------|------------|--------|
| Faces | **MediaPipe Face Detector** | **~260KB** | ✅ Implemented |
| Text/OCR | Tesseract.js | ~5MB | ✅ Implemented |
| License Plates | **YOLOS-LPD specialized** | **~25 MB** | ✅ Implemented |
| Documents | DETR via @xenova/transformers | ~10MB | ✅ Implemented |

**Architecture:**

- **Face Detection**: MediaPipe runs in main thread (99%+ accuracy, 260KB model)
- **Object Detection**: Web Worker with @xenova/transformers (license plates, documents)
- **Text Detection**: Tesseract.js in main thread
- WebGPU → WebGL → WASM/CPU backend cascade
- Model caching via Service Worker + IndexedDB for offline use

**Key Files:**

- `src/lib/stores/detection.ts` - Detection state & results
- `src/lib/detection/manager.ts` - Orchestrates detectors
- `src/lib/detection/worker.ts` - Web Worker for ML inference
- `src/lib/detection/mediapipe-face.ts` - MediaPipe Face Detector wrapper
- `src/lib/detection/types.ts` - Detection types and worker messages
- `src/lib/components/DetectionPanel.svelte` - UI controls
- Canvas overlay renders bounding boxes on detected regions

**Dependencies:**

```json
{
  "@mediapipe/tasks-vision": "^0.10.22",
  "@xenova/transformers": "^2.17.2",
  "tesseract.js": "^7.0.0"
}
```

## Key Files

1. `package.json` - Dependencies and scripts
2. `vite.config.ts` - Vite + WASM + PWA config
3. `wasm/Cargo.toml` - Rust dependencies
4. `wasm/src/lib.rs` - WASM entry point
5. `src/App.svelte` - Main app layout
6. `src/lib/components/Canvas.svelte` - Core canvas component
7. `src/lib/stores/history.ts` - Undo/redo implementation
