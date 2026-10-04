<script lang="ts">
  import { onDestroy } from 'svelte';
  import { documentStore } from '../stores/document';
  import {
    historyStore,
    activeCommands,
    selectedRedactionId,
    type RedactionCommand
  } from '../stores/history';
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

  /** Select a redaction and jump to the frame under the pointer. */
  function handleLaneClick(e: MouseEvent, cmd: RedactionCommand) {
    selectedRedactionId.set(cmd.id);
    const lane = e.currentTarget as HTMLElement;
    const rect = lane.getBoundingClientRect();
    if (rect.width > 0 && e.detail > 0) {
      const ratio = (e.clientX - rect.left) / rect.width;
      documentStore.pause();
      seek(Math.min(frameCount - 1, Math.max(0, Math.floor(ratio * frameCount))));
    }
  }

  function setRange(start: number, end: number) {
    if (!selected) return;
    start = Math.min(frameCount - 1, Math.max(0, Math.round(start)));
    end = Math.min(frameCount - 1, Math.max(0, Math.round(end)));
    if (start > end) [start, end] = [end, start];
    const everyFrame = start === 0 && end === frameCount - 1;
    historyStore.setFrames(selected.id, everyFrame ? null : { start, end });
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

  {#if $activeCommands.length === 0}
    <p class="empty">
      Redactions you draw appear here, one track each.
      {$settingsStore.frameScope === 'all'
        ? 'New ones cover every frame; narrow a track to the frames that need it.'
        : 'New ones cover only the frame on screen.'}
    </p>
  {:else}
    <div class="tracks">
      {#each $activeCommands as cmd, i (cmd.id)}
        {@const range = rangeOf(cmd)}
        <div class="track" class:selected={cmd.id === $selectedRedactionId}>
          <button
            class="track-label ghost"
            onclick={() => selectedRedactionId.set(cmd.id === $selectedRedactionId ? null : cmd.id)}
            aria-pressed={cmd.id === $selectedRedactionId}
          >
            <span class="track-name">{label(cmd, i)}</span>
            <span class="track-style">{styleLabels[cmd.style]}</span>
          </button>
          <button
            class="lane"
            onclick={(e) => handleLaneClick(e, cmd)}
            aria-label={`${label(cmd, i)}: frames ${range.start + 1} to ${range.end + 1}. Select and go to frame.`}
          >
            <span
              class="bar"
              style:left={percent(range.start)}
              style:width={percent(range.end - range.start + 1)}
            ></span>
            <span class="playhead" style:left={percent(current + 0.5)}></span>
          </button>
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

  .lane {
    position: relative;
    display: block;
    height: 24px;
    padding: 0;
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    overflow: hidden;
  }

  .lane:hover:not(:disabled) {
    background: var(--bg-tertiary);
    border-color: var(--border-strong);
  }

  .lane:active:not(:disabled) {
    transform: none;
  }

  .bar {
    position: absolute;
    top: 4px;
    bottom: 4px;
    border-radius: 4px;
    background: var(--accent);
    opacity: 0.55;
  }

  .track.selected .bar {
    opacity: 1;
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
