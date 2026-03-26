<script lang="ts">
  import { onMount } from 'svelte';
  import { welcomeJustDismissed } from '../stores/welcome';

  let open = $state(true);

  const STORAGE_KEY = 'tze-welcome-dismissed';

  onMount(() => {
    if (localStorage.getItem(STORAGE_KEY)) open = false;
  });

  function dismiss() {
    open = false;
    localStorage.setItem(STORAGE_KEY, '1');
    welcomeJustDismissed.set(true);
    setTimeout(() => welcomeJustDismissed.set(false), 4000);
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
       onclick={dismiss} onkeydown={(e) => { if (e.key === 'Escape') dismiss(); }}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="welcome-card" onclick={(e) => e.stopPropagation()}>

      <div class="text-center mb-5">
        <div class="inline-flex items-center gap-2 mb-2">
          <div class="w-2.5 h-2.5 rounded-full bg-term-cyan shadow-[0_0_8px_rgba(0,229,255,0.6)]"></div>
          <span class="text-term-cyan text-base font-bold tracking-[0.25em] uppercase">TZE</span>
        </div>
        <p class="text-gray-500 text-[11px] tracking-wider">TESSERA Zarr Explorer</p>
      </div>

      <p class="text-[10px] text-gray-400 text-center mb-4 leading-relaxed">
        Explore satellite embedding datasets directly in the browser.
        Switch between analysis modes using the tabs in the <span class="text-term-cyan">top bar</span>:
      </p>

      <div class="grid grid-cols-2 gap-3 mb-5">
        <div class="tool-card">
          <span class="tool-label">Explorer</span>
          <span class="tool-desc">Browse satellite imagery and inspect individual pixel embeddings across time and space.</span>
        </div>
        <div class="tool-card">
          <span class="tool-label">Similar</span>
          <span class="tool-desc">Click any pixel to find visually similar regions. UMAP projects the embedding space in 3D.</span>
        </div>
        <div class="tool-card">
          <span class="tool-label">Classify</span>
          <span class="tool-desc">Label a few training pixels, then run GPU-accelerated k-NN to classify the full region.</span>
        </div>
        <div class="tool-card">
          <span class="tool-label">Segment</span>
          <span class="tool-desc">Run a neural network to detect features like buildings and roads from the embeddings.</span>
        </div>
      </div>

      <div class="text-center space-y-3">
        <p class="text-[10px] text-gray-400 leading-relaxed">
          New here? The <span class="text-term-cyan font-bold">Learn</span> button in the top bar
          has guided tutorials to walk you through each tool.
        </p>
        <button onclick={dismiss}
                class="px-5 py-2 rounded text-[11px] font-medium tracking-wider uppercase
                       text-term-cyan border border-term-cyan/40
                       hover:bg-term-cyan/10 hover:border-term-cyan/60
                       transition-all cursor-pointer">
          Get Started
        </button>
        <p class="text-[9px] text-gray-700">Click anywhere to dismiss</p>
      </div>
    </div>
  </div>
{/if}

<style>
  .welcome-card {
    width: 420px;
    max-width: calc(100vw - 32px);
    background: rgba(8, 8, 14, 0.95);
    border: 1px solid rgba(0, 229, 255, 0.2);
    border-radius: 12px;
    padding: 24px;
    box-shadow: 0 0 40px rgba(0, 229, 255, 0.08), 0 8px 32px rgba(0, 0, 0, 0.6);
    font-family: monospace;
  }

  .tool-card {
    padding: 10px 12px;
    border: 1px solid rgba(55, 65, 81, 0.5);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.3);
    transition: border-color 0.2s;
  }

  .tool-card:hover {
    border-color: rgba(0, 229, 255, 0.3);
  }

  .tool-label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    color: rgba(0, 229, 255, 0.8);
    letter-spacing: 1px;
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .tool-desc {
    display: block;
    font-size: 10px;
    line-height: 1.5;
    color: rgb(156, 163, 175);
  }
</style>
