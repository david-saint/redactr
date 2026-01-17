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
    detectionStore,
    type Detection,
    type DetectionType,
  } from "../stores/detection";
  import {
    applyRectRedaction,
    applyBrushRedaction,
    isWasmReady,
    wasmReady,
  } from "../wasm/redactor";
  import { zoomStore, MIN_ZOOM, MAX_ZOOM } from "../stores/zoom";

  // Detection type colors
  const detectionColors: Record<DetectionType, string> = {
    face: '#f59e0b',      // Amber
    text: '#3b82f6',      // Blue
    license_plate: '#10b981', // Emerald
    document: '#8b5cf6',   // Purple
  };

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

  // Pan state
  let isPanMode = false;
  let panStart: { x: number; y: number } | null = null;

  // Pinch-to-zoom state
  let pinchState: {
    initialDistance: number;
    initialZoom: number;
    initialPanX: number;
    initialPanY: number;
    centerX: number;
    centerY: number;
  } | null = null;

  // Computed effective scale and offset (base fit-to-container + user zoom/pan)
  $: effectiveScale = scale * $zoomStore.zoom;
  $: effectiveOffsetX = offsetX + $zoomStore.panX;
  $: effectiveOffsetY = offsetY + $zoomStore.panY;

  $: canvasWidth = $imageStore.width;
  $: canvasHeight = $imageStore.height;

  // Render image when it first loads or changes
  $: if ($imageStore.current && ctx) {
    // Reset zoom when image changes
    zoomStore.reset();
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

    // Draw detection bounding boxes
    if ($detectionStore.results.length > 0) {
      for (const detection of $detectionStore.results) {
        const { x, y, width, height } = detection.bbox;
        const color = detectionColors[detection.type];

        // Draw fill
        overlayCtx.fillStyle = detection.selected
          ? `${color}30`  // 30% opacity when selected
          : `${color}15`; // 15% opacity when not selected
        overlayCtx.fillRect(x, y, width, height);

        // Draw border
        overlayCtx.strokeStyle = detection.selected ? color : `${color}80`;
        overlayCtx.lineWidth = detection.selected ? 3 / effectiveScale : 2 / effectiveScale;
        overlayCtx.setLineDash([]);
        overlayCtx.strokeRect(x, y, width, height);

        // Draw label
        const label = detection.label || detection.type;
        const fontSize = Math.max(12, 14 / effectiveScale);
        overlayCtx.font = `${fontSize}px system-ui, sans-serif`;
        const textMetrics = overlayCtx.measureText(label);
        const textHeight = fontSize + 4;
        const textPadding = 4;

        // Label background
        overlayCtx.fillStyle = color;
        overlayCtx.fillRect(
          x,
          y - textHeight - 2,
          textMetrics.width + textPadding * 2,
          textHeight
        );

        // Label text
        overlayCtx.fillStyle = 'white';
        overlayCtx.fillText(label, x + textPadding, y - 6);

        // Selection indicator
        if (detection.selected) {
          // Draw checkmark in corner
          const checkSize = 16 / effectiveScale;
          overlayCtx.fillStyle = color;
          overlayCtx.beginPath();
          overlayCtx.arc(x + width - checkSize/2 - 4, y + checkSize/2 + 4, checkSize/2, 0, Math.PI * 2);
          overlayCtx.fill();

          overlayCtx.strokeStyle = 'white';
          overlayCtx.lineWidth = 2 / effectiveScale;
          overlayCtx.beginPath();
          overlayCtx.moveTo(x + width - checkSize - 2, y + checkSize/2 + 4);
          overlayCtx.lineTo(x + width - checkSize/2 - 4, y + checkSize + 2);
          overlayCtx.lineTo(x + width - 4, y + 6);
          overlayCtx.stroke();
        }
      }
    }

    // Draw selection rectangle
    if (selectionStart && selectionEnd && $settingsStore.tool === "rect") {
      const x = Math.min(selectionStart.x, selectionEnd.x);
      const y = Math.min(selectionStart.y, selectionEnd.y);
      const w = Math.abs(selectionEnd.x - selectionStart.x);
      const h = Math.abs(selectionEnd.y - selectionStart.y);

      overlayCtx.strokeStyle = "rgba(99, 102, 241, 0.9)";
      overlayCtx.lineWidth = 2 / effectiveScale;
      overlayCtx.setLineDash([6 / effectiveScale, 4 / effectiveScale]);
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

  // Re-render overlay when detection results change
  $: if ($detectionStore.results && overlayCtx) {
    renderOverlay();
  }

  function getCanvasCoords(e: MouseEvent): { x: number; y: number } {
    const rect = canvasEl.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / effectiveScale,
      y: (e.clientY - rect.top) / effectiveScale,
    };
  }

  function getTouchCoords(e: TouchEvent): { x: number; y: number } {
    const rect = canvasEl.getBoundingClientRect();
    const touch = e.touches[0] || e.changedTouches[0];
    return {
      x: (touch.clientX - rect.left) / effectiveScale,
      y: (touch.clientY - rect.top) / effectiveScale,
    };
  }

  // Wheel zoom handler
  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = containerEl.getBoundingClientRect();
    const centerX = e.clientX - rect.left;
    const centerY = e.clientY - rect.top;
    // Proportional zoom based on current zoom level
    const delta = -e.deltaY * 0.001 * $zoomStore.zoom;
    zoomStore.zoomAtPoint(delta, centerX, centerY);
  }

  // Keyboard handlers for pan mode
  function handleKeyDown(e: KeyboardEvent) {
    if (e.code === 'Space' && !isPanMode && !e.repeat) {
      e.preventDefault();
      isPanMode = true;
      zoomStore.setPanning(true);
    }
  }

  function handleKeyUp(e: KeyboardEvent) {
    if (e.code === 'Space') {
      isPanMode = false;
      zoomStore.setPanning(false);
      panStart = null;
    }
  }

  // Pinch-to-zoom helpers
  function getTouchDistance(touches: TouchList): number {
    if (touches.length < 2) return 0;
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  function getTouchCenter(touches: TouchList): { x: number; y: number } {
    if (touches.length < 2) return { x: 0, y: 0 };
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2
    };
  }

  function handleMouseDown(e: MouseEvent) {
    // Middle mouse button for pan
    if (e.button === 1) {
      e.preventDefault();
      panStart = { x: e.clientX, y: e.clientY };
      zoomStore.setPanning(true);
      return;
    }

    // Hand tool pans on left click
    if (e.button === 0 && $settingsStore.tool === 'hand') {
      e.preventDefault();
      panStart = { x: e.clientX, y: e.clientY };
      zoomStore.setPanning(true);
      return;
    }

    // Space + left click for pan
    if (e.button === 0 && isPanMode) {
      e.preventDefault();
      panStart = { x: e.clientX, y: e.clientY };
      return;
    }

    if (e.button !== 0) return;

    const coords = getCanvasCoords(e);

    // Check if clicking on a detection box
    if ($detectionStore.results.length > 0) {
      for (const detection of $detectionStore.results) {
        const { x, y, width, height } = detection.bbox;
        if (
          coords.x >= x &&
          coords.x <= x + width &&
          coords.y >= y &&
          coords.y <= y + height
        ) {
          // Toggle selection
          detectionStore.toggleSelection(detection.id);
          renderOverlay();
          return; // Don't start drawing
        }
      }
    }

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
    // Handle panning (hand tool, space+drag, or middle mouse)
    if (panStart && ($settingsStore.tool === 'hand' || isPanMode || e.buttons === 4)) {
      const deltaX = e.clientX - panStart.x;
      const deltaY = e.clientY - panStart.y;
      zoomStore.pan(deltaX, deltaY);
      panStart = { x: e.clientX, y: e.clientY };
      return;
    }

    const coords = getCanvasCoords(e);

    if (isSelecting && $settingsStore.tool === "rect") {
      selectionEnd = coords;
      renderOverlay();
    } else if (isBrushing && $settingsStore.tool === "brush") {
      brushPoints.push(coords.x, coords.y);
      renderOverlay();
    }
  }

  function handleMouseUp(e: MouseEvent) {
    // End pan if middle mouse was used
    if (e.button === 1) {
      panStart = null;
      zoomStore.setPanning(false);
      return;
    }

    // End pan if hand tool
    if ($settingsStore.tool === 'hand' && panStart) {
      panStart = null;
      zoomStore.setPanning(false);
      return;
    }

    // End pan if space+click
    if (panStart && isPanMode) {
      panStart = null;
      return;
    }

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

  // Touch event handlers for mobile
  function handleTouchStart(e: TouchEvent) {
    // Pinch-to-zoom with 2 fingers
    if (e.touches.length === 2) {
      e.preventDefault();
      const distance = getTouchDistance(e.touches);
      const center = getTouchCenter(e.touches);
      const rect = containerEl.getBoundingClientRect();

      pinchState = {
        initialDistance: distance,
        initialZoom: $zoomStore.zoom,
        initialPanX: $zoomStore.panX,
        initialPanY: $zoomStore.panY,
        centerX: center.x - rect.left,
        centerY: center.y - rect.top
      };
      return;
    }

    e.preventDefault(); // Prevent scrolling while drawing
    const coords = getTouchCoords(e);

    if ($settingsStore.tool === "rect") {
      isSelecting = true;
      selectionStart = coords;
      selectionEnd = coords;
    } else if ($settingsStore.tool === "brush") {
      isBrushing = true;
      brushPoints = [coords.x, coords.y];
    }
  }

  function handleTouchMove(e: TouchEvent) {
    // Handle pinch-to-zoom
    if (e.touches.length === 2 && pinchState) {
      e.preventDefault();

      const newDistance = getTouchDistance(e.touches);
      const newCenter = getTouchCenter(e.touches);
      const rect = containerEl.getBoundingClientRect();

      // Calculate zoom from pinch
      const zoomRatio = newDistance / pinchState.initialDistance;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
        pinchState.initialZoom * zoomRatio
      ));

      // Calculate pan from gesture movement
      const centerX = newCenter.x - rect.left;
      const centerY = newCenter.y - rect.top;
      const panDeltaX = centerX - pinchState.centerX;
      const panDeltaY = centerY - pinchState.centerY;

      // Apply zoom centered on pinch center
      const actualRatio = newZoom / pinchState.initialZoom;
      const panX = pinchState.initialPanX + panDeltaX -
        (pinchState.centerX - pinchState.initialPanX) * (actualRatio - 1);
      const panY = pinchState.initialPanY + panDeltaY -
        (pinchState.centerY - pinchState.initialPanY) * (actualRatio - 1);

      zoomStore.setZoom(newZoom);
      zoomStore.setPan(panX, panY);
      return;
    }

    e.preventDefault();
    const coords = getTouchCoords(e);

    if (isSelecting && $settingsStore.tool === "rect") {
      selectionEnd = coords;
      renderOverlay();
    } else if (isBrushing && $settingsStore.tool === "brush") {
      brushPoints.push(coords.x, coords.y);
      renderOverlay();
    }
  }

  function handleTouchEnd(e: TouchEvent) {
    e.preventDefault();

    // End pinch if fewer than 2 touches remain
    if (e.touches.length < 2) {
      pinchState = null;
    }

    // Only end drawing if no touches remain
    if (e.touches.length > 0) return;

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

<svelte:window on:keydown={handleKeyDown} on:keyup={handleKeyUp} />

<div
  class="canvas-container"
  bind:this={containerEl}
  on:wheel={handleWheel}
>
  <div
    class="canvas-wrapper"
    style="
      transform: translate({effectiveOffsetX}px, {effectiveOffsetY}px) scale({effectiveScale});
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
      class:rect-cursor={$settingsStore.tool === "rect" && !$zoomStore.isPanning}
      class:brush-cursor={$settingsStore.tool === "brush" && !$zoomStore.isPanning}
      class:hand-cursor={$settingsStore.tool === "hand" && !panStart}
      class:panning={$zoomStore.isPanning && $settingsStore.tool !== "hand"}
      class:pan-active={panStart !== null}
      on:mousedown={handleMouseDown}
      on:mousemove={handleMouseMove}
      on:mouseup={handleMouseUp}
      on:mouseleave={handleMouseUp}
      on:touchstart={handleTouchStart}
      on:touchmove={handleTouchMove}
      on:touchend={handleTouchEnd}
      on:touchcancel={handleTouchEnd}
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
    touch-action: none; /* Prevent browser gestures while drawing */
  }

  .rect-cursor {
    cursor: crosshair;
  }

  .brush-cursor {
    cursor: crosshair;
  }

  .hand-cursor {
    cursor: grab;
  }

  .panning {
    cursor: grab;
  }

  .pan-active {
    cursor: grabbing;
  }

  @media (max-width: 767px) {
    .canvas-container {
      /* Account for mobile bottom panel */
      padding-bottom: calc(var(--mobile-panel-height) + var(--safe-area-bottom));
    }
  }
</style>
