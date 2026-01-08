<script lang="ts">
  import {
    detectionStore,
    detectionCounts,
    selectedDetections,
    needsModelDownload,
    estimatedDownloadSize,
    type DetectionType,
  } from "../stores/detection";
  import { imageStore } from "../stores/image";
  import { startDetection, cancelDetection } from "../detection/manager";
  import { fade } from "svelte/transition";

  const detectionTypes: DetectionType[] = [
    "face",
    "text",
    "license_plate",
    "document",
  ];

  const typeLabels: Record<DetectionType, string> = {
    face: "Faces",
    text: "Text",
    license_plate: "License Plates",
    document: "Documents",
  };

  const typeIcons: Record<DetectionType, string> = {
    face: "👤",
    text: "📝",
    license_plate: "🚗",
    document: "📄",
  };

  const typeDescriptions: Record<DetectionType, string> = {
    face: "Detects faces using MediaPipe for high privacy.",
    text: "Identifies and redacts text regions.",
    license_plate: "Detects vehicles to obscure potential license plates.",
    document: "Identifies screens, paper documents, and digital displays.",
  };

  // Consent state
  let showConsentDialog = false;

  // Tooltip state
  let hoveredType: DetectionType | null = null;
  let hoverTimeout: ReturnType<typeof setTimeout>;

  function handleRunDetection() {
    if ($needsModelDownload && !$detectionStore.hasUserConsent) {
      showConsentDialog = true;
    } else {
      startDetection();
    }
  }

  function handleConfirmDownload() {
    detectionStore.giveConsent();
    showConsentDialog = false;
    startDetection();
  }

  function handleCancelDownload() {
    showConsentDialog = false;
  }

  function handleApplyRedactions() {
    // This will be called from parent component
    // Dispatch event with selected detections
    const event = new CustomEvent("applyRedactions", {
      detail: $selectedDetections,
    });
    document.dispatchEvent(event);
  }

  function handleMouseEnter(type: DetectionType) {
    if (hoverTimeout) clearTimeout(hoverTimeout);
    hoverTimeout = setTimeout(() => {
      hoveredType = type;
    }, 500); // 500ms delay
  }

  function handleMouseLeave() {
    if (hoverTimeout) clearTimeout(hoverTimeout);
    hoveredType = null;
  }

  $: hasImage = $imageStore.current !== null;
  $: isWorking = $detectionStore.isDetecting || $detectionStore.isDownloading;
  $: hasResults = $detectionStore.results.length > 0;
  $: selectedCount = $selectedDetections.length;
</script>

