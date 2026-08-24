<script lang="ts">
  import { get } from 'svelte/store';
  import { sourceManager, displayManager, metadata } from '../stores/zarr';
  import { simScores, simRefEmbedding, simSelectedPixel, simThreshold, simEmbeddingTileCount } from '../stores/similarity';
  import { roiLoading } from '../stores/drawing';
  import { activeTool } from '../stores/tools';
  import { computeSimilarityScores, renderSimilarityCanvas, topKOverlap } from '@ucam-eo/tessera-tasks';
  import type { SimilarityResult } from '@ucam-eo/tessera-tasks';

  /** How many of the best-scoring pixels the depth comparison checks. */
  const TOP_K = 100;

  let isComputing = $state(false);
  /** Agreement between a truncated-depth search and the full-depth one. */
  let depthAgreement = $state<{ depth: number; nBands: number; overlap: number }[]>([]);
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

          // Reverse-project to lng/lat using library coordinate conversion
          const src = await mgr.getSource(zoneId);
          const lngLat = src.pixelToLngLat(ci, cj, row, col);
          if (!lngLat) continue;
          const [lng, lat] = lngLat;

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
      compareDepths(results);
    } finally {
      isComputing = false;
      if (pendingRecompute) {
        pendingRecompute = false;
        runCompute();
      }
    }
  }

  /**
   * Score the same reference at every shallower matryoshka depth and report how
   * much of the full-depth top-K each one would still surface.
   *
   * Costs no extra bandwidth: the loaded embeddings already hold the shallow
   * vectors, since each depth's array is a prefix of the full one. Truncating
   * the reference is all it takes — `computeSimilarityScores` normalises by
   * however many dimensions the reference carries.
   */
  function compareDepths(fullResults: Map<string, SimilarityResult>) {
    const mgr = $sourceManager;
    const ref = $simRefEmbedding;
    const depths = get(metadata)?.geoemb_depths?.map(d => d.dimensions) ?? [];
    if (!mgr || !ref || depths.length < 2) { depthAgreement = []; return; }

    const regions = mgr.getEmbeddingRegions();
    const fullScores = concatScores(fullResults, regions.keys());

    depthAgreement = depths
      .filter(depth => depth < ref.length)
      .map(depth => {
        const truncated = ref.slice(0, depth);
        const results = new Map<string, SimilarityResult>();
        for (const [zoneId, region] of regions) {
          results.set(zoneId, computeSimilarityScores(region, truncated));
        }
        return {
          depth,
          nBands: ref.length,
          overlap: topKOverlap(concatScores(results, regions.keys()), fullScores, TOP_K),
        };
      });
  }

  /** Flatten per-zone scores into one array, in a stable zone order. */
  function concatScores(results: Map<string, SimilarityResult>, zoneIds: Iterable<string>): Float32Array {
    const parts: Float32Array[] = [];
    let total = 0;
    for (const zoneId of zoneIds) {
      const r = results.get(zoneId);
      if (!r) continue;
      parts.push(r.scores);
      total += r.scores.length;
    }
    const all = new Float32Array(total);
    let at = 0;
    for (const part of parts) { all.set(part, at); at += part.length; }
    return all;
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
    depthAgreement = [];
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

  {#if depthAgreement.length > 0}
    <div class="space-y-1 border-t border-gray-800/40 pt-2">
      <div class="text-[9px] text-gray-500">Same search at lower depth</div>
      {#each depthAgreement as d (d.depth)}
        <div class="flex items-center justify-between gap-2 text-[9px] tabular-nums">
          <span class="text-gray-400">d{d.depth}</span>
          <span class="text-gray-600">{(d.nBands / d.depth).toFixed(0)}× less data</span>
          <span class:text-term-cyan={d.overlap >= 0.9}
                class:text-yellow-400={d.overlap >= 0.5 && d.overlap < 0.9}
                class:text-red-400={d.overlap < 0.5}>
            {Number.isNaN(d.overlap) ? '—' : `${Math.round(d.overlap * 100)}%`}
          </span>
        </div>
      {/each}
      <div class="text-[8px] text-gray-600">of the top {TOP_K} pixels, vs the full-depth search</div>
    </div>
  {/if}
</div>
