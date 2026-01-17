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
  import { sotaStore, hasApiKey, canStartLoop, loopProgress } from "../stores/sota";
  import { startRalphLisaLoop, cancelRalphLisaLoop } from "../detection/sota";

  // Detection mode: null = not selected yet, "edge" = on-device, "sota" = cloud-based
  type DetectionMode = "edge" | "sota" | null;
  let selectedMode: DetectionMode = null;

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

  // Toast state
  let showPrivacyToast = false;
  let toastTimeout: ReturnType<typeof setTimeout>;

  // Tooltip state
  let hoveredType: DetectionType | null = null;
  let hoverTimeout: ReturnType<typeof setTimeout>;

  function showToast() {
    showPrivacyToast = true;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      showPrivacyToast = false;
    }, 6000);
  }

  function dismissToast() {
    if (toastTimeout) clearTimeout(toastTimeout);
    showPrivacyToast = false;
  }

  function handleModeSelect(mode: DetectionMode) {
    if (mode === "sota") {
      showToast();
    }
    selectedMode = mode;
  }

  function handleBackToModeSelection() {
    selectedMode = null;
    dismissToast();
  }

  function handleClosePanel() {
    cancelDetection();
    detectionStore.clearResults();
    detectionStore.closePanel();
    selectedMode = null;
    dismissToast();
  }

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

  // SOTA-specific state
  let apiKeyInput = "";
  let showIterationHistory = false;

  const maxStepsOptions = [3, 5, 7, 10];

  function handleConnectApiKey() {
    if (apiKeyInput.trim()) {
      sotaStore.setApiKey(apiKeyInput.trim());
      apiKeyInput = "";
    }
  }

  function handleDisconnectApi() {
    sotaStore.clearApiKey();
  }

  function handleStartSOTA() {
    startRalphLisaLoop();
  }

  function handleCancelSOTA() {
    cancelRalphLisaLoop();
  }

  function handleRunAgain() {
    sotaStore.reset();
  }

  function formatScore(score: number | null): string {
    if (score === null) return "—";
    return `${Math.round(score * 100)}%`;
  }

  function getStatusText(status: string): string {
    switch (status) {
      case "evaluating": return "Analyzing image...";
      case "planning": return "Planning redactions...";
      case "redacting": return "Applying redactions...";
      case "completed": return "Target reached!";
      case "max_steps": return "Max iterations reached";
      case "cancelled": return "Cancelled";
      case "error": return "Error occurred";
      default: return "Idle";
    }
  }

  $: sotaHasResults = $sotaStore.iterations.length > 0 && !$sotaStore.isRunning;
  $: sotaIsSuccess = $sotaStore.status === "completed";
</script>

