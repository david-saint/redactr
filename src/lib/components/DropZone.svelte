<script lang="ts">
  import { documentStore } from '../stores/document';
  import { isHeicFile } from '../heic';
  import { isPdfFile, PdfPasswordError } from '../pdf';

  let isDragging = false;
  let fileInput: HTMLInputElement;
  let error: string | null = null;
  let loading = false;

  function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    isDragging = true;
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await loadFile(files[0]);
    }
  }

  async function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      await loadFile(input.files[0]);
    }
  }

  async function loadFile(file: File) {
    if (loading) return;
    error = null;

    const pdf = isPdfFile(file);
    if (!pdf && !file.type.startsWith('image/') && !isHeicFile(file)) {
      error = 'Please select an image or PDF file';
      return;
    }

    loading = true;
    try {
      await documentStore.open(file);
    } catch (e) {
      console.error(e);
      if (e instanceof PdfPasswordError) {
        error = e.message;
      } else {
        error = pdf ? 'Failed to open PDF' : 'Failed to load image';
      }
    } finally {
      loading = false;
      // Allow selecting the same file again after an error
      if (fileInput) fileInput.value = '';
    }
  }

  function handleClick() {
    if (loading) return;
    fileInput.click();
  }
</script>

<div class="dropzone-container">
  <div
    class="dropzone"
    class:dragging={isDragging}
    class:loading
    on:dragenter={handleDragEnter}
    on:dragleave={handleDragLeave}
    on:dragover={handleDragOver}
    on:drop={handleDrop}
    on:click={handleClick}
    role="button"
    tabindex="0"
    aria-busy={loading}
    on:keydown={(e) => e.key === 'Enter' && handleClick()}
  >
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*,.heic,.heif,application/pdf,.pdf"
      on:change={handleFileSelect}
      class="visually-hidden"
    />

    <div class="dropzone-content">
      <div class="icon-wrapper">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      </div>

      <div class="text-content">
        {#if loading}
          <h2>Opening file…</h2>
          <p>Everything stays on your device</p>
        {:else}
          <h2>Drop your image or PDF here</h2>
          <p>or click to browse files</p>
        {/if}
      </div>

      <div class="supported-formats">
        <span>PNG</span>
        <span>JPG</span>
        <span>WebP</span>
        <span>GIF</span>
        <span>HEIC</span>
        <span>PDF</span>
      </div>

      {#if error}
        <p class="error">{error}</p>
      {/if}
    </div>
  </div>

  <div class="features">
    <div class="feature">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      <div>
        <strong>Private</strong>
        <span>Files never leave your device</span>
      </div>
    </div>
    <div class="feature">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
      <div>
        <strong>Fast</strong>
        <span>Powered by WebAssembly</span>
      </div>
    </div>
    <div class="feature">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      <div>
        <strong>Offline</strong>
        <span>Works without internet</span>
      </div>
    </div>
  </div>
</div>

<style>
  .dropzone-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--space-8);
    gap: var(--space-8);
    animation: fadeIn 0.3s ease;
  }

  .dropzone {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    max-width: 480px;
    aspect-ratio: 4/3;
    padding: var(--space-8);
    border: 2px dashed var(--border-strong);
    border-radius: var(--radius-xl);
    cursor: pointer;
    transition: all 0.2s ease;
    background: var(--bg-secondary);
  }

  .dropzone:hover,
  .dropzone.dragging {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .dropzone.loading {
    cursor: progress;
    opacity: 0.7;
  }

  .dropzone:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .dropzone-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    text-align: center;
  }

  .icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 80px;
    height: 80px;
    background: var(--bg-tertiary);
    border-radius: var(--radius-lg);
    color: var(--text-muted);
    transition: all 0.2s ease;
  }

  .dropzone:hover .icon-wrapper,
  .dropzone.dragging .icon-wrapper {
    background: var(--accent);
    color: white;
    transform: scale(1.05);
  }

  .text-content h2 {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: var(--space-1);
  }

  .text-content p {
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .supported-formats {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
  }

  .supported-formats span {
    padding: var(--space-1) var(--space-2);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .error {
    color: var(--danger);
    font-size: 0.875rem;
    padding: var(--space-2) var(--space-3);
    background: var(--danger-subtle);
    border-radius: var(--radius-md);
  }

  .features {
    display: flex;
    gap: var(--space-6);
    flex-wrap: wrap;
    justify-content: center;
  }

  .feature {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    max-width: 180px;
  }

  .feature svg {
    flex-shrink: 0;
    color: var(--accent);
    margin-top: 2px;
  }

  .feature div {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .feature strong {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .feature span {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @media (max-width: 767px) {
    .dropzone-container {
      padding: var(--space-4);
      gap: var(--space-6);
    }

    .dropzone {
      max-width: 100%;
      aspect-ratio: 1/1;
      padding: var(--space-4);
    }

    .icon-wrapper {
      width: 64px;
      height: 64px;
    }

    .icon-wrapper svg {
      width: 32px;
      height: 32px;
    }

    .text-content h2 {
      font-size: 1.125rem;
    }

    .text-content p {
      font-size: 0.8125rem;
    }

    .features {
      flex-direction: column;
      gap: var(--space-3);
      align-items: stretch;
      width: 100%;
      max-width: 280px;
    }

    .feature {
      max-width: 100%;
    }
  }
</style>