{#if $detectionStore.isPanelOpen}
  <div class="detection-panel">
    <div class="panel-header">
      <h3>AI Detection</h3>
      <button
        class="icon-only ghost"
        on:click={() => {
          cancelDetection();
          detectionStore.clearResults();
          detectionStore.closePanel();
        }}
        aria-label="Close panel"
      >
        ✕
      </button>
    </div>

    <!-- Consent Dialog -->
    {#if showConsentDialog}
      <div class="consent-dialog">
        <div class="consent-icon">🤖</div>
        <h4>Download AI Models?</h4>
        <p>
          To detect privacy-sensitive content, we need to download AI models to
          your device.
        </p>
        <div class="download-info">
          <span class="size-badge">~{$estimatedDownloadSize}MB</span>
          <span class="info-text">One-time download, works offline after</span>
        </div>
        <div class="consent-actions">
          <button class="btn-secondary" on:click={handleCancelDownload}>
            Cancel
          </button>
          <button class="btn-primary" on:click={handleConfirmDownload}>
            Download & Detect
          </button>
        </div>
      </div>
    {:else}
      <!-- Detection Type Toggles -->
      <div class="type-toggles">
        <p class="section-label">Detection Types</p>
        <div class="toggle-grid">
          {#each detectionTypes as type}
            <div class="toggle-wrapper">
              <label
                class="type-toggle"
                class:checked={$detectionStore.enabledTypes.includes(type)}
                on:mouseenter={() => handleMouseEnter(type)}
                on:mouseleave={handleMouseLeave}
              >
                <input
                  type="checkbox"
                  checked={$detectionStore.enabledTypes.includes(type)}
                  on:change={() => detectionStore.toggleType(type)}
                  disabled={isWorking}
                />
                <span class="toggle-icon">{typeIcons[type]}</span>
                <span class="toggle-label">{typeLabels[type]}</span>
                {#if $detectionCounts[type] > 0}
                  <span class="count-badge">{$detectionCounts[type]}</span>
                {/if}
              </label>

              {#if hoveredType === type}
                <div class="tooltip" transition:fade={{ duration: 150 }}>
                  {typeDescriptions[type]}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>

      <!-- Progress Display -->
      {#if isWorking}
        <div class="progress-section">
          {#if $detectionStore.isDownloading}
            <div class="progress-header">
              <span class="progress-icon">⬇️</span>
              <span>Downloading Models</span>
            </div>
            <div class="progress-bar">
              <div
                class="progress-fill download"
                style="width: {$detectionStore.downloadProgress}%"
              ></div>
            </div>
            <p class="progress-stage">{$detectionStore.currentStage}</p>
          {:else}
            <div class="progress-header">
              <span class="progress-icon">🔍</span>
              <span>Detecting</span>
            </div>
            <div class="progress-bar">
              <div
                class="progress-fill"
                style="width: {$detectionStore.progress}%"
              ></div>
            </div>
            <p class="progress-stage">{$detectionStore.currentStage}</p>
          {/if}
          <button class="ghost danger" on:click={cancelDetection}>
            Cancel
          </button>
        </div>
      {:else}
        <!-- Run Detection Button -->
        <div class="action-section">
          {#if $needsModelDownload}
            <p class="download-notice">
              First run will download ~{$estimatedDownloadSize}MB of AI models
            </p>
          {/if}
          <button
            class="btn-primary btn-detect"
            on:click={handleRunDetection}
            disabled={!hasImage || $detectionStore.enabledTypes.length === 0}
          >
            {#if !hasImage}
              Load an image first
            {:else if $detectionStore.enabledTypes.length === 0}
              Select detection types
            {:else}
              Run Detection
            {/if}
          </button>
        </div>
      {/if}

      <!-- Error Display -->
      {#if $detectionStore.error}
        <div class="error-message">
          <span>⚠️</span>
          <span>{$detectionStore.error}</span>
          <button on:click={() => detectionStore.clearResults()}>Dismiss</button
          >
        </div>
      {/if}

      <!-- Results Section -->
      {#if hasResults}
        <div class="results-section">
          <div class="results-header">
            <p class="section-label">
              Found {$detectionCounts.total} item{$detectionCounts.total !== 1
                ? "s"
                : ""}
            </p>
            <div class="selection-actions">
              <button
                class="btn-text"
                on:click={() => detectionStore.selectAll()}
              >
                Select all
              </button>
              <button
                class="btn-text"
                on:click={() => detectionStore.deselectAll()}
              >
                Deselect
              </button>
            </div>
          </div>

          <!-- Results by type -->
          <div class="results-list">
            {#each detectionTypes as type}
              {#if $detectionCounts[type] > 0}
                <div class="result-group">
                  <button
                    class="result-group-header"
                    on:click={() => detectionStore.selectByType(type)}
                  >
                    <span>{typeIcons[type]} {typeLabels[type]}</span>
                    <span class="count">{$detectionCounts[type]}</span>
                  </button>
                </div>
              {/if}
            {/each}
          </div>

          <!-- Apply Redaction -->
          <button
            class="primary btn-apply"
            on:click={handleApplyRedactions}
            disabled={selectedCount === 0}
          >
            Redact {selectedCount} selected item{selectedCount !== 1 ? "s" : ""}
          </button>
        </div>
      {/if}
    {/if}

    <!-- Backend info -->
    {#if $detectionStore.backend}
      <div class="backend-info">
        Running on: <span class="backend-badge"
          >{$detectionStore.backend.toUpperCase()}</span
        >
      </div>
    {/if}
  </div>
{/if}

<style>
  .detection-panel {
    position: absolute;
    top: 0;
    right: 0;
    width: 320px;
    height: 100%;
    background: var(--bg-secondary);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    z-index: 50; /* Below mobile panel (100) but above canvas */
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .panel-header h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  /* Consent Dialog */
  .consent-dialog {
    padding: var(--space-6) var(--space-4);
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .consent-icon {
    font-size: 48px;
    margin-bottom: var(--space-3);
  }

  .consent-dialog h4 {
    margin: 0 0 var(--space-2) 0;
    font-size: 1.125rem;
    color: var(--text-primary);
  }

  .consent-dialog p {
    margin: 0 0 var(--space-4) 0;
    color: var(--text-secondary);
  }

  .download-info {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    margin-bottom: var(--space-4);
    padding: var(--space-3);
    background: var(--bg-tertiary);
    border-radius: var(--radius-lg);
    width: 100%;
  }

  .size-badge {
    background: var(--accent);
    color: white;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-md);
    font-weight: 600;
    font-size: 0.875rem;
  }

  .info-text {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .consent-actions {
    display: flex;
    gap: var(--space-3);
    width: 100%;
  }

  .consent-actions button {
    flex: 1;
  }

  /* Type toggles */
  .type-toggles {
    padding: var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .section-label {
    margin: 0 0 var(--space-3) 0;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    display: block;
  }

  .toggle-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2);
  }

  .toggle-wrapper {
    position: relative;
    width: 100%;
  }

  .type-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all 0.15s ease;
    user-select: none;
    width: 100%;
    box-sizing: border-box;
  }

  .type-toggle:hover {
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }

  .type-toggle.checked {
    background: var(--accent-subtle);
    border-color: var(--accent);
    color: var(--accent);
  }

  .type-toggle input {
    display: none;
  }

  .toggle-icon {
    font-size: 1.125rem;
  }

  .toggle-label {
    flex: 1;
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .count-badge {
    background: var(--accent);
    color: white;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0 6px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 9px;
  }

  /* Tooltip */
  .tooltip {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-primary);
    color: var(--text-primary);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: 0.75rem;
    font-weight: 500;
    box-shadow: var(--shadow-lg);
    border: 1px solid var(--border);
    white-space: nowrap;
    z-index: 100;
    pointer-events: none;
    text-align: center;
    width: max-content;
    max-width: 200px;
    white-space: normal;
  }

  .tooltip::after {
    content: "";
    position: absolute;
    top: 100%;
    left: 50%;
    margin-left: -4px;
    border-width: 4px;
    border-style: solid;
    border-color: var(--bg-primary) transparent transparent transparent;
  }

  /* Progress section */
  .progress-section {
    padding: var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .progress-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    font-weight: 500;
    color: var(--text-primary);
  }

  .progress-bar {
    height: 6px;
    background: var(--bg-tertiary);
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: var(--space-2);
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .progress-stage {
    margin: 0 0 var(--space-3) 0;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  /* Action section */
  .action-section {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .download-notice {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
    text-align: center;
  }

  /* Error message */
  .error-message {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--danger-subtle);
    border-radius: var(--radius-md);
    color: var(--danger);
    font-size: 0.875rem;
    margin: var(--space-4);
  }

  .error-message button {
    margin-left: auto;
    background: none;
    border: none;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0;
    height: auto;
    min-width: auto;
  }

  /* Results section */
  .results-section {
    padding: var(--space-4);
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .results-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-3);
  }

  .selection-actions {
    display: flex;
    gap: var(--space-2);
  }

  .btn-text {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.8125rem;
    cursor: pointer;
    padding: var(--space-1) var(--space-2);
    height: auto;
  }

  .btn-text:hover {
    text-decoration: underline;
    background: none;
  }

  .results-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  .result-group-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--text-primary);
    transition: all 0.15s ease;
  }

  .result-group-header:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
  }

  .result-group-header .count {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .btn-detect {
    width: 100%;
    justify-content: center;
    padding: var(--space-3);
  }

  .btn-apply {
    margin-top: auto;
    width: 100%;
    justify-content: center;
    padding: var(--space-3);
  }

  /* Backend info */
  .backend-info {
    padding: var(--space-2) var(--space-4);
    border-top: 1px solid var(--border);
    font-size: 0.75rem;
    color: var(--text-muted);
    text-align: center;
    background: var(--bg-secondary);
  }

  .backend-badge {
    background: var(--bg-tertiary);
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 600;
    color: var(--text-secondary);
    font-size: 0.6875rem;
  }

  /* Mobile styles */
  @media (max-width: 767px) {
    .detection-panel {
      position: fixed;
      top: auto;
      bottom: 0;
      left: 0;
      right: 0;
      width: 100%;
      height: auto;
      max-height: 80vh;
      border-left: none;
      border-top: 1px solid var(--border);
      border-radius: var(--radius-xl) var(--radius-xl) 0 0;
      box-shadow: var(--shadow-xl);
      animation: slideUp 0.3s ease;
    }

    .toggle-grid {
      grid-template-columns: 1fr;
    }

    .backend-info {
      padding-bottom: max(var(--space-2), var(--safe-area-bottom));
    }
  }

  @keyframes slideUp {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }
</style>
