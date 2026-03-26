<script lang="ts">
  import { get } from 'svelte/store';
  import { sourceManager, displayManager } from '../stores/zarr';
  import { simScores, simRefEmbedding, simSelectedPixel, simThreshold, simEmbeddingTileCount } from '../stores/similarity';
  import { roiLoading } from '../stores/drawing';
  import { activeTool } from '../stores/tools';
  import { computeSimilarityScores, renderSimilarityCanvas } from '@ucam-eo/tessera-tasks';

  let isComputing = $state(false);
  let pendingRecompute = false;
  let overlayCanvases = new Map<string, HTMLCanvasElement>();

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

  // When ROI loading finishes, auto-select a reference pixel if none exists,
  // then compute similarity. This ensures UMAP always has scores to work with.
  let wasLoading = false;
  $effect(() => {
    const loading = $roiLoading;
    if (loading) {
      wasLoading = true;
    } else if (wasLoading) {
      wasLoading = false;
      if (!$simRefEmbedding || !$simSelectedPixel) {
        // Auto-select a random pixel as reference
        if (get(activeTool) === 'similarity') autoSelectPixel();
      } else {
        runCompute();
      }
    }
  });

  /** Pick a random valid pixel from the loaded embeddings and set it as reference. */
  async function autoSelectPixel() {
    const mgr = $sourceManager;
    if (!mgr) return;
    const regions = mgr.getEmbeddingRegions();
    if (regions.size === 0) return;

    // Find a random valid pixel
    for (const [zoneId, region] of regions) {
      const tilePixels = region.tileW * region.tileH;
      // Collect all valid tile indices
      const loadedTiles: number[] = [];
      for (let t = 0; t < region.loaded.length; t++) {
        if (region.loaded[t]) loadedTiles.push(t);
      }
      if (loadedTiles.length === 0) continue;

      // Pick a random loaded tile, then a random valid pixel in it
      const shuffled = loadedTiles.sort(() => Math.random() - 0.5);
      for (const t of shuffled) {
        const base = t * tilePixels * region.nBands;
        // Try a few random pixels in this tile
        for (let attempt = 0; attempt < 20; attempt++) {
          const pixelIdx = Math.floor(Math.random() * tilePixels);
          const offset = base + pixelIdx * region.nBands;
          if (isNaN(region.emb[offset])) continue;

          // Found a valid pixel — get its chunk coords
          const ci = region.ciMin + Math.floor(t / region.gridCols);
          const cj = region.cjMin + (t % region.gridCols);
          const row = Math.floor(pixelIdx / region.tileW);
          const col = pixelIdx % region.tileW;
          const embedding = region.emb.slice(offset, offset + region.nBands);

          // Reverse-project to lng/lat
          const src = await mgr.getSource(zoneId);
          const meta = src.metadata;
          const proj = src.projection;
          if (!meta || !proj) continue;

          const cs = meta.chunkShape;
          const tf = meta.transform;
          const globalRow = ci * cs[0] + row;
          const globalCol = cj * cs[1] + col;
          const easting = tf[2] + (globalCol + 0.5) * tf[0];
          const northing = tf[5] - (globalRow + 0.5) * tf[0];
          const [lng, lat] = proj.inverse(easting, northing);

          $simSelectedPixel = { ci, cj, row, col, lng, lat };
          $simRefEmbedding = embedding;
          runCompute();
          return;
        }
      }
    }
  }

  /** Re-render similarity overlays from existing scores (e.g. when switching back to this tab). */
  export function restoreOverlays() {
    if (get(simScores).size > 0) applyThreshold();
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

  /** CPU compute — runs once per reference pixel selection, across all zones. */
  function runCompute() {
    const mgr = $sourceManager;
    const dm = $displayManager;
    if (!mgr || !$simRefEmbedding) return;
    if (isComputing) { pendingRecompute = true; return; }
    isComputing = true;

    try {
      dm?.clearSimilarityOverlay();
      const regions = mgr.getEmbeddingRegions();
      if (regions.size === 0) return;

      const results = new Map<string, ReturnType<typeof computeSimilarityScores>>();
      for (const [zoneId, region] of regions) {
        results.set(zoneId, computeSimilarityScores(region, $simRefEmbedding!));
      }
      $simScores = results;
      overlayCanvases = new Map();
      applyThreshold();
    } finally {
      isComputing = false;
      if (pendingRecompute) {
        pendingRecompute = false;
        runCompute();
      }
    }
  }

  /** Render threshold into per-zone canvases and push to map. */
  function applyThreshold() {
    const dm = $displayManager;
    const results = get(simScores);
    const threshold = $simThreshold;
    if (!dm || results.size === 0) return;

    for (const [zoneId, result] of results) {
      let canvas = overlayCanvases.get(zoneId);
      canvas = renderSimilarityCanvas(result, threshold, canvas);
      overlayCanvases.set(zoneId, canvas);
      const src = dm.getOpenDisplaySource(zoneId);
      src?.setSimilarityOverlay(canvas);
    }
  }

  function handleClear() {
    $displayManager?.clearSimilarityOverlay();
    $simSelectedPixel = null;
    $simRefEmbedding = null;
    $simScores = new Map();
    overlayCanvases = new Map();
  }

  // React to threshold changes from any source (sidebar slider or UMAP window slider)
  $effect(() => {
    const _t = $simThreshold; // track only threshold
    if (get(simScores).size > 0) applyThreshold();
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
