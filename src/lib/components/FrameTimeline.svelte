<script lang="ts">
  import { onDestroy } from 'svelte';
  import { documentStore, frameThumbnails, THUMBNAIL_HEIGHT } from '../stores/document';
  import { imageStore } from '../stores/image';
  import {
    historyStore,
    activeCommands,
    selectedRedactionId,
    type FrameRange,
    type RedactionCommand
  } from '../stores/history';
  import { thumbnailFrames } from '../gifJobs';
  import { appliesToFrame } from '../redaction';
  import type { FrameThumbnail } from '../gif';
  import { settingsStore, type FrameScope } from '../stores/settings';
  import { detectionStore } from '../stores/detection';
  import { cancelDetection } from '../detection/manager';

  const styleLabels = { solid: 'Solid', pixelate: 'Pixelate', blur: 'Blur' };
  const scopes: { id: FrameScope; label: string }[] = [
    { id: 'all', label: 'All frames' },
    { id: 'current', label: 'This frame' }
  ];

  let frameCount = $derived($documentStore.frameCount);
  let current = $derived($documentStore.currentFrame);
  let playing = $derived($documentStore.isPlaying);
  let selected = $derived(
    $activeCommands.find(c => c.id === $selectedRedactionId) ?? null
  );
  let selectedIndex = $derived(selected ? $activeCommands.indexOf(selected) : -1);

  onDestroy(() => selectedRedactionId.set(null));

  /**
   * A pointer drag in a track lane or the thumbnail strip: `seek` scrubs the
   * playhead, `start`/`end` move a range's edge, `move` shifts the whole range.
   */
  type DragMode = 'seek' | 'start' | 'end' | 'move';
  interface Drag {
    id: string | null;
    mode: DragMode;
    pointerId: number;
    originFrame: number;
    initial: FrameRange;
    range: FrameRange;
    moved: boolean;
  }
  let drag = $state<Drag | null>(null);

  // Thumbnail strip: as many frames as fit at the image's aspect ratio.
  let stripWidth = $state(0);
  let slotWidth = $derived(
    Math.min(
      THUMBNAIL_HEIGHT * 2.4,
      Math.max(24, (THUMBNAIL_HEIGHT * $imageStore.width) / ($imageStore.height || 1))
    )
  );
  let slots = $derived(
    thumbnailFrames(
      frameCount,
      Math.max(1, Math.floor(stripWidth / slotWidth))
    ).map(frame => ({ frame, thumbnail: nearestThumbnail(frame) }))
  );

  /** The loaded thumbnail closest to a frame, if any. */
  function nearestThumbnail(frame: number) {
    const { count, items } = $frameThumbnails;
    if (count === 0) return undefined;
    const k = Math.round((frame * (count - 1)) / Math.max(1, frameCount - 1));
    for (let d = 0; d < count; d++) {
      const item = items[k - d] ?? items[k + d];
      if (item) return item;
    }
    return undefined;
  }

  interface ThumbnailPaint {
    thumbnail: FrameThumbnail;
    commands: RedactionCommand[];
    imageWidth: number;
  }

  /**
   * Svelte action: draw a thumbnail with the redactions that apply to its
   * frame covered, so the strip never shows what the canvas hides.
   */
  function paint(canvas: HTMLCanvasElement, params: ThumbnailPaint) {
    const draw = ({ thumbnail, commands, imageWidth }: ThumbnailPaint) => {
      const { image, frame } = thumbnail;
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.putImageData(image, 0, 0);

      const scale = image.width / (imageWidth || image.width);
      ctx.save();
      ctx.scale(scale, scale);
      for (const cmd of commands) {
        if (!appliesToFrame(cmd, frame)) continue;
        const fill = cmd.style === 'solid' ? cmd.color : 'rgb(113, 113, 122)';
        if (cmd.region) {
          ctx.fillStyle = fill;
          const { x, y, width, height } = cmd.region;
          ctx.fillRect(x, y, width, height);
        } else if (cmd.points && cmd.points.length >= 2) {
          ctx.strokeStyle = fill;
          ctx.lineWidth = cmd.brushSize || 20;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(cmd.points[0], cmd.points[1]);
          for (let i = 2; i + 1 < cmd.points.length; i += 2) {
            ctx.lineTo(cmd.points[i], cmd.points[i + 1]);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
    };
    draw(params);
    return { update: draw };
  }

  function rangeOf(cmd: RedactionCommand) {
    return cmd.frames ?? { start: 0, end: frameCount - 1 };
  }

  function label(cmd: RedactionCommand, index: number) {
    return `${cmd.type === 'rect' ? 'Box' : 'Brush'} ${index + 1}`;
  }

  function seek(index: number) {
    if (index < 0 || index >= frameCount || index === current) return;

    // Detection results belong to the frame they were computed on.
    cancelDetection();
    detectionStore.clearResults();

    try {
      documentStore.goToFrame(index);
    } catch (e) {
      console.error('Failed to render frame:', e);
    }
  }

  function step(delta: number) {
    documentStore.pause();
    seek((current + delta + frameCount) % frameCount);
  }

  function togglePlay() {
    if (playing) {
      documentStore.pause();
    } else {
      cancelDetection();
      detectionStore.clearResults();
      documentStore.play();
    }
  }

  function handleScrub(e: Event) {
    documentStore.pause();
    seek(Number((e.currentTarget as HTMLInputElement).value));
  }

  function clampFrame(frame: number) {
    return Math.min(frameCount - 1, Math.max(0, Math.round(frame)));
  }

  function frameAt(e: PointerEvent, el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return current;
    return clampFrame(Math.floor(((e.clientX - rect.left) / rect.width) * frameCount));
  }

  /** The range to draw for a redaction, including an edit being dragged. */
  function shownRange(cmd: RedactionCommand) {
    return drag && drag.id === cmd.id && drag.mode !== 'seek' ? drag.range : rangeOf(cmd);
  }

  function setRangeFor(id: string, start: number, end: number) {
    start = clampFrame(start);
    end = clampFrame(end);
    if (start > end) [start, end] = [end, start];
    const everyFrame = start === 0 && end === frameCount - 1;
    historyStore.setFrames(id, everyFrame ? null : { start, end });
  }

  function setRange(start: number, end: number) {
    if (selected) setRangeFor(selected.id, start, end);
  }

  function beginDrag(e: PointerEvent, cmd: RedactionCommand | null) {
    if (e.button !== 0 || drag) return;
    const el = e.currentTarget as HTMLElement;
    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-drag]');
    const mode = (cmd && (handle?.dataset.drag as DragMode)) || 'seek';
    const frame = frameAt(e, el);
    const initial = cmd ? rangeOf(cmd) : { start: 0, end: frameCount - 1 };

    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    documentStore.pause();
    if (cmd) selectedRedactionId.set(cmd.id);
    if (cmd && handle) handle.focus();
    drag = {
      id: cmd?.id ?? null,
      mode,
      pointerId: e.pointerId,
      originFrame: frame,
      initial,
      range: initial,
      moved: false
    };
    if (mode === 'seek') seek(frame);
  }

  function moveDrag(e: PointerEvent) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const frame = frameAt(e, e.currentTarget as HTMLElement);
    const { initial } = drag;

    if (drag.mode === 'seek') {
      seek(frame);
    } else if (drag.mode === 'start') {
      drag.range = { start: Math.min(frame, initial.end), end: initial.end };
      seek(drag.range.start);
    } else if (drag.mode === 'end') {
      drag.range = { start: initial.start, end: Math.max(frame, initial.start) };
      seek(drag.range.end);
    } else {
      const delta = Math.max(
        -initial.start,
        Math.min(frameCount - 1 - initial.end, frame - drag.originFrame)
      );
      if (delta !== 0) drag.moved = true;
      drag.range = { start: initial.start + delta, end: initial.end + delta };
    }
  }

  function endDrag(e: PointerEvent, commit: boolean) {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const finished = drag;
    drag = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (!commit || !finished.id) return;

    if (finished.mode === 'move' && !finished.moved) {
      // A click on the bar: go to that frame.
      seek(finished.originFrame);
      return;
    }
    const { start, end } = finished.range;
    if (start !== finished.initial.start || end !== finished.initial.end) {
      setRangeFor(finished.id, start, end);
    }
  }

  /** Arrow keys etc. on a range handle move that edge by whole frames. */
  function handleHandleKey(e: KeyboardEvent, cmd: RedactionCommand, edge: 'start' | 'end') {
    const range = rangeOf(cmd);
    const value = edge === 'start' ? range.start : range.end;
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowDown: -1,
      ArrowRight: 1,
      ArrowUp: 1,
      PageDown: -10,
      PageUp: 10
    };
    let next: number;
    if (e.key in steps) next = value + steps[e.key];
    else if (e.key === 'Home') next = edge === 'start' ? 0 : range.start;
    else if (e.key === 'End') next = edge === 'end' ? frameCount - 1 : range.end;
    else return;

    e.preventDefault();
    e.stopPropagation();
    next = edge === 'start' ? Math.min(clampFrame(next), range.end) : Math.max(clampFrame(next), range.start);
    selectedRedactionId.set(cmd.id);
    documentStore.pause();
    seek(next);
    if (next !== value) {
      setRangeFor(cmd.id, edge === 'start' ? next : range.start, edge === 'end' ? next : range.end);
    }
  }

  /** Inputs show 1-based frame numbers. */
  function handleRangeInput(e: Event, edge: 'start' | 'end') {
    if (!selected) return;
    const value = Number((e.currentTarget as HTMLInputElement).value) - 1;
    if (!Number.isFinite(value)) return;
    const range = rangeOf(selected);
    if (edge === 'start') {
      setRange(value, Math.max(value, range.end));
    } else {
      setRange(Math.min(value, range.start), value);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === ',' || e.key === 'PageUp') {
      e.preventDefault();
      step(-1);
    } else if (e.key === '.' || e.key === 'PageDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      togglePlay();
    }
  }

  function percent(frames: number) {
    return `${(frames / frameCount) * 100}%`;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<section class="timeline" aria-label="Animation frames">
  <div class="transport">
    <button
      class="icon-only ghost"
      onclick={() => step(-1)}
      aria-label="Previous frame"
      data-tooltip="Previous frame (,)"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
    <button
      class="icon-only primary play"
      onclick={togglePlay}
      aria-label={playing ? 'Pause' : 'Play'}
      data-tooltip={playing ? 'Pause (K)' : 'Play (K)'}
    >
      {#if playing}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" /></svg>
      {/if}
    </button>
    <button
      class="icon-only ghost"
      onclick={() => step(1)}
      aria-label="Next frame"
      data-tooltip="Next frame (.)"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>

    <span class="frame-label" aria-live="polite">
      Frame {current + 1} of {frameCount}
    </span>

    <input
      class="scrubber"
      type="range"
      min="0"
      max={frameCount - 1}
      value={current}
      oninput={handleScrub}
      aria-label="Frame"
    />

    <div class="scope" role="group" aria-label="New redactions apply to">
      <span class="scope-label">New redactions</span>
      {#each scopes as scope}
        <button
          class="scope-btn"
          class:active={$settingsStore.frameScope === scope.id}
          aria-pressed={$settingsStore.frameScope === scope.id}
          onclick={() => settingsStore.setFrameScope(scope.id)}
        >
          {scope.label}
        </button>
      {/each}
    </div>
  </div>

  <div class="track strip-row">
    <span class="row-label">Frames</span>
    <!-- Pointer scrubbing; keyboard users have the frame slider above. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="strip"
      bind:clientWidth={stripWidth}
      onpointerdown={(e) => beginDrag(e, null)}
      onpointermove={moveDrag}
      onpointerup={(e) => endDrag(e, true)}
      onpointercancel={(e) => endDrag(e, false)}
      aria-hidden="true"
    >
      {#each slots as slot (slot.frame)}
        <span class="slot">
          {#if slot.thumbnail}
            <canvas
              use:paint={{
                thumbnail: slot.thumbnail,
                commands: $activeCommands,
                imageWidth: $imageStore.width
              }}
            ></canvas>
          {/if}
        </span>
      {/each}
      <span class="playhead" style:left={percent(current + 0.5)}></span>
    </div>
  </div>

  {#if $activeCommands.length === 0}
    <p class="empty">
      Redactions you draw appear here, one track each.
      {$settingsStore.frameScope === 'all'
        ? 'New ones cover every frame; drag a track\'s ends to the frames that need it.'
        : 'New ones cover only the frame on screen.'}
    </p>
  {:else}
    <div class="tracks">
      {#each $activeCommands as cmd, i (cmd.id)}
        {@const range = shownRange(cmd)}
        <div class="track" class:selected={cmd.id === $selectedRedactionId}>
          <button
            class="track-label ghost"
            onclick={() => selectedRedactionId.set(cmd.id === $selectedRedactionId ? null : cmd.id)}
            aria-pressed={cmd.id === $selectedRedactionId}
          >
            <span class="track-name">{label(cmd, i)}</span>
            <span class="track-style">{styleLabels[cmd.style]}</span>
          </button>
          <!-- Pointer editing; keyboard users have the handles and range fields. -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="lane"
            class:dragging={drag?.id === cmd.id}
            onpointerdown={(e) => beginDrag(e, cmd)}
            onpointermove={moveDrag}
            onpointerup={(e) => endDrag(e, true)}
            onpointercancel={(e) => endDrag(e, false)}
          >
            <span
              class="bar"
              data-drag="move"
              style:left={percent(range.start)}
              style:width={percent(range.end - range.start + 1)}
            ></span>
            <span
              class="handle"
              data-drag="start"
              role="slider"
              tabindex="0"
              aria-label={`${label(cmd, i)} first frame`}
              aria-valuemin={1}
              aria-valuemax={range.end + 1}
              aria-valuenow={range.start + 1}
              style:left={percent(range.start)}
              onkeydown={(e) => handleHandleKey(e, cmd, 'start')}
            ></span>
            <span
              class="handle"
              data-drag="end"
              role="slider"
              tabindex="0"
              aria-label={`${label(cmd, i)} last frame`}
              aria-valuemin={range.start + 1}
              aria-valuemax={frameCount}
              aria-valuenow={range.end + 1}
              style:left={percent(range.end + 1)}
              onkeydown={(e) => handleHandleKey(e, cmd, 'end')}
            ></span>
            <span class="playhead" style:left={percent(current + 0.5)}></span>
          </div>
        </div>
      {/each}
    </div>

    {#if selected}
      {@const range = rangeOf(selected)}
      <div class="range-editor">
        <span class="range-title">{label(selected, selectedIndex)} shows on frames</span>
        <label class="range-field">
          <span class="visually-hidden">First frame</span>
          <input
            type="number"
            min="1"
            max={frameCount}
            value={range.start + 1}
            onchange={(e) => handleRangeInput(e, 'start')}
          />
        </label>
        <span aria-hidden="true">–</span>
        <label class="range-field">
          <span class="visually-hidden">Last frame</span>
          <input
            type="number"
            min="1"
            max={frameCount}
            value={range.end + 1}
            onchange={(e) => handleRangeInput(e, 'end')}
          />
        </label>
        <div class="range-actions">
          <button onclick={() => setRange(current, Math.max(current, range.end))}>Start here</button>
          <button onclick={() => setRange(Math.min(current, range.start), current)}>End here</button>
          <button onclick={() => setRange(current, current)}>This frame only</button>
          <button onclick={() => setRange(0, frameCount - 1)}>All frames</button>
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3) var(--space-3);
    background: var(--bg-secondary);
    border-top: 1px solid var(--border);
  }

  .transport {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
  }

  .play {
    min-width: 36px;
  }

  .frame-label {
    font-size: 0.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    white-space: nowrap;
    min-width: 7.5em;
  }

  .scrubber {
    flex: 1 1 160px;
    min-width: 120px;
    accent-color: var(--accent);
  }

  .scope {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .scope-label {
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    margin-right: var(--space-1);
  }

  .scope-btn {
    padding: var(--space-1) var(--space-2);
    font-size: 0.75rem;
    background: var(--bg-tertiary);
  }

  .scope-btn.active {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }

  .empty {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .tracks {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 132px;
    overflow-y: auto;
  }

  .track {
    display: grid;
    grid-template-columns: 128px minmax(0, 1fr);
    gap: var(--space-2);
    align-items: center;
    border-radius: var(--radius-sm);
  }

  .track.selected {
    background: var(--accent-subtle);
  }

  .track-label {
    justify-content: space-between;
    padding: var(--space-1) var(--space-2);
    font-size: 0.75rem;
    min-width: 0;
  }

  .track-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .track-style {
    font-weight: 400;
    color: var(--text-muted);
  }

  .row-label {
    padding: 0 var(--space-2);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .strip {
    position: relative;
    display: flex;
    gap: 2px;
    height: 40px;
    border-radius: var(--radius-sm);
    overflow: hidden;
    cursor: pointer;
    touch-action: none;
    user-select: none;
  }

  .slot {
    flex: 1 1 0;
    min-width: 0;
    background: var(--bg-tertiary);
  }

  .slot canvas {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .lane {
    position: relative;
    height: 24px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    cursor: pointer;
    touch-action: none;
    user-select: none;
  }

  .bar {
    position: absolute;
    top: 4px;
    bottom: 4px;
    border-radius: 4px;
    background: var(--accent);
    opacity: 0.55;
    cursor: grab;
  }

  .lane.dragging .bar {
    cursor: grabbing;
  }

  .track.selected .bar {
    opacity: 1;
  }

  .handle {
    position: absolute;
    top: 1px;
    bottom: 1px;
    width: 12px;
    margin-left: -6px;
    z-index: 1;
    cursor: ew-resize;
    border-radius: 4px;
  }

  .handle::after {
    content: '';
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 4px;
    width: 4px;
    border-radius: 2px;
    background: var(--bg-secondary);
    border: 1px solid var(--accent);
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .track.selected .handle::after,
  .lane:hover .handle::after,
  .handle:focus-visible::after {
    opacity: 1;
  }

  .handle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: var(--danger);
    pointer-events: none;
  }

  .range-editor {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .range-title {
    font-weight: 600;
    color: var(--text-primary);
  }

  .range-field input {
    width: 4.5em;
    padding: var(--space-1) var(--space-2);
    font: inherit;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
    background: var(--bg-primary);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }

  .range-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .range-actions button {
    padding: var(--space-1) var(--space-2);
    font-size: 0.75rem;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (max-width: 767px) {
    .timeline {
      /* Sit above the fixed mobile bottom panel */
      margin-bottom: calc(var(--mobile-panel-height) + var(--safe-area-bottom));
    }

    .track {
      grid-template-columns: 96px minmax(0, 1fr);
    }

    .scope-label {
      display: none;
    }
  }
</style>
