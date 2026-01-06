<script lang="ts">
  import { onMount } from "svelte";
  import { theme } from "./lib/stores/theme";
  import { imageStore, hasImage } from "./lib/stores/image";
  import { historyStore, canUndo, canRedo } from "./lib/stores/history";
  import Canvas from "./lib/components/Canvas.svelte";
  import Toolbar from "./lib/components/Toolbar.svelte";
  import StylePanel from "./lib/components/StylePanel.svelte";
  import DropZone from "./lib/components/DropZone.svelte";
  import ThemeToggle from "./lib/components/ThemeToggle.svelte";

  let wasmReady = false;
  let wasmError: string | null = null;

  // PWA Install
  let deferredPrompt: any = null;
  let canInstall = false;

  onMount(async () => {
    theme.init();

    // Listen for PWA install prompt
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      canInstall = true;
    });

    window.addEventListener("appinstalled", () => {
      canInstall = false;
      deferredPrompt = null;
    });

    try {
      const { initWasm } = await import("./lib/wasm/redactor");
      await initWasm();
      wasmReady = true;
    } catch (e) {
      wasmError = "Failed to load image processing module";
      console.error(e);
    }
  });

  async function handleInstall() {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === "accepted") {
      canInstall = false;
    }
    deferredPrompt = null;
  }

  function handleUndo() {
    historyStore.undo();
  }

  function handleRedo() {
    historyStore.redo();
  }

  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "z") {
      e.preventDefault();
      if (e.shiftKey) {
        handleRedo();
      } else {
        handleUndo();
      }
    }
  }

  function handleClear() {
    imageStore.clear();
    historyStore.clear();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="app">
  <header class="header">
    <div class="header-left">
      <div class="logo">
        <svg class="logo-icon" width="24" height="24" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <rect width="64" height="64" rx="12" fill="#FBF9F2" />
          <rect x="16" y="14" width="32" height="36" rx="4" stroke="currentColor" stroke-width="4" fill="none" />
          <path d="M12 28 H52 V36 H12 Z" fill="currentColor" />
          <path d="M14 26 H18 V28 H14 Z" fill="currentColor" />
          <path d="M46 26 H50 V28 H46 Z" fill="currentColor" />
          <path d="M18 36 H22 V38 H18 Z" fill="currentColor" />
          <path d="M42 36 H46 V38 H42 Z" fill="currentColor" />
          <path d="M28 26 H36 V28 H28 Z" fill="currentColor" />
        </svg>
        <span class="logo-text">Redactr</span>
      </div>
      {#if $hasImage}
        <div class="header-divider"></div>
        <span class="file-name">{$imageStore.name}</span>
      {/if}
    </div>

    <div class="header-center">
      {#if $hasImage}
        <div class="history-controls">
          <button
            on:click={handleUndo}
            disabled={!$canUndo}
            class="icon-only ghost"
            data-tooltip="Undo"
            aria-label="Undo"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M3 7v6h6" />
              <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.36 2.64L3 13" />
            </svg>
          </button>
          <button
            on:click={handleRedo}
            disabled={!$canRedo}
            class="icon-only ghost"
            data-tooltip="Redo"
            aria-label="Redo"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 7v6h-6" />
              <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6.36 2.64L21 13" />
            </svg>
          </button>
        </div>
      {/if}
    </div>

    <div class="header-right">
      {#if $hasImage}
        <button on:click={handleClear} class="danger sm">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
          Close
        </button>
      {/if}
      {#if canInstall}
        <button on:click={handleInstall} class="primary sm">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Install
        </button>
      {/if}
      <ThemeToggle />
    </div>
  </header>

  <main class="main">
    {#if wasmError}
      <div class="status-screen">
        <div class="status-content error">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <h2>Unable to Load</h2>
          <p>{wasmError}</p>
          <button on:click={() => window.location.reload()} class="primary">
            Refresh Page
          </button>
        </div>
      </div>
    {:else if !wasmReady}
      <div class="status-screen">
        <div class="status-content">
          <div class="loader"></div>
          <p>Loading image processor...</p>
        </div>
      </div>
    {:else if !$hasImage}
      <DropZone />
    {:else}
      <div class="editor">
        <Toolbar />
        <Canvas />
        <StylePanel />
      </div>
    {/if}
  </main>

  <footer class="footer">
    <span class="privacy-badge">
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      100% local processing
    </span>
  </footer>
</div>

<style>
  .app {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    min-height: 56px;
  }

  .header-left,
  .header-center,
  .header-right {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .header-left {
    flex: 1;
  }

  .header-center {
    flex: 0 0 auto;
  }

  .header-right {
    flex: 1;
    justify-content: flex-end;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .logo-icon {
    color: var(--accent);
  }

  .logo-text {
    font-size: 1.125rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    background: linear-gradient(
      135deg,
      var(--accent) 0%,
      var(--accent-hover) 100%
    );
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .header-divider {
    width: 1px;
    height: 20px;
    background: var(--border);
  }

  .file-name {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .history-controls {
    display: flex;
    gap: var(--space-1);
    padding: var(--space-1);
    background: var(--bg-tertiary);
    border-radius: var(--radius-lg);
  }

  .main {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .editor {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .status-screen {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-8);
  }

  .status-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    text-align: center;
    animation: slideUp 0.4s ease;
  }

  .status-content h2 {
    font-size: 1.25rem;
    color: var(--text-primary);
  }

  .status-content p {
    color: var(--text-secondary);
    max-width: 300px;
  }

  .status-content.error svg {
    color: var(--danger);
  }

  .loader {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .footer {
    padding: var(--space-2) var(--space-4);
    background: var(--bg-secondary);
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: center;
  }

  .privacy-badge {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .privacy-badge svg {
    color: var(--success);
  }
</style>
