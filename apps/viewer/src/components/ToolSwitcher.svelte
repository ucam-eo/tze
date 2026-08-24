<script lang="ts">
  import { activeTool, type ToolId } from '../stores/tools';
  import { displayManager, metadata } from '../stores/zarr';
  import { segmentVisible } from '../stores/segmentation';
  import { roiDrawing } from '../stores/drawing';
  import { get } from 'svelte/store';
  import SimilaritySearch from './SimilaritySearch.svelte';
  import LabelPanel from './LabelPanel.svelte';
  import SegmentPanel from './SegmentPanel.svelte';

  const enabled = $derived(!!$metadata);

  let { similarityRef = $bindable(), onOpenOsm }: { similarityRef?: SimilaritySearch; onOpenOsm?: () => void } = $props();

  // Handle tool transition side effects reactively (tabs are in TopBar now)
  let prevTool: ToolId | null = null;
  $effect(() => {
    const tool = $activeTool;
    if (prevTool !== null && prevTool !== tool) {
      if (prevTool === 'segmenter') segmentVisible.set(false);
      get(displayManager)?.clearClassificationOverlays();
      if (tool === 'segmenter') segmentVisible.set(true);
      if (tool === 'explorer') {
        roiDrawing.set(false);  // disable selection in explorer mode
      } else {
        roiDrawing.set(true);   // re-enable selection in other modes
      }
      if (tool === 'similarity') similarityRef?.restoreOverlays();
    }
    prevTool = tool;
  });
</script>

<div class="transition-opacity"
     class:opacity-40={!enabled} class:pointer-events-none={!enabled}>

  <!-- Active tool panel -->
  <div class="px-3 py-3">
    <!-- SimilaritySearch always mounted (preserves UMAP state), hidden via CSS -->
    <div class:hidden={$activeTool !== 'similarity'}>
      <SimilaritySearch bind:this={similarityRef} />
    </div>
    {#if $activeTool === 'classifier'}
      <LabelPanel onOpenOsm={onOpenOsm} />
    {:else if $activeTool === 'segmenter'}
      <SegmentPanel />
    {:else if $activeTool === 'explorer'}
      <div class="text-[10px] text-gray-500 leading-relaxed">
        Click a tile on the map to open its inspector.
      </div>
    {/if}
  </div>
</div>