{#if $detectionStore.isPanelOpen}
  <div class="detection-panel">
    <div class="panel-header">
      <h3>AI Detection</h3>
      <button
        class="icon-only ghost"
        on:click={handleClosePanel}
        aria-label="Close panel"
      >
        ✕
      </button>
    </div>

    <!-- Mode Selection -->
    {#if selectedMode === null}
      <div class="mode-selection">
        <p class="section-label">Choose Detection Mode</p>
        <div class="mode-options">
          <button
            class="mode-option"
            on:click={() => handleModeSelect("edge")}
          >
            <div class="mode-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
                <path d="M12 18h.01"/>
              </svg>
            </div>
            <span class="mode-name">EDGE</span>
            <span class="mode-description">On-device processing. Private & offline.</span>
            <span class="mode-badge private">Private</span>
          </button>
          <button
            class="mode-option"
            on:click={() => handleModeSelect("sota")}
          >
            <div class="mode-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
              </svg>
            </div>
            <span class="mode-name">SOTA</span>
            <span class="mode-description">Cloud-based. State-of-the-art accuracy.</span>
            <span class="mode-badge cloud">Cloud</span>
          </button>
        </div>
      </div>
    {:else if selectedMode === "sota"}
      <!-- SOTA Mode Content -->
      <div class="sota-content">
        <button class="back-button" on:click={handleBackToModeSelection}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m15 18-6-6 6-6"/>
          </svg>
          Back
        </button>

        {#if !$hasApiKey}
          <!-- State A: No API Key -->
          <div class="sota-section">
            <div class="sota-icon-header">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>
              </svg>
            </div>
            <h4>Connect OpenRouter</h4>
            <p class="sota-description">
              Enter your API key to enable AI-powered privacy detection.
            </p>
            <div class="api-key-form">
              <input
                type="password"
                bind:value={apiKeyInput}
                placeholder="sk-or-..."
                class="api-key-input"
                on:keydown={(e) => e.key === "Enter" && handleConnectApiKey()}
              />
              <button
                class="btn-primary"
                on:click={handleConnectApiKey}
                disabled={!apiKeyInput.trim()}
              >
                Connect
              </button>
            </div>
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noopener noreferrer"
              class="api-link"
            >
              Get an API key
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </a>
          </div>

        {:else if $sotaStore.isRunning}
          <!-- State C: Running -->
          <div class="sota-section">
            <div class="sota-progress">
              <div class="step-indicator">
                Step {$loopProgress.step} of {$loopProgress.maxSteps}
              </div>
              <div class="score-display">
                <span class="current-score">{formatScore($loopProgress.score)}</span>
                <span class="score-separator">/</span>
                <span class="target-score">{formatScore($loopProgress.targetScore)}</span>
              </div>
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  style="width: {($loopProgress.score ?? 0) / $loopProgress.targetScore * 100}%"
                ></div>
              </div>
              <p class="status-text">{getStatusText($loopProgress.status)}</p>
              <div class="spinner"></div>
            </div>
            <button class="btn-secondary btn-cancel" on:click={handleCancelSOTA}>
              Cancel
            </button>
          </div>

        {:else if sotaHasResults}
          <!-- State D: Results -->
          <div class="sota-section">
            <div class="results-summary" class:success={sotaIsSuccess}>
              <div class="result-icon">
                {#if sotaIsSuccess}
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                {:else}
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                {/if}
              </div>
              <h4>{sotaIsSuccess ? "Privacy Target Reached" : "Partial Redaction"}</h4>
              <div class="final-score">
                Final Score: <strong>{formatScore($sotaStore.currentScore)}</strong>
              </div>
              <p class="iterations-count">
                Completed {$sotaStore.iterations.length} iteration{$sotaStore.iterations.length !== 1 ? "s" : ""}
              </p>
            </div>

            <!-- Iteration History -->
            <button
              class="history-toggle"
              on:click={() => showIterationHistory = !showIterationHistory}
            >
              <span>{showIterationHistory ? "Hide" : "Show"} iteration history</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class:rotated={showIterationHistory}
              >
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>

            {#if showIterationHistory}
              <div class="iteration-history" transition:fade={{ duration: 150 }}>
                {#each $sotaStore.iterations as iteration, i}
                  <div class="iteration-item">
                    <div class="iteration-header">
                      <span class="iteration-step">Step {iteration.step}</span>
                      <span class="iteration-score">{formatScore(iteration.evaluation.vaguenessScore)}</span>
                    </div>
                    <p class="iteration-reasoning">{iteration.evaluation.reasoning}</p>
                    {#if iteration.appliedRedactions.length > 0}
                      <p class="iteration-redactions">
                        Applied {iteration.appliedRedactions.length} redaction{iteration.appliedRedactions.length !== 1 ? "s" : ""}
                      </p>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

            <div class="result-actions">
              <button class="btn-primary" on:click={handleRunAgain}>
                Run Again
              </button>
              <button class="btn-text" on:click={handleDisconnectApi}>
                Disconnect API
              </button>
            </div>
          </div>

        {:else if $sotaStore.error}
          <!-- Error State -->
          <div class="sota-section">
            <div class="error-display">
              <div class="error-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="15" y1="9" x2="9" y2="15"/>
                  <line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
              </div>
              <h4>Error</h4>
              <p class="error-message-text">{$sotaStore.error}</p>
              <button class="btn-primary" on:click={handleRunAgain}>
                Try Again
              </button>
            </div>
          </div>

        {:else}
          <!-- State B: Configuration (idle) -->
          <div class="sota-section">
            <div class="config-group">
              <label class="config-label" for="target-score-slider">Target Privacy Score</label>
              <div class="slider-container">
                <input
                  id="target-score-slider"
                  type="range"
                  min="0.3"
                  max="0.95"
                  step="0.05"
                  bind:value={$sotaStore.targetScore}
                  on:change={(e) => sotaStore.setTargetScore(parseFloat(e.currentTarget.value))}
                  class="score-slider"
                />
                <span class="slider-value">{Math.round($sotaStore.targetScore * 100)}%</span>
              </div>
              <p class="config-hint">Higher = more thorough redaction</p>
            </div>

            <div class="config-group">
              <span class="config-label">Max Iterations</span>
              <div class="options-row">
                {#each maxStepsOptions as opt}
                  <button
                    class="option-btn"
                    class:selected={$sotaStore.maxSteps === opt}
                    on:click={() => sotaStore.setMaxSteps(opt)}
                  >
                    {opt}
                  </button>
                {/each}
              </div>
            </div>

            <button
              class="btn-primary btn-start"
              on:click={handleStartSOTA}
              disabled={!hasImage || !$canStartLoop}
            >
              {#if !hasImage}
                Load an image first
              {:else}
                Start AI Detection
              {/if}
            </button>

            <button class="btn-text disconnect-link" on:click={handleDisconnectApi}>
              Disconnect API
            </button>
          </div>
        {/if}
      </div>
    {:else}
      <!-- EDGE Mode Content -->
      <button class="back-button" on:click={handleBackToModeSelection}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m15 18-6-6 6-6"/>
        </svg>
        Back
      </button>

      {#if showConsentDialog}
        <div class="consent-dialog">
          <div class="consent-icon">
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
              <path
                d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"
              />
              <path d="m5 3 1 1" />
              <path d="m19 21 1 1" />
              <path d="m5 21 1-1" />
              <path d="m19 3 1-1" />
            </svg>
          </div>
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
    {/if}

    <!-- Backend info -->
    {#if $detectionStore.backend}
      <div class="backend-info">
        Running on: <span class="backend-badge"
          >{$detectionStore.backend.toUpperCase()}</span
        >
      </div>
    {/if}

    <!-- Privacy Warning Toast -->
    {#if showPrivacyToast}
      <div class="toast-container" transition:fade={{ duration: 200 }}>
        <div class="toast warning">
          <div class="toast-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
              <path d="M12 9v4"/>
              <path d="M12 17h.01"/>
            </svg>
          </div>
          <div class="toast-content">
            <p class="toast-title">Privacy Notice</p>
            <p class="toast-message">SOTA detection sends your image to cloud servers. Your data will leave your device.</p>
          </div>
          <button class="toast-dismiss" on:click={dismissToast} aria-label="Dismiss">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6 6 18"/>
              <path d="m6 6 12 12"/>
            </svg>
          </button>
          <div class="toast-progress"></div>
        </div>
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

  /* Mode Selection */
  .mode-selection {
    padding: var(--space-4);
  }

  .mode-options {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .mode-option {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4);
    background: var(--bg-tertiary);
    border: 2px solid var(--border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    transition: all 0.2s ease;
    text-align: center;
  }

  .mode-option:hover {
    border-color: var(--accent);
    background: var(--bg-elevated);
    transform: translateY(-2px);
  }

  .mode-icon {
    color: var(--text-secondary);
  }

  .mode-option:hover .mode-icon {
    color: var(--accent);
  }

  .mode-name {
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .mode-description {
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .mode-badge {
    font-size: 0.6875rem;
    font-weight: 600;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-md);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .mode-badge.private {
    background: var(--success-subtle, rgba(34, 197, 94, 0.1));
    color: var(--success, #22c55e);
  }

  .mode-badge.cloud {
    background: var(--warning-subtle, rgba(234, 179, 8, 0.1));
    color: var(--warning, #eab308);
  }

  /* Back Button */
  .back-button {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    margin: var(--space-3) var(--space-4);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    font-size: 0.8125rem;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .back-button:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
    border-color: var(--border-strong);
  }

  /* SOTA Content */
  .sota-content {
    display: flex;
    flex-direction: column;
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
      bottom: calc(var(--mobile-panel-height) + var(--safe-area-bottom, 0px));
      left: 0;
      right: 0;
      width: 100%;
      height: auto;
      max-height: calc(70vh - var(--mobile-panel-height));
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

  /* Toast */
  .toast-container {
    position: absolute;
    bottom: var(--space-4);
    left: var(--space-4);
    right: var(--space-4);
    z-index: 100;
  }

  .toast {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3);
    background: var(--bg-primary);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-xl);
    border: 1px solid var(--border);
    position: relative;
    overflow: hidden;
  }

  .toast.warning {
    border-left: 3px solid var(--warning, #eab308);
  }

  .toast-icon {
    flex-shrink: 0;
    color: var(--warning, #eab308);
    margin-top: 2px;
  }

  .toast-content {
    flex: 1;
    min-width: 0;
  }

  .toast-title {
    margin: 0 0 var(--space-1) 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .toast-message {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .toast-dismiss {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .toast-dismiss:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .toast-progress {
    position: absolute;
    bottom: 0;
    left: 0;
    height: 3px;
    background: var(--warning, #eab308);
    animation: toast-progress 6s linear forwards;
  }

  @keyframes toast-progress {
    from {
      width: 100%;
    }
    to {
      width: 0%;
    }
  }

  /* Mobile toast adjustments */
  @media (max-width: 767px) {
    .toast-container {
      position: fixed;
      top: var(--space-4);
      bottom: auto;
      left: var(--space-4);
      right: var(--space-4);
      z-index: 200;
    }

    .toast {
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
    }
  }

  /* SOTA-specific styles */
  .sota-section {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .sota-section h4 {
    margin: 0 0 var(--space-2) 0;
    font-size: 1.125rem;
    color: var(--text-primary);
  }

  .sota-icon-header {
    color: var(--accent);
    margin-bottom: var(--space-3);
  }

  .sota-description {
    margin: 0 0 var(--space-4) 0;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .api-key-form {
    display: flex;
    gap: var(--space-2);
    width: 100%;
    margin-bottom: var(--space-3);
  }

  .api-key-input {
    flex: 1;
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-size: 0.875rem;
    font-family: monospace;
  }

  .api-key-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .api-key-input::placeholder {
    color: var(--text-muted);
  }

  .api-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--accent);
    font-size: 0.8125rem;
    text-decoration: none;
  }

  .api-link:hover {
    text-decoration: underline;
  }

  /* SOTA Progress */
  .sota-progress {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    margin-bottom: var(--space-4);
  }

  .step-indicator {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }

  .score-display {
    display: flex;
    align-items: baseline;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }

  .current-score {
    font-size: 2rem;
    font-weight: 700;
    color: var(--accent);
  }

  .score-separator {
    font-size: 1.25rem;
    color: var(--text-muted);
  }

  .target-score {
    font-size: 1.25rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .sota-progress .progress-bar {
    width: 100%;
    margin-bottom: var(--space-3);
  }

  .status-text {
    margin: 0 0 var(--space-3) 0;
    font-size: 0.875rem;
    color: var(--text-secondary);
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .btn-cancel {
    width: 100%;
  }

  /* SOTA Results */
  .results-summary {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--space-4);
    background: var(--bg-tertiary);
    border-radius: var(--radius-lg);
    width: 100%;
    margin-bottom: var(--space-4);
  }

  .results-summary.success {
    background: var(--success-subtle, rgba(34, 197, 94, 0.1));
  }

  .result-icon {
    margin-bottom: var(--space-2);
  }

  .results-summary.success .result-icon {
    color: var(--success, #22c55e);
  }

  .results-summary:not(.success) .result-icon {
    color: var(--warning, #eab308);
  }

  .final-score {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin-bottom: var(--space-1);
  }

  .final-score strong {
    color: var(--text-primary);
    font-size: 1rem;
  }

  .iterations-count {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  /* Iteration History */
  .history-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2);
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    font-size: 0.8125rem;
    cursor: pointer;
    transition: all 0.15s ease;
    margin-bottom: var(--space-3);
  }

  .history-toggle:hover {
    background: var(--bg-tertiary);
    border-color: var(--border-strong);
  }

  .history-toggle svg {
    transition: transform 0.2s ease;
  }

  .history-toggle svg.rotated {
    transform: rotate(180deg);
  }

  .iteration-history {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
    max-height: 200px;
    overflow-y: auto;
  }

  .iteration-item {
    padding: var(--space-3);
    background: var(--bg-tertiary);
    border-radius: var(--radius-md);
    text-align: left;
  }

  .iteration-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-2);
  }

  .iteration-step {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .iteration-score {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--accent);
  }

  .iteration-reasoning {
    margin: 0 0 var(--space-1) 0;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .iteration-redactions {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .result-actions {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
  }

  /* Error Display */
  .error-display {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--space-4);
    width: 100%;
  }

  .error-icon {
    color: var(--danger, #ef4444);
    margin-bottom: var(--space-3);
  }

  .error-message-text {
    margin: 0 0 var(--space-4) 0;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  /* Configuration */
  .config-group {
    width: 100%;
    margin-bottom: var(--space-4);
    text-align: left;
  }

  .config-label {
    display: block;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }

  .slider-container {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .score-slider {
    flex: 1;
    height: 6px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--bg-tertiary);
    border-radius: 3px;
    outline: none;
  }

  .score-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    background: var(--accent);
    border-radius: 50%;
    cursor: pointer;
    transition: transform 0.15s ease;
  }

  .score-slider::-webkit-slider-thumb:hover {
    transform: scale(1.1);
  }

  .score-slider::-moz-range-thumb {
    width: 18px;
    height: 18px;
    background: var(--accent);
    border-radius: 50%;
    border: none;
    cursor: pointer;
  }

  .slider-value {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
    min-width: 40px;
    text-align: right;
  }

  .config-hint {
    margin: var(--space-2) 0 0 0;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .options-row {
    display: flex;
    gap: var(--space-2);
  }

  .option-btn {
    flex: 1;
    padding: var(--space-2);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .option-btn:hover {
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }

  .option-btn.selected {
    background: var(--accent-subtle);
    border-color: var(--accent);
    color: var(--accent);
  }

  .btn-start {
    width: 100%;
    margin-bottom: var(--space-2);
  }

  .disconnect-link {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .disconnect-link:hover {
    color: var(--text-secondary);
  }

  /* Mobile SOTA adjustments */
  @media (max-width: 767px) {
    .api-key-form {
      flex-direction: column;
    }

    .api-key-form button {
      width: 100%;
    }

    .slider-container {
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-2);
    }

    .slider-value {
      text-align: center;
    }
  }
</style>
