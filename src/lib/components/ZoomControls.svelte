<script lang="ts">
  import { zoomStore, zoomPercent, MIN_ZOOM, MAX_ZOOM } from '../stores/zoom';
</script>

<div class="zoom-controls">
  <button
    class="zoom-btn icon-only ghost"
    on:click={() => zoomStore.zoomOut()}
    disabled={$zoomStore.zoom <= MIN_ZOOM}
    aria-label="Zoom out"
    data-tooltip="Zoom out"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      <line x1="8" y1="11" x2="14" y2="11"/>
    </svg>
  </button>

  <button
    class="zoom-level ghost"
    on:click={() => zoomStore.reset()}
    aria-label="Reset zoom"
    data-tooltip="Reset to fit"
  >
    {$zoomPercent}%
  </button>

  <button
    class="zoom-btn icon-only ghost"
    on:click={() => zoomStore.zoomIn()}
    disabled={$zoomStore.zoom >= MAX_ZOOM}
    aria-label="Zoom in"
    data-tooltip="Zoom in"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      <line x1="11" y1="8" x2="11" y2="14"/>
      <line x1="8" y1="11" x2="14" y2="11"/>
    </svg>
  </button>
</div>

<style>
  .zoom-controls {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1);
    background: var(--bg-tertiary);
    border-radius: var(--radius-lg);
  }

  .zoom-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .zoom-level {
    min-width: 52px;
    height: 32px;
    font-size: 0.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    padding: 0 var(--space-2);
  }

  .zoom-level:hover {
    color: var(--text-primary);
  }

  @media (max-width: 767px) {
    .zoom-controls {
      display: none; /* Hide on mobile - use pinch-to-zoom */
    }
  }
</style>
