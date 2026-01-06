<script lang="ts">
  import { settingsStore, type Tool } from '../stores/settings';

  const tools: { id: Tool; label: string; icon: string }[] = [
    {
      id: 'rect',
      label: 'Rectangle',
      icon: 'M3 3h18v18H3V3z'
    },
    {
      id: 'brush',
      label: 'Brush',
      icon: 'M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08M9.06 11.9l-1.77 5.32 5.32-1.77M9.06 11.9l3.55 3.55'
    }
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
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d={tool.icon} />
          </svg>
        </button>
      {/each}
    </div>
  </div>

  {#if $settingsStore.tool === 'brush'}
    <div class="tool-section">
      <span class="section-label">Brush Size</span>
      <div class="slider-control">
        <input
          type="range"
          min="5"
          max="100"
          value={$settingsStore.brushSize}
          on:input={(e) => settingsStore.setBrushSize(parseInt(e.currentTarget.value))}
        />
        <span class="slider-value">{$settingsStore.brushSize}</span>
      </div>
    </div>
  {/if}
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
</style>
