<script lang="ts">
  import { theme, type Theme } from '../stores/theme';

  const themeConfig: Record<Theme, { icon: string; label: string }> = {
    light: {
      icon: 'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z',
      label: 'Light'
    },
    dark: {
      icon: 'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z',
      label: 'Dark'
    },
    system: {
      icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
      label: 'System'
    }
  };

  $: currentConfig = themeConfig[$theme];
</script>

<button
  class="theme-toggle icon-only ghost"
  on:click={() => theme.toggle()}
  data-tooltip={currentConfig.label}
  aria-label={`Toggle theme (current: ${currentConfig.label})`}
>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d={currentConfig.icon} />
  </svg>
</button>

<style>
  .theme-toggle {
    position: relative;
  }

  .theme-toggle svg {
    transition: transform 0.2s ease;
  }

  .theme-toggle:hover svg {
    transform: rotate(15deg);
  }
</style>
