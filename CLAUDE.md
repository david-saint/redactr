# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Redactr is a privacy-focused, browser-local image redaction PWA. All image processing happens client-side via Rust/WebAssembly - no server uploads.

## Tech Stack

- **Frontend**: Svelte 5 + TypeScript + Vite
- **Image Processing**: Rust compiled to WebAssembly (wasm-pack)
- **PWA**: vite-plugin-pwa with service worker for offline support
- **Styling**: CSS custom properties with light/dark/system themes

## Commands

```bash
# Install dependencies
pnpm install

# Development server
pnpm run dev

# Build WASM module (requires wasm-pack)
pnpm run wasm:build        # Release build
pnpm run wasm:dev          # Debug build

# Type check
pnpm run check

# Production build (builds WASM first)
pnpm run build

# Preview production build
pnpm run preview
```

## Prerequisites

- Node.js 18+
- Rust toolchain with `wasm32-unknown-unknown` target
- wasm-pack: `cargo install wasm-pack`

## Architecture

```
src/
├── lib/
│   ├── components/      # Svelte components (Canvas, Toolbar, StylePanel, etc.)
│   ├── stores/          # Svelte stores (document, image, history, settings, theme)
│   ├── gif.ts           # Animated GIF open/render (WASM GifDocument) + worker job client (export, thumbnails)
│   ├── gif.worker.ts    # Module worker running one gifJobs.ts job on its own WASM instance
│   ├── gifJobs.ts       # Worker-side GIF export (GifEncoder), thumbnails, and tracking runs/composition
│   ├── pdf.ts           # PDF.js loading/rendering + minimal image-only PDF writer
│   ├── redaction.ts     # replayCommands()/placeOnFrame(): rebuild an image (or one animation frame) from history commands
│   └── wasm/
│       ├── redactor.ts  # TypeScript wrapper for WASM functions
│       └── pkg/         # Generated WASM output (gitignored)
└── App.svelte           # Main app shell

wasm/
├── Cargo.toml
└── src/
    ├── lib.rs           # Rust redaction algorithms (solid_fill, pixelate, gaussian_blur)
    ├── animation.rs     # GIF decoding with frame compositing (GifDocument) and encoding (GifEncoder)
    └── tracking.rs      # Motion tracking for redactions (trackRegion): template matching with zoom
```

## Key Patterns

### State Management

- `documentStore`: The opened file (image, PDF or animated GIF). For PDFs it owns the PDF.js document, the current page index, and the undo stacks of pages that aren't on screen; `goToPage()` swaps the page into `imageStore`/`historyStore`, and `exportPdf()` replays each page's commands and writes a flattened PDF. For GIFs it owns the decoded animation, the current frame and playback; all frames share one history, `goToFrame()` replays the commands that apply to that frame, and `exportGif()` re-encodes every frame
- `imageStore`: `id` changes only when a different image/page is loaded (not on edits or frame changes), so the canvas keeps its zoom
- `imageStore`: Original and current image data (ImageData objects) for the image or the current PDF page
- `historyStore`: Command pattern for undo/redo - stores redaction operations, not full image copies. A command's optional `frames` range limits it to some animation frames, and an optional `track` makes it follow moving content (anchor box, hand-placed keyframes, a box and match score per frame). `setFrames()`/`setTrack()` push a new version with the same id, and `resolveCommands()`/`activeCommands` collapse versions (latest wins, original drawing order)
- `settingsStore`: Active tool, redaction style, intensity, brush size, fill color
- `theme`: Light/dark/system preference with localStorage persistence

### WASM Integration

The WASM module exports functions that mutate `Uint8ClampedArray` in place:

- `solid_fill()`, `pixelate()`, `gaussian_blur()` for rectangle regions
- `brush_solid_fill()`, `brush_pixelate()` for freehand strokes

TypeScript wrapper (`src/lib/wasm/redactor.ts`) handles initialization and provides typed interface.

### PDF Support

- Pages are rasterized with PDF.js (lazy-loaded, legacy build) at 2x, capped at 4096px on the longest side
- Only one page is held in memory; switching pages re-renders it and restores that page's history
- Export writes a new PDF (`buildImagePdf`) with one JPEG per page at the original page size — no text layer or metadata survives
- PDF.js data files (CMaps, standard fonts, decoder WASM) are served from `/pdfjs/` by the `pdfjsAssets` plugin in `vite.config.ts` and runtime-cached by the service worker

### GIF Support

- `GifDocument` (Rust) stores frames as palette indices and composites them on demand (disposal methods, transparency, partial frames), with full-canvas checkpoints for fast random access. Redactions are always applied to composited frames
- New redactions cover every frame unless the "This frame" scope is chosen in the timeline (`settingsStore.frameScope`, `documentStore.newRedactionFrames()`)
- Export (`GifEncoder`) writes a new file with only pixels, delays and loop count: per-frame palettes (NeuQuant above 256 colors), changed-rectangle frames when consecutive frames are opaque, identical frames merged
- Export and thumbnails run in `gif.worker.ts` (one short-lived worker per job, cancelled when the GIF closes); the worker decodes its own copy of the file bytes kept on `GifSource.bytes`. Vite's `worker.format` is `es` because the worker lazy-loads the WASM module
- Tracking (`documentStore.trackRedaction()`, `placeKeyframe()`, `untrack()`, `cancelTracking(id)`; `trackingStatus`, `boxPlacement`): asking is an undoable step that appends a version with `track.pending`; the worker result is filled into that version (and later versions of the same request) in place with `historyStore.patchVersions()`, so edits made meanwhile and the redo stack survive. Until a track has boxes (pending, failed with `track.failure`, cancelled) the redaction stays where it was drawn on every frame it covers. One job runs at a time; `exportGif()` waits for tracking to finish. Workers run `trackRegion` out from each keyframe; `composeTrack()` keeps keyframes exact, picks the better run between keyframes and interpolates gaps. `placeOnFrame()` moves/scales a tracked redaction onto a frame with at least `TRACK_PADDING` frame pixels. A tracked redaction's range is limited to `trackedSpan()`. The "Follow" scope tracks new redactions automatically (covering every frame until tracked)
- `tracking.rs`: normalized cross-correlation on contrast-normalized luminance (so a cursor can't outweigh thin text), coarse-to-fine with a scale search, anchor plus median-of-recent-matches templates, motion prediction; holds course through short losses (score 0 = estimated) and follows content leaving the frame until it is entirely gone; tall templates compare every few rows (`TEMPLATE_ROWS`) to stay fast
- `applyRectRedaction` clips rectangles to the image (tracked boxes are often partly off-screen; negative coordinates would wrap in the unsigned WASM parameters)
- `FrameTimeline.svelte`: play/scrub (`,` `.` `K`), scope toggle, a thumbnail strip (`frameThumbnails`, with redactions covered), and one track per redaction: drag the ends or the bar to change its frames (arrow keys on the focused handles), or use the range fields

### Canvas Rendering

Two-layer canvas system:

- Base canvas: displays current image state
- Overlay canvas: selection UI, brush preview (cleared on each render)

## Redaction Styles

| Style    | Parameter             | Range     |
| -------- | --------------------- | --------- |
| Solid    | fillColor             | Hex color |
| Pixelate | intensity → blockSize | 4-32px    |
| Blur     | intensity → radius    | 2-20px    |
