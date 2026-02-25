<script lang="ts">
  import { activeTool, type ToolId } from '../stores/tools';
  import { zarrSource, metadata } from '../stores/zarr';
  import SimilaritySearch from './SimilaritySearch.svelte';
  import LabelPanel from './LabelPanel.svelte';

  const enabled = $derived(!!$metadata);

  const tools: { id: ToolId; label: string; icon: string }[] = [
    { id: 'similarity', label: 'Similar', icon: '◎' },
    { id: 'classifier', label: 'Classify', icon: '▦' },
    { id: 'segmenter',  label: 'Segment', icon: '⬡' },
  ];

  let { similarityRef = $bindable() }: { similarityRef?: SimilaritySearch } = $props();

  function switchTool(id: ToolId) {
    if (id === $activeTool) return;
    // Clear overlays from the previous tool so embedding tiles are visible
    $zarrSource?.clearClassificationOverlays();
    $activeTool = id;
  }
</script>

<div class="border-b border-gray-800/60 transition-opacity"
     class:opacity-40={!enabled} class:pointer-events-none={!enabled}>

  <!-- Tool tabs -->
  <div class="px-4 pt-3 pb-0">
    <span class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Tools</span>
    <div class="mt-2 flex gap-0.5">
      {#each tools as tool}
        <button
          onclick={() => switchTool(tool.id)}
          disabled={tool.id === 'segmenter'}
          class="flex-1 text-[10px] font-bold tracking-wider py-1.5 rounded-t border border-b-0 transition-all
                 {$activeTool === tool.id
                   ? 'bg-gray-900/80 text-term-cyan border-gray-700/60'
                   : 'bg-transparent text-gray-600 border-transparent hover:text-gray-400'}
                 disabled:opacity-30 disabled:pointer-events-none"
        >
          <span class="mr-0.5">{tool.icon}</span> {tool.label}
        </button>
      {/each}
    </div>
  </div>

  <!-- Active tool panel -->
  <div class="px-4 py-3 bg-gray-900/40 border-t border-gray-700/60">
    {#if $activeTool === 'similarity'}
      <SimilaritySearch bind:this={similarityRef} />
    {:else if $activeTool === 'classifier'}
      <LabelPanel />
    {:else if $activeTool === 'segmenter'}
      <div class="text-[9px] text-gray-700 italic">Polygon segmentation — coming soon</div>
    {/if}
  </div>
</div>
