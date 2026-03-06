<script lang="ts">
  import { Pencil, Square, X, Plus, Trash2 } from 'lucide-svelte';
  import { roiDrawing, drawMode, roiRegions, roiLoading, roiTileCount, clearAllRegions, removeRegion, type DrawMode } from '../stores/drawing';

  const modes: { id: DrawMode; icon: typeof Pencil; tip: string }[] = [
    { id: 'polygon',   icon: Pencil, tip: 'Polygon' },
    { id: 'rectangle', icon: Square, tip: 'Rectangle' },
  ];

  function startDrawing(mode: DrawMode) {
    $drawMode = mode;
    $roiDrawing = true;
  }

  function cancelDrawing() {
    $roiDrawing = false;
  }
</script>

<div class="px-3 py-2.5 border-b border-gray-800/60 space-y-2">
  {#if $roiDrawing}
    <!-- Drawing state -->
    <div class="flex items-center justify-between">
      <span class="text-[10px] text-term-cyan animate-pulse">
        {$drawMode === 'polygon' ? 'Click to draw polygon...' : 'Drag to draw rectangle...'}
      </span>
      <button
        onclick={cancelDrawing}
        class="text-[9px] text-gray-500 hover:text-red-400 px-1.5 py-0.5 rounded
               border border-gray-700/60 hover:border-red-400/40 transition-all"
      >Cancel</button>
    </div>
  {:else if $roiRegions.length === 0}
    <!-- Idle state — no regions -->
    <div class="flex items-center gap-1.5">
      <span class="text-[10px] text-gray-500 flex-1">Select region</span>
      {#each modes as m}
        <button
          onclick={() => startDrawing(m.id)}
          class="flex items-center gap-1 text-[10px] text-gray-400 hover:text-term-cyan
                 px-2 py-1.5 rounded border border-gray-700/60 hover:border-term-cyan/40 transition-all"
          title={m.tip}
        >
          <m.icon size={11} />
          {m.tip}
        </button>
      {/each}
    </div>
    <div class="text-[9px] text-gray-700 leading-relaxed">
      Draw a region on the map to load embeddings for analysis.
    </div>
  {:else}
    <!-- Has regions -->
    <div class="flex items-center justify-between">
      <span class="text-[10px] text-gray-400">
        {$roiRegions.length} region{$roiRegions.length !== 1 ? 's' : ''} &middot; {$roiTileCount} tiles
      </span>
      <div class="flex items-center gap-1">
        {#each modes as m}
          <button
            onclick={() => startDrawing(m.id)}
            class="text-gray-500 hover:text-term-cyan p-1 rounded
                   border border-gray-700/60 hover:border-term-cyan/40 transition-all"
            title="Add {m.tip.toLowerCase()}"
          >
            <Plus size={10} />
          </button>
        {/each}
        <button
          onclick={clearAllRegions}
          class="text-gray-500 hover:text-red-400 p-1 rounded
                 border border-gray-700/60 hover:border-red-400/40 transition-all"
          title="Clear all regions"
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>

    <!-- Region badges -->
    <div class="flex flex-wrap gap-1">
      {#each $roiRegions as region}
        <span class="inline-flex items-center gap-1 text-[9px] text-gray-400
                     bg-gray-800/60 px-1.5 py-0.5 rounded border border-gray-700/40">
          {region.chunkKeys.length} tiles
          <button
            onclick={() => removeRegion(region.id)}
            class="text-gray-600 hover:text-red-400 transition-colors"
            title="Remove region"
          >
            <X size={8} />
          </button>
        </span>
      {/each}
    </div>
  {/if}

  <!-- Loading progress bar -->
  {#if $roiLoading}
    <div class="space-y-1">
      <div class="flex justify-between text-[9px]">
        <span class="text-term-cyan">Loading embeddings...</span>
        <span class="text-gray-500">{$roiLoading.loaded}/{$roiLoading.total}</span>
      </div>
      <div class="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
        <div
          class="h-full bg-term-cyan/70 rounded-full transition-all duration-300"
          style="width: {($roiLoading.loaded / $roiLoading.total) * 100}%"
        ></div>
      </div>
    </div>
  {/if}
</div>
