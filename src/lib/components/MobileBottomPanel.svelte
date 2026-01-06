<script lang="ts">
  import { settingsStore, type Tool, type RedactionStyle } from '../stores/settings';
  import { imageStore } from '../stores/image';
  import { historyStore, canUndo, canRedo } from '../stores/history';

  let styleExpanded = $state(false);
  let exporting = $state(false);

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

  const styles: { id: RedactionStyle; label: string; icon: string }[] = [
    { id: 'solid', label: 'Solid', icon: 'M4 4h16v16H4z' },
    { id: 'pixelate', label: 'Pixel', icon: 'M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h6v6h-6zM9 9h6v6H9z' },
    { id: 'blur', label: 'Blur', icon: 'M12 3a9 9 0 1 0 9 9M12 3v9l6.36-3.64' }
  ];

  function getStyleLabel(style: RedactionStyle): string {
    return styles.find(s => s.id === style)?.label ?? style;
  }

  async function handleExport() {
    const current = $imageStore.current;
    if (!current) return;

    exporting = true;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = current.width;
      canvas.height = current.height;
      const ctx = canvas.getContext('2d')!;
      ctx.putImageData(current, 0, 0);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Failed to create blob'))),
          'image/png'
        );
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const baseName = $imageStore.name.replace(/\.[^.]+$/, '');
      a.href = url;
      a.download = `${baseName}-redacted.png`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      exporting = false;
    }
  }

  function handleUndo() {
    historyStore.undo();
  }

  function handleRedo() {
    historyStore.redo();
  }
</script>

