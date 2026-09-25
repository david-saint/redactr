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
│   ├── pdf.ts           # PDF.js loading/rendering + minimal image-only PDF writer
│   ├── redaction.ts     # replayCommands(): rebuild an image from history commands
│   └── wasm/
│       ├── redactor.ts  # TypeScript wrapper for WASM functions
│       └── pkg/         # Generated WASM output (gitignored)
└── App.svelte           # Main app shell

wasm/
├── Cargo.toml
└── src/
    └── lib.rs           # Rust redaction algorithms (solid_fill, pixelate, gaussian_blur)
```

## Key Patterns

### State Management

- `documentStore`: The opened file (image or PDF). For PDFs it owns the PDF.js document, the current page index, and the undo stacks of pages that aren't on screen; `goToPage()` swaps the page into `imageStore`/`historyStore`, and `exportPdf()` replays each page's commands and writes a flattened PDF
- `imageStore`: Original and current image data (ImageData objects) for the image or the current PDF page
- `historyStore`: Command pattern for undo/redo - stores redaction operations, not full image copies
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
