<script lang="ts">
  import { settingsStore, type Tool } from "../stores/settings";
  import { detectionStore, detectionCounts } from "../stores/detection";
  import { imageStore } from "../stores/image";

  const tools: { id: Tool; label: string; icon: string }[] = [
    {
      id: "hand",
      label: "Hand (H)",
      icon: "M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v6M10 10V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.7-2.4L3.1 15a1.4 1.4 0 0 1 .6-2.3 1.4 1.4 0 0 1 1.1.3L6 14",
    },
    {
      id: "rect",
      label: "Rectangle (V)",
      icon: "M3 3h18v18H3V3z",
    },
    {
      id: "brush",
      label: "Brush (V)",
      icon: "M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08M9.06 11.9l-1.77 5.32 5.32-1.77M9.06 11.9l3.55 3.55",
    },
  ];
</script>

<aside class="toolbar">
  <div class="tool-section">
    <span class="section-label">Tools</span>
    <div class="tool-group">
      {#each tools as tool}
        <button
          class="tool-button"
          class:active={$settingsStore.tool === tool.id}
          on:click={() => settingsStore.setTool(tool.id)}
          data-tooltip={tool.label}
          aria-label={tool.label}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d={tool.icon} />
          </svg>
        </button>
      {/each}
    </div>
  </div>

  {#if $settingsStore.tool === "brush"}
    <div class="tool-section">
      <span class="section-label">Brush Size</span>
      <div class="slider-control">
        <input
          type="range"
          min="5"
          max="100"
          value={$settingsStore.brushSize}
          on:input={(e) =>
            settingsStore.setBrushSize(parseInt(e.currentTarget.value))}
        />
        <span class="slider-value">{$settingsStore.brushSize}</span>
      </div>
    </div>
  {/if}

  <!-- Auto-detect AI -->
  <div class="tool-section auto-detect-section">
    <span class="section-label">AI Detect</span>
    <div class="tool-group">
      <button
        class="tool-button detect-button"
        class:active={$detectionStore.isPanelOpen}
        on:click={() => detectionStore.togglePanel()}
        data-tooltip="Auto-detect sensitive content"
        aria-label="Auto-detect"
        disabled={!$imageStore.current}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"
          />
          <path d="m5 3 1 1" />
          <path d="m19 21 1 1" />
          <path d="m5 21 1-1" />
          <path d="m19 3 1-1" />
        </svg>
        {#if $detectionCounts.total > 0}
          <span class="detection-badge">{$detectionCounts.total}</span>
        {/if}
      </button>
    </div>
  </div>
</aside>

<style>
  .toolbar {
    width: 72px;
    padding: var(--space-3);
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .tool-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .section-label {
    font-size: 0.625rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    text-align: center;
  }

  .tool-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-1);
    background: var(--bg-tertiary);
    border-radius: var(--radius-lg);
  }

  .tool-button {
    width: 48px;
    height: 48px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    background: transparent;
    border: none;
    color: var(--text-secondary);
    transition: all 0.15s ease;
  }

  .tool-button:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .tool-button.active {
    background: var(--accent);
    color: white;
    box-shadow: var(--shadow-sm);
  }

  .slider-control {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    background: var(--bg-tertiary);
    border-radius: var(--radius-lg);
  }

  .slider-control input[type="range"] {
    writing-mode: vertical-lr;
    direction: rtl;
    height: 80px;
    width: 4px;
  }

  .slider-value {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .auto-detect-section {
    margin-top: auto;
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }

  .detect-button {
    position: relative;
  }

  .detect-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .detection-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    background: var(--accent);
    color: white;
    font-size: 10px;
    font-weight: 600;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  @media (max-width: 767px) {
    .toolbar {
      display: none;
    }
  }
</style>
