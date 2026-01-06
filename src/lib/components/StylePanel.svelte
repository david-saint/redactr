<script lang="ts">
  import { settingsStore, type RedactionStyle } from '../stores/settings';
  import { imageStore } from '../stores/image';

  const styles: { id: RedactionStyle; label: string; icon: string }[] = [
    { id: 'solid', label: 'Solid', icon: 'M4 4h16v16H4z' },
    { id: 'pixelate', label: 'Pixel', icon: 'M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h6v6h-6zM9 9h6v6H9z' },
    { id: 'blur', label: 'Blur', icon: 'M12 3a9 9 0 1 0 9 9M12 3v9l6.36-3.64' }
  ];

  let exporting = false;

  async function handleExport(format: 'png' | 'jpeg') {
    const current = $imageStore.current;
    if (!current) return;

    exporting = true;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = current.width;
      canvas.height = current.height;
      const ctx = canvas.getContext('2d')!;
      ctx.putImageData(current, 0, 0);

      const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
      const quality = format === 'jpeg' ? 0.92 : undefined;

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Failed to create blob'))),
          mimeType,
          quality
        );
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const baseName = $imageStore.name.replace(/\.[^.]+$/, '');
      a.href = url;
      a.download = `${baseName}-redacted.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      exporting = false;
    }
  }

  async function handleCopyToClipboard() {
    const current = $imageStore.current;
    if (!current) return;

    const canvas = document.createElement('canvas');
    canvas.width = current.width;
    canvas.height = current.height;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(current, 0, 0);

    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Failed to create blob'))),
          'image/png'
        );
      });
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);
    } catch (e) {
      console.error('Failed to copy to clipboard:', e);
    }
  }
</script>

<aside class="panel">
  <div class="panel-section">
    <span class="section-label">Redaction Style</span>
    <div class="style-grid">
      {#each styles as style}
        <button
          class="style-button"
          class:active={$settingsStore.style === style.id}
          on:click={() => settingsStore.setStyle(style.id)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d={style.icon} />
          </svg>
          <span>{style.label}</span>
        </button>
      {/each}
    </div>
  </div>

  {#if $settingsStore.style === 'solid'}
    <div class="panel-section">
      <span class="section-label">Fill Color</span>
      <div class="color-control">
        <input
          type="color"
          value={$settingsStore.fillColor}
          on:input={(e) => settingsStore.setFillColor(e.currentTarget.value)}
        />
        <div class="color-presets">
          <button
            class="color-preset"
            style="background: #000000"
            on:click={() => settingsStore.setFillColor('#000000')}
            aria-label="Black"
          ></button>
          <button
            class="color-preset"
            style="background: #ffffff"
            on:click={() => settingsStore.setFillColor('#ffffff')}
            aria-label="White"
          ></button>
          <button
            class="color-preset"
            style="background: #ef4444"
            on:click={() => settingsStore.setFillColor('#ef4444')}
            aria-label="Red"
          ></button>
        </div>
      </div>
    </div>
  {:else}
    <div class="panel-section">
      <span class="section-label">Intensity</span>
      <div class="intensity-control">
        <input
          type="range"
          min="1"
          max="100"
          value={$settingsStore.intensity}
          on:input={(e) => settingsStore.setIntensity(parseInt(e.currentTarget.value))}
        />
        <div class="intensity-labels">
          <span>Light</span>
          <span class="intensity-value">{$settingsStore.intensity}%</span>
          <span>Heavy</span>
        </div>
      </div>
    </div>
  {/if}

  <div class="panel-section export-section">
    <span class="section-label">Export</span>
    <div class="export-options">
      <button on:click={() => handleExport('png')} disabled={exporting} class="export-button">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        PNG
      </button>
      <button on:click={() => handleExport('jpeg')} disabled={exporting} class="export-button">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        JPEG
      </button>
    </div>
    <button on:click={handleCopyToClipboard} class="copy-button ghost">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      Copy to clipboard
    </button>
  </div>
</aside>

<style>
  .panel {
    width: 220px;
    padding: var(--space-4);
    background: var(--bg-secondary);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    overflow-y: auto;
  }

  .panel-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .section-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .style-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-2);
  }

  .style-button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-2);
    background: var(--bg-tertiary);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    transition: all 0.15s ease;
  }

  .style-button span {
    font-size: 0.6875rem;
    font-weight: 500;
  }

  .style-button:hover {
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .style-button.active {
    background: var(--accent-subtle);
    border-color: var(--accent);
    color: var(--accent);
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
    width: 24px;
    height: 24px;
    padding: 0;
    border-radius: var(--radius-sm);
    border: 2px solid var(--border);
    cursor: pointer;
    transition: transform 0.15s ease;
  }

  .color-preset:hover {
    transform: scale(1.1);
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

  .export-section {
    margin-top: auto;
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }

  .export-options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2);
  }

  .export-button {
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3);
  }

  .copy-button {
    width: 100%;
    margin-top: var(--space-2);
    justify-content: center;
  }

  @media (max-width: 767px) {
    .panel {
      display: none;
    }
  }
</style>
