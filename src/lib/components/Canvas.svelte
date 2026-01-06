<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { imageStore } from "../stores/image";
  import { settingsStore } from "../stores/settings";
  import {
    historyStore,
    activeCommands,
    type RedactionCommand,
  } from "../stores/history";
  import {
    applyRectRedaction,
    applyBrushRedaction,
    isWasmReady,
    wasmReady,
  } from "../wasm/redactor";

  let containerEl: HTMLDivElement;
  let canvasEl: HTMLCanvasElement;
  let overlayEl: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let overlayCtx: CanvasRenderingContext2D;

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;

  // Selection state
  let isSelecting = false;
  let selectionStart: { x: number; y: number } | null = null;
  let selectionEnd: { x: number; y: number } | null = null;

  // Brush state
  let isBrushing = false;
  let brushPoints: number[] = [];

  $: canvasWidth = $imageStore.width;
  $: canvasHeight = $imageStore.height;

  // Render image when it first loads or changes
  $: if ($imageStore.current && ctx) {
    // Defer to ensure canvas dimensions are updated in DOM
    requestAnimationFrame(() => {
      fitToContainer();
      renderImage();
    });
  }

  // Rebuild image when active commands change (undo/redo)
  // Use version to track changes since activeCommands array reference may stay same
  let lastVersion = -1;
  $: if ($imageStore.original && historyVersion !== lastVersion) {
    lastVersion = historyVersion;
    rebuildImage($activeCommands);
  }

  // Track history version for undo/redo reactivity
  let historyVersion = 0;
  historyStore.subscribe((state) => {
    historyVersion = state.version;
  });

  let resizeObserver: ResizeObserver;

  onMount(() => {
    ctx = canvasEl.getContext("2d")!;
    overlayCtx = overlayEl.getContext("2d")!;

    // Use ResizeObserver to detect container size changes
    // This is more reliable than window resize, especially for initial layout
    resizeObserver = new ResizeObserver(() => {
      fitToContainer();
      renderImage();
    });

    if (containerEl) {
      resizeObserver.observe(containerEl);
    }

    // Ensure WASM is ready (fire and forget, but logged for debugging)
    wasmReady.then(() => {
      console.log("Canvas: WASM ready");
    });
  });

  onDestroy(() => {
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
  });

  function fitToContainer() {
    if (!containerEl || !$imageStore.current) return;

    const containerRect = containerEl.getBoundingClientRect();

    // Avoid calculations if container is hidden or has no size yet
    if (containerRect.width === 0 || containerRect.height === 0) return;

    const padding = 40;
    const availableWidth = containerRect.width - padding * 2;
    const availableHeight = containerRect.height - padding * 2;

    const scaleX = availableWidth / $imageStore.width;
    const scaleY = availableHeight / $imageStore.height;
    scale = Math.min(scaleX, scaleY, 1);

    offsetX = (containerRect.width - $imageStore.width * scale) / 2;
    offsetY = (containerRect.height - $imageStore.height * scale) / 2;
  }

  function rebuildImage(commands: RedactionCommand[]) {
    if (!$imageStore.original || !isWasmReady()) return;

    // Start from original image
    let currentData = new ImageData(
      new Uint8ClampedArray($imageStore.original.data),
      $imageStore.width,
      $imageStore.height
    );

    // Replay all active commands
    for (const cmd of commands) {
      if (cmd.type === "rect" && cmd.region) {
        currentData = applyRectRedaction(
          currentData,
          cmd.region.x,
          cmd.region.y,
          cmd.region.width,
          cmd.region.height,
          {
            style: cmd.style,
            intensity: cmd.intensity,
            color: cmd.color,
          }
        );
      } else if (cmd.type === "brush" && cmd.points) {
        currentData = applyBrushRedaction(
          currentData,
          cmd.points,
          cmd.brushSize || 20,
          {
            style: cmd.style,
            intensity: cmd.intensity,
            color: cmd.color,
          }
        );
      }
    }

    imageStore.updateCurrent(currentData);
    renderImage();
  }

  function renderImage() {
    if (!ctx || !$imageStore.current) return;
    ctx.putImageData($imageStore.current, 0, 0);
  }

  function renderOverlay() {
    if (!overlayCtx) return;
    overlayCtx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Draw selection rectangle
    if (selectionStart && selectionEnd && $settingsStore.tool === "rect") {
      const x = Math.min(selectionStart.x, selectionEnd.x);
      const y = Math.min(selectionStart.y, selectionEnd.y);
      const w = Math.abs(selectionEnd.x - selectionStart.x);
      const h = Math.abs(selectionEnd.y - selectionStart.y);

      overlayCtx.strokeStyle = "rgba(99, 102, 241, 0.9)";
      overlayCtx.lineWidth = 2 / scale;
      overlayCtx.setLineDash([6 / scale, 4 / scale]);
      overlayCtx.strokeRect(x, y, w, h);

      overlayCtx.fillStyle = "rgba(99, 102, 241, 0.15)";
      overlayCtx.fillRect(x, y, w, h);
    }

    // Draw brush preview
    if (brushPoints.length >= 2 && $settingsStore.tool === "brush") {
      overlayCtx.strokeStyle = "rgba(99, 102, 241, 0.6)";
      overlayCtx.lineWidth = $settingsStore.brushSize;
      overlayCtx.lineCap = "round";
      overlayCtx.lineJoin = "round";
      overlayCtx.setLineDash([]);

      overlayCtx.beginPath();
      overlayCtx.moveTo(brushPoints[0], brushPoints[1]);
      for (let i = 2; i < brushPoints.length; i += 2) {
        overlayCtx.lineTo(brushPoints[i], brushPoints[i + 1]);
      }
      overlayCtx.stroke();
    }
  }

  function getCanvasCoords(e: MouseEvent): { x: number; y: number } {
    const rect = canvasEl.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  }

  function handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;

    const coords = getCanvasCoords(e);

    if ($settingsStore.tool === "rect") {
      isSelecting = true;
      selectionStart = coords;
      selectionEnd = coords;
    } else if ($settingsStore.tool === "brush") {
      isBrushing = true;
      brushPoints = [coords.x, coords.y];
    }
  }

  function handleMouseMove(e: MouseEvent) {
    const coords = getCanvasCoords(e);

    if (isSelecting && $settingsStore.tool === "rect") {
      selectionEnd = coords;
      renderOverlay();
    } else if (isBrushing && $settingsStore.tool === "brush") {
      brushPoints.push(coords.x, coords.y);
      renderOverlay();
    }
  }

  function handleMouseUp() {
    if (isSelecting && selectionStart && selectionEnd) {
      applyRectSelection();
    } else if (isBrushing && brushPoints.length >= 2) {
      applyBrushStroke();
    }

    isSelecting = false;
    isBrushing = false;
    selectionStart = null;
    selectionEnd = null;
    brushPoints = [];
    renderOverlay();
  }

  function applyRectSelection() {
    if (
      !selectionStart ||
      !selectionEnd ||
      !$imageStore.current ||
      !isWasmReady()
    )
      return;

    const x = Math.max(0, Math.min(selectionStart.x, selectionEnd.x));
    const y = Math.max(0, Math.min(selectionStart.y, selectionEnd.y));
    const w = Math.min(
      canvasWidth - x,
      Math.abs(selectionEnd.x - selectionStart.x)
    );
    const h = Math.min(
      canvasHeight - y,
      Math.abs(selectionEnd.y - selectionStart.y)
    );

    if (w < 2 || h < 2) return;

    const newImageData = applyRectRedaction($imageStore.current, x, y, w, h, {
      style: $settingsStore.style,
      intensity: $settingsStore.intensity,
      color: $settingsStore.fillColor,
    });

    imageStore.updateCurrent(newImageData);
    renderImage();

    historyStore.push({
      type: "rect",
      style: $settingsStore.style,
      region: { x, y, width: w, height: h },
      points: null,
      intensity: $settingsStore.intensity,
      color: $settingsStore.fillColor,
    });
  }

  function applyBrushStroke() {
    if (brushPoints.length < 2 || !$imageStore.current || !isWasmReady())
      return;

    const newImageData = applyBrushRedaction(
      $imageStore.current,
      brushPoints,
      $settingsStore.brushSize,
      {
        style: $settingsStore.style,
        intensity: $settingsStore.intensity,
        color: $settingsStore.fillColor,
      }
    );

    imageStore.updateCurrent(newImageData);
    renderImage();

    historyStore.push({
      type: "brush",
      style: $settingsStore.style,
      region: null,
      points: [...brushPoints],
      brushSize: $settingsStore.brushSize,
      intensity: $settingsStore.intensity,
      color: $settingsStore.fillColor,
    });
  }
