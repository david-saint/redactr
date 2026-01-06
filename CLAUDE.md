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
npm install

# Development server
npm run dev

# Build WASM module (requires wasm-pack)
npm run wasm:build        # Release build
npm run wasm:dev          # Debug build

# Type check
npm run check

# Production build (builds WASM first)
npm run build

# Preview production build
npm run preview
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
│   ├── stores/          # Svelte stores (image, history, settings, theme)
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
- `imageStore`: Original and current image data (ImageData objects)
- `historyStore`: Command pattern for undo/redo - stores redaction operations, not full image copies
- `settingsStore`: Active tool, redaction style, intensity, brush size, fill color
- `theme`: Light/dark/system preference with localStorage persistence

### WASM Integration
The WASM module exports functions that mutate `Uint8ClampedArray` in place:
- `solid_fill()`, `pixelate()`, `gaussian_blur()` for rectangle regions
- `brush_solid_fill()`, `brush_pixelate()` for freehand strokes

TypeScript wrapper (`src/lib/wasm/redactor.ts`) handles initialization and provides typed interface.

### Canvas Rendering
Two-layer canvas system:
- Base canvas: displays current image state
- Overlay canvas: selection UI, brush preview (cleared on each render)

## Redaction Styles

| Style | Parameter | Range |
|-------|-----------|-------|
| Solid | fillColor | Hex color |
| Pixelate | intensity → blockSize | 4-32px |
| Blur | intensity → radius | 2-20px |
