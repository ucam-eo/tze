<script lang="ts">
  import { get } from 'svelte/store';
  import { sourceManager } from '../stores/zarr';
  import { simScores, simRefEmbedding, simSelectedPixel, simThreshold, simEmbeddingTileCount } from '../stores/similarity';
  import { roiLoading } from '../stores/drawing';
  import { computeSimilarityScores, renderSimilarityCanvas } from '../lib/similarity';

  let isComputing = $state(false);
  let pendingRecompute = false;
  let overlayCanvas: HTMLCanvasElement | undefined;

  // Track embedding loads via events
  $effect(() => {
    const mgr = $sourceManager;
    if (!mgr) { $simEmbeddingTileCount = 0; return; }
    $simEmbeddingTileCount = mgr.totalTileCount();
    const handler = () => {
      $simEmbeddingTileCount = mgr.totalTileCount();
    };
    mgr.on('embeddings-loaded', handler);
    return () => mgr.off('embeddings-loaded', handler);
  });

  // Recompute similarity when ROI loading finishes (transitions from loading to idle)
  let wasLoading = false;
  $effect(() => {
    const loading = $roiLoading;
    if (loading) {
      wasLoading = true;
    } else if (wasLoading) {
      wasLoading = false;
      if ($simRefEmbedding && $simSelectedPixel) runCompute();
    }
  });

  /** Re-render similarity overlays from existing scores (e.g. when switching back to this tab). */
  export function restoreOverlays() {
    if (get(simScores)) applyThreshold();
  }

  /** Called from App.svelte when the user clicks in similarity mode. */
  export function handleClick(lng: number, lat: number) {
    const mgr = $sourceManager;
    if (!mgr) return;
    const emb = mgr.getEmbeddingAt(lng, lat);
    if (!emb) return;

    $simSelectedPixel = { ci: emb.ci, cj: emb.cj, row: emb.row, col: emb.col, lng, lat };
    $simRefEmbedding = emb.embedding;
    runCompute();
  }

  /** CPU compute — runs once per reference pixel selection.
   *  For now uses the first zone's embedding region (single-zone path).
   *  Phase 3 will iterate all zones. */
  function runCompute() {
    const mgr = $sourceManager;
    if (!mgr || !$simRefEmbedding) return;
    if (isComputing) { pendingRecompute = true; return; }
    isComputing = true;

    try {
      mgr.clearSimilarityOverlay();
      // Use first zone with embeddings for now
      const regions = mgr.getEmbeddingRegions();
      if (regions.size === 0) return;
      const [firstZoneId, firstRegion] = regions.entries().next().value;
      $simScores = computeSimilarityScores(firstRegion, $simRefEmbedding);
      overlayCanvas = undefined; // force new canvas for new region geometry
      applyThreshold(firstZoneId);
    } finally {
      isComputing = false;
      if (pendingRecompute) {
        pendingRecompute = false;
        runCompute();
      }
    }
  }

  /** Render threshold into a single region-wide canvas and push to map. */
  function applyThreshold(zoneId?: string) {
    const mgr = $sourceManager;
    const result = $simScores;
    const threshold = $simThreshold;
    if (!mgr || !result) return;

    overlayCanvas = renderSimilarityCanvas(result, threshold, overlayCanvas);
    // Route overlay to the correct zone's source
    const resolvedZoneId = zoneId ?? mgr.getEmbeddingRegions().keys().next().value;
    if (resolvedZoneId) {
      const src = mgr.getOpenSource(resolvedZoneId);
      src?.setSimilarityOverlay(overlayCanvas);
    }
  }

  function handleClear() {
    $sourceManager?.clearSimilarityOverlay();
    $simSelectedPixel = null;
    $simRefEmbedding = null;
    $simScores = null;
    overlayCanvas = undefined;
  }

  // React to threshold changes from any source (sidebar slider or UMAP window slider)
  $effect(() => {
    const _t = $simThreshold; // track only threshold
    // Use get() to avoid tracking simScores in this effect
    if (get(simScores)) applyThreshold();
  });

</script>

<div class="space-y-3" data-tutorial="similarity-panel">
  {#if $simSelectedPixel}
    <div class="text-[10px] text-gray-600 italic">Reference pixel selected — see UMAP window</div>
  {:else if $simEmbeddingTileCount > 0}
    <div class="text-[10px] text-gray-600 italic">Click a pixel to select reference</div>
  {:else}
    <div class="text-[9px] text-gray-700 leading-relaxed">
      Draw a region above to load embeddings, then click any pixel to find similar ones.
    </div>
  {/if}

  {#if $simSelectedPixel}
    <div class="flex gap-1.5">
      <button
        onclick={handleClear}
        class="flex-1 text-[10px] text-gray-500 hover:text-red-400 px-2 py-1.5 rounded
               border border-gray-700/60 hover:border-red-400/40 transition-all"
      >CLEAR</button>
    </div>
  {/if}

  {#if isComputing}
    <div class="text-[9px] text-purple-400 animate-pulse">Computing similarity...</div>
  {/if}
</div>