</script>

<div class="canvas-container" bind:this={containerEl}>
  <div
    class="canvas-wrapper"
    style="
      transform: translate({offsetX}px, {offsetY}px) scale({scale}); 
      width: {canvasWidth}px; 
      height: {canvasHeight}px;
    "
  >
    <canvas
      bind:this={canvasEl}
      width={canvasWidth}
      height={canvasHeight}
      class="main-canvas"
    ></canvas>
    <canvas
      bind:this={overlayEl}
      width={canvasWidth}
      height={canvasHeight}
      class="overlay-canvas"
      class:rect-cursor={$settingsStore.tool === "rect"}
      class:brush-cursor={$settingsStore.tool === "brush"}
      on:mousedown={handleMouseDown}
      on:mousemove={handleMouseMove}
      on:mouseup={handleMouseUp}
      on:mouseleave={handleMouseUp}
    ></canvas>
  </div>
</div>

<style>
  .canvas-container {
    flex: 1;
    position: relative;
    overflow: hidden;
    background: var(--canvas-bg);
  }

  .canvas-wrapper {
    position: absolute;
    transform-origin: top left;
    border-radius: 8px;
    overflow: hidden;
    box-shadow:
      0 4px 6px -1px rgba(0, 0, 0, 0.1),
      0 2px 4px -2px rgba(0, 0, 0, 0.1),
      0 0 0 1px rgba(0, 0, 0, 0.05);
  }

  .main-canvas,
  .overlay-canvas {
    display: block;
    position: absolute;
    top: 0;
    left: 0;
  }

  .main-canvas {
    background: white;
  }

  .overlay-canvas {
    z-index: 1;
  }

  .rect-cursor {
    cursor: crosshair;
  }

  .brush-cursor {
    cursor: crosshair;
  }
</style>
