<script lang="ts">
  import { documentStore } from '../stores/document';
  import { detectionStore } from '../stores/detection';
  import { cancelDetection } from '../detection/manager';

  async function goToPage(index: number) {
    if (
      index < 0 ||
      index >= $documentStore.pageCount ||
      index === $documentStore.currentPage
    ) {
      return;
    }

    // Detection results belong to the page they were computed on.
    cancelDetection();
    detectionStore.clearResults();

    try {
      await documentStore.goToPage(index);
    } catch (e) {
      console.error('Failed to render page:', e);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable]')) return;

    if (e.key === 'PageDown') {
      e.preventDefault();
      goToPage($documentStore.currentPage + 1);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      goToPage($documentStore.currentPage - 1);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="page-nav" class:loading={$documentStore.isLoadingPage}>
  <button
    class="nav-btn icon-only ghost"
    onclick={() => goToPage($documentStore.currentPage - 1)}
    disabled={$documentStore.currentPage <= 0}
    aria-label="Previous page"
    data-tooltip="Previous page"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  </button>

  <span class="page-label" aria-live="polite">
    {#if $documentStore.isLoadingPage}
      <span class="spinner" aria-hidden="true"></span>
    {/if}
    Page {$documentStore.currentPage + 1} of {$documentStore.pageCount}
  </span>

  <button
    class="nav-btn icon-only ghost"
    onclick={() => goToPage($documentStore.currentPage + 1)}
    disabled={$documentStore.currentPage >= $documentStore.pageCount - 1}
    aria-label="Next page"
    data-tooltip="Next page"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  </button>
</div>

<style>
  .page-nav {
    position: absolute;
    left: 50%;
    bottom: var(--space-4);
    transform: translateX(-50%);
    z-index: 10;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1);
    background: var(--glass);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }

  .nav-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .page-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-2);
    font-size: 0.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 767px) {
    .page-nav {
      /* Sit above the fixed mobile bottom panel */
      bottom: calc(var(--mobile-panel-height) + var(--safe-area-bottom) + var(--space-3));
    }

    .nav-btn {
      width: var(--touch-target-min);
      height: var(--touch-target-min);
    }
  }
</style>
