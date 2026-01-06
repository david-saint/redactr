# Redactr

A privacy-focused image redaction tool that runs entirely in your browser. No uploads, no servers - all processing happens locally using WebAssembly.

## Features

- **100% Local Processing** - Your images never leave your device
- **Multiple Redaction Styles** - Solid fill, pixelation, and gaussian blur
- **Rectangle & Brush Tools** - Precise selection or freehand redaction
- **Adjustable Intensity** - Control blur radius or pixel block size
- **Undo/Redo** - Full history support with keyboard shortcuts
- **PWA** - Install on desktop or mobile, works offline
- **Light/Dark/System Themes** - Minimalist interface

## Getting Started

### Prerequisites

- Node.js 18+
- Rust toolchain with `wasm32-unknown-unknown` target
- wasm-pack: `cargo install wasm-pack`

### Installation

```bash
# Install dependencies
npm install

# Build WASM module
npm run wasm:build

# Start development server
npm run dev
```

### Production Build

```bash
npm run build
npm run preview
```

## Tech Stack

- Svelte 5 + TypeScript + Vite
- Rust + WebAssembly (wasm-pack)
- PWA with vite-plugin-pwa

## License

MIT