<div class="mobile-panel">
  {#if styleExpanded}
    <div class="style-drawer">
      <div class="drawer-header">
        <span class="drawer-title">Redaction Style</span>
        <button class="close-btn" onclick={() => styleExpanded = false} aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="style-options">
        {#each styles as style}
          <button
            class="style-btn"
            class:active={$settingsStore.style === style.id}
            onclick={() => settingsStore.setStyle(style.id)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d={style.icon} />
            </svg>
            <span>{style.label}</span>
          </button>
        {/each}
      </div>

      {#if $settingsStore.style === 'solid'}
        <div class="drawer-section">
          <span class="section-label">Fill Color</span>
          <div class="color-control">
            <input
              type="color"
              value={$settingsStore.fillColor}
              oninput={(e) => settingsStore.setFillColor(e.currentTarget.value)}
            />
            <div class="color-presets">
              <button
                class="color-preset"
                style="background: #000000"
                onclick={() => settingsStore.setFillColor('#000000')}
                aria-label="Black"
              ></button>
              <button
                class="color-preset"
                style="background: #ffffff"
                onclick={() => settingsStore.setFillColor('#ffffff')}
                aria-label="White"
              ></button>
              <button
                class="color-preset"
                style="background: #ef4444"
                onclick={() => settingsStore.setFillColor('#ef4444')}
                aria-label="Red"
              ></button>
            </div>
          </div>
        </div>
      {:else}
        <div class="drawer-section">
          <span class="section-label">Intensity</span>
          <div class="intensity-control">
            <input
              type="range"
              min="1"
              max="100"
              value={$settingsStore.intensity}
              oninput={(e) => settingsStore.setIntensity(parseInt(e.currentTarget.value))}
            />
            <div class="intensity-labels">
              <span>Light</span>
              <span class="intensity-value">{$settingsStore.intensity}%</span>
              <span>Heavy</span>
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if $settingsStore.tool === 'brush'}
    <div class="brush-size-bar">
      <span class="brush-label">Size</span>
      <input
        type="range"
        min="5"
        max="100"
        value={$settingsStore.brushSize}
        oninput={(e) => settingsStore.setBrushSize(parseInt(e.currentTarget.value))}
      />
      <span class="brush-value">{$settingsStore.brushSize}</span>
    </div>
  {/if}

  <div class="primary-bar">
    <div class="tool-group">
      {#each tools as tool}
        <button
          class="tool-btn"
          class:active={$settingsStore.tool === tool.id}
          onclick={() => settingsStore.setTool(tool.id)}
          aria-label={tool.label}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d={tool.icon} />
          </svg>
        </button>
      {/each}
    </div>

    <button class="style-toggle" onclick={() => styleExpanded = !styleExpanded}>
      <span>{getStyleLabel($settingsStore.style)}</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class:rotated={styleExpanded}>
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>

    <div class="history-group">
      <button
        class="history-btn"
        onclick={handleUndo}
        disabled={!$canUndo}
        aria-label="Undo"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7v6h6" />
          <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.36 2.64L3 13" />
        </svg>
      </button>
      <button
        class="history-btn"
        onclick={handleRedo}
        disabled={!$canRedo}
        aria-label="Redo"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 7v6h-6" />
          <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6.36 2.64L21 13" />
        </svg>
      </button>
    </div>

    <button class="export-btn" onclick={handleExport} disabled={exporting} aria-label="Export">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    </button>
  </div>
</div>

<style>
  .mobile-panel {
    display: none;
    flex-direction: column;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 100;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border);
    padding-bottom: var(--safe-area-bottom);
  }

  @media (max-width: 767px) {
    .mobile-panel {
      display: flex;
    }
  }

  .primary-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-3);
    min-height: var(--mobile-panel-height);
    gap: var(--space-2);
  }

  .tool-group {
    display: flex;
    gap: var(--space-1);
    padding: var(--space-1);
    background: var(--bg-tertiary);
    border-radius: var(--radius-lg);
  }

  .tool-btn {
    min-width: var(--touch-target-min);
    min-height: var(--touch-target-min);
    padding: var(--space-2);
    border-radius: var(--radius-md);
    background: transparent;
    border: none;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .tool-btn:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .tool-btn.active {
    background: var(--accent);
    color: white;
    box-shadow: var(--shadow-sm);
  }

  .style-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    min-height: var(--touch-target-min);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-weight: 500;
  }

  .style-toggle svg {
    transition: transform 0.2s ease;
  }

  .style-toggle svg.rotated {
    transform: rotate(180deg);
  }

  .history-group {
    display: flex;
    gap: var(--space-1);
    padding: var(--space-1);
    background: var(--bg-tertiary);
    border-radius: var(--radius-lg);
  }

  .history-btn {
    min-width: 40px;
    min-height: 40px;
    padding: var(--space-2);
    border-radius: var(--radius-md);
    background: transparent;
    border: none;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .history-btn:hover:not(:disabled) {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .history-btn:disabled {
    opacity: 0.3;
  }

  .export-btn {
    min-width: var(--touch-target-min);
    min-height: var(--touch-target-min);
    padding: var(--space-2);
    border-radius: var(--radius-md);
    background: var(--accent);
    border: none;
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .export-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .export-btn:disabled {
    opacity: 0.5;
  }

  /* Style Drawer */
  .style-drawer {
    padding: var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    animation: slideUp 0.2s ease;
  }

  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-3);
  }

  .drawer-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    min-width: 36px;
    min-height: 36px;
    padding: var(--space-2);
    border-radius: var(--radius-md);
    background: transparent;
    border: none;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .close-btn:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .style-options {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  .style-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    min-height: var(--touch-target-min);
  }

  .style-btn span {
    font-size: 0.75rem;
    font-weight: 500;
  }

  .style-btn:hover {
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .style-btn.active {
    background: var(--accent-subtle);
    border-color: var(--accent);
    color: var(--accent);
  }

  .drawer-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .section-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .color-control {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .color-presets {
    display: flex;
    gap: var(--space-2);
  }

  .color-preset {
    width: 36px;
    height: 36px;
    padding: 0;
    border-radius: var(--radius-md);
    border: 2px solid var(--border);
    cursor: pointer;
  }

  .intensity-control {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .intensity-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .intensity-value {
    font-weight: 600;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  /* Brush Size Bar */
  .brush-size-bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border);
  }

  .brush-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
    min-width: 32px;
  }

  .brush-size-bar input[type="range"] {
    flex: 1;
  }

  .brush-value {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    min-width: 28px;
    text-align: right;
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
