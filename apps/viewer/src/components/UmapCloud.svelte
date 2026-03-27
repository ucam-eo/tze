<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { sourceManager } from '../stores/zarr';
  import { simScores, simRefEmbedding, simSelectedPixel, simThreshold, simEmbeddingTileCount } from '../stores/similarity';
  import { roiLoading } from '../stores/drawing';
  import { subsampleEmbeddings } from '../lib/umap-subsample';
  import { PointCloudRenderer } from '../lib/point-cloud-renderer';
  import type { UmapWorkerInput, UmapWorkerOutput } from '../lib/umap-worker';

  interface Props { visible: boolean; }
  let { visible }: Props = $props();

  let canvasEl = $state<HTMLCanvasElement>(undefined!);
  let renderer: PointCloudRenderer | null = null;
  let worker: Worker | null = null;
  let status = $state('');
  let currentScores: Float32Array | null = null;
  let currentRefIndex = -1;

  // Cached sample embeddings from last UMAP run — used to recolor on new ref pixel
  // without recomputing the UMAP projection.
  let cachedSampleEmb: Float32Array | null = null;
  let cachedSampleNBands = 0;
  let cachedSampleCount = 0;
  let lastUmapTileCount = 0;

  /** Loading state: idle → sampling → computing → ready */
  let umapState = $state<'idle' | 'sampling' | 'computing' | 'ready'>('idle');
  let sampledCount = $state(0);
  let computeStartTime = $state(0);
  let computeElapsed = $state(0);
  let computeTimerId: ReturnType<typeof setInterval> | undefined;

  const DPR = 2;
  const MIN_W = 200;
  const MIN_H = 200;

  // Window geometry — persists across show/hide
  let winW = $state(340);
  let winH = $state(400);
  let winX = $state(-1); // -1 = not yet positioned
  let winY = $state(-1);
  let dragState: { mode: 'move' | 'resize'; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number } | null = null;

  /** Position flush-right with the sidebar on first show; smaller on mobile. */
  function ensurePositioned() {
    if (winX >= 0) return;
    if (window.innerWidth < 640) {
      // Mobile: compact, centered horizontally, above bottom sheet
      winW = Math.min(240, window.innerWidth - 32);
      winH = 260;
      winX = Math.round((window.innerWidth - winW) / 2);
      winY = window.innerHeight - winH - 60;
    } else {
      // Desktop: sidebar-aligned
      winX = window.innerWidth - 16 - winW;
      winY = window.innerHeight - winH - 48;
    }
    if (winX < 8) winX = 8;
    if (winY < 60) winY = 60;
  }

  /** Build RGBA color array with threshold highlighting. */
  function buildColors(scores: Float32Array, refIndex: number, thresh: number): Uint8Array {
    const n = scores.length;
    const colors = new Uint8Array(n * 4);
    const isUniform = refIndex < 0;

    for (let i = 0; i < n; i++) {
      const off = i * 4;
      if (isUniform) {
        colors[off]     = 80;
        colors[off + 1] = 180;
        colors[off + 2] = 210;
        colors[off + 3] = 200;
      } else if (i === refIndex) {
        colors[off] = 255; colors[off + 1] = 255; colors[off + 2] = 255; colors[off + 3] = 255;
      } else {
        const s = scores[i];
        if (s >= thresh) {
          const t = thresh < 1 ? (s - thresh) / (1 - thresh) : 1;
          colors[off]     = Math.round(40 + 215 * t);
          colors[off + 1] = Math.round(220 + 35 * t);
          colors[off + 2] = 255;
          colors[off + 3] = 255;
        } else {
          const t = thresh > 0 ? s / thresh : 0;
          colors[off]     = Math.round(60 + 120 * t);
          colors[off + 1] = Math.round(20 + 40 * t);
          colors[off + 2] = Math.round(15 + 15 * t);
          colors[off + 3] = 255;
        }
      }
    }
    return colors;
  }

  function killWorker() {
    if (worker) { worker.terminate(); worker = null; }
    clearInterval(computeTimerId);
  }

  const MAX_UMAP_POINTS = 5000;

  async function runUmap() {
    const mgr = get(sourceManager);
    if (!mgr || mgr.totalTileCount() === 0) return;
    const regions = mgr.getEmbeddingRegions();
    if (regions.size === 0) return;

    killWorker();
    umapState = 'sampling';
    sampledCount = 0;
    status = 'Sampling...';

    const simResults = get(simScores);
    const ref = get(simRefEmbedding);
    const pixel = get(simSelectedPixel);

    // Need scores to do weighted UMAP — skip if not yet computed
    if (simResults.size === 0 || !ref || !pixel) return;

    // Count loaded tiles across all zones for proportional budgeting
    let totalLoadedTiles = 0;
    const zoneTileCounts = new Map<string, number>();
    for (const [zoneId, region] of regions) {
      let n = 0;
      for (let i = 0; i < region.loaded.length; i++) if (region.loaded[i]) n++;
      zoneTileCounts.set(zoneId, n);
      totalLoadedTiles += n;
    }

    // Subsample from each zone proportionally
    const allEmbeddings: Float32Array[] = [];
    const allScores: Float32Array[] = [];
    let totalCount = 0;
    let refIndex = -1;
    let nBands = 0;

    for (const [zoneId, region] of regions) {
      const zoneTiles = zoneTileCounts.get(zoneId) ?? 0;
      if (zoneTiles === 0) continue;
      const budget = Math.max(10, Math.round((zoneTiles / totalLoadedTiles) * MAX_UMAP_POINTS));

      const simResult = simResults.get(zoneId);
      if (!simResult) continue;
      const sample = subsampleEmbeddings(region, simResult, ref, pixel, budget);

      if (sample.count === 0) continue;
      if (sample.refIndex >= 0) refIndex = totalCount + sample.refIndex;

      allEmbeddings.push(sample.embeddings);
      allScores.push(sample.scores);
      totalCount += sample.count;
      nBands = sample.nBands;
      sampledCount = totalCount;
    }

    if (totalCount < 4) { status = 'Too few points'; umapState = 'idle'; return; }

    // Merge all zones into single buffers
    const embeddings = new Float32Array(totalCount * nBands);
    const scores = new Float32Array(totalCount);
    let offset = 0;
    for (let i = 0; i < allEmbeddings.length; i++) {
      const count = allScores[i].length;
      embeddings.set(allEmbeddings[i], offset * nBands);
      scores.set(allScores[i], offset);
      offset += count;
    }

    // If ref pixel was in no zone's subsample, inject it manually
    if (refIndex < 0 && ref) {
      const withRef = new Float32Array(embeddings.length + nBands);
      withRef.set(embeddings);
      withRef.set(ref, embeddings.length);
      const withScores = new Float32Array(scores.length + 1);
      withScores.set(scores);
      withScores[scores.length] = 1.0;
      refIndex = totalCount;
      totalCount++;
      launchUmapWorker({ embeddings: withRef, scores: withScores, refIndex, count: totalCount, nBands });
      return;
    }

    launchUmapWorker({ embeddings, scores, refIndex, count: totalCount, nBands });
  }

  function launchUmapWorker(sample: { embeddings: Float32Array; scores: Float32Array; refIndex: number; count: number; nBands: number }) {
    umapState = 'computing';
    computeStartTime = performance.now();
    computeElapsed = 0;
    status = `UMAP ${sample.count} pts...`;

    // Cache sample embeddings for recoloring on subsequent clicks
    cachedSampleEmb = new Float32Array(sample.embeddings);
    cachedSampleNBands = sample.nBands;
    cachedSampleCount = sample.count;

    // Tick timer for elapsed display
    computeTimerId = setInterval(() => {
      computeElapsed = Math.round((performance.now() - computeStartTime) / 100) / 10;
    }, 100);

    const w = new Worker(new URL('../lib/umap-worker.ts', import.meta.url), { type: 'module' });
    worker = w;

    w.postMessage(
      { embeddings: sample.embeddings, count: sample.count, nBands: sample.nBands } satisfies UmapWorkerInput,
      { transfer: [sample.embeddings.buffer] },
    );

    w.onmessage = (e: MessageEvent<UmapWorkerOutput>) => {
      if (worker !== w) return;
      clearInterval(computeTimerId);
      const { positions } = e.data;
      currentScores = sample.scores;
      currentRefIndex = sample.refIndex;
      const colors = buildColors(sample.scores, sample.refIndex, get(simThreshold));

      if (!renderer) renderer = new PointCloudRenderer(canvasEl);
      renderer.setData(positions, colors, sample.refIndex);
      renderer.start();

      umapState = 'ready';
      status = `${sample.count} points`;
      w.terminate();
      worker = null;
    };

    w.onerror = () => {
      if (worker !== w) return;
      clearInterval(computeTimerId);
      umapState = 'idle';
      status = 'UMAP failed';
      w.terminate();
      worker = null;
    };
  }

  /** Recolor existing UMAP points against a new reference embedding.
   *  Computes cosine similarity of new ref vs all cached sample embeddings. */
  function recolorUmap() {
    if (!cachedSampleEmb || !renderer) return;
    const ref = get(simRefEmbedding);
    if (!ref) return;

    const n = cachedSampleCount;
    const nB = cachedSampleNBands;
    const scores = new Float32Array(n);

    // Precompute ref norm
    let refNormSq = 0;
    for (let b = 0; b < nB; b++) refNormSq += ref[b] * ref[b];
    const refNorm = Math.sqrt(refNormSq) || 1;

    // Find which sample point is the new ref pixel (closest by cosine)
    let bestRefIdx = -1;
    let bestCos = -2;

    for (let i = 0; i < n; i++) {
      const off = i * nB;
      let dot = 0, normSq = 0;
      for (let b = 0; b < nB; b++) {
        dot += cachedSampleEmb[off + b] * ref[b];
        normSq += cachedSampleEmb[off + b] * cachedSampleEmb[off + b];
      }
      const cos = dot / (Math.sqrt(normSq) * refNorm || 1);
      scores[i] = Math.max(0, Math.min(1, (cos + 1) / 2)); // map [-1,1] to [0,1]
      if (cos > bestCos) { bestCos = cos; bestRefIdx = i; }
    }

    currentScores = scores;
    currentRefIndex = bestRefIdx;
    const colors = buildColors(scores, bestRefIdx, get(simThreshold));
    renderer.updateColors(colors);
    renderer.setRefIndex(bestRefIdx);
    status = `${n} points`;
  }

  // Trigger UMAP when tile count changes or initial load.
  // On subsequent reference pixel changes (simScores), just recolor.
  let umapTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const _s = $simScores;
    const _t = $simEmbeddingTileCount;
    const loading = $roiLoading;
    clearTimeout(umapTimer);
    if (_t > 0 && !loading) {
      // Only rerun full UMAP if tile count changed (new data loaded)
      if (_t !== lastUmapTileCount) {
        lastUmapTileCount = _t;
        umapTimer = setTimeout(runUmap, 60);
      } else if (cachedSampleEmb && renderer) {
        // Same tiles, new reference pixel — just recolor
        recolorUmap();
      } else {
        umapTimer = setTimeout(runUmap, 60);
      }
    }
  });

  // Recolor on threshold change
  $effect(() => {
    const t = $simThreshold;
    if (renderer && currentScores) {
      renderer.updateColors(buildColors(currentScores, currentRefIndex, t));
    }
  });

  // Position on first show
  $effect(() => {
    if (visible) ensurePositioned();
  });

  // Sync canvas pixel buffer to window body
  $effect(() => {
    if (!canvasEl) return;
    const bodyH = winH - 28 - 32;
    const size = Math.max(60, Math.min(winW, bodyH));
    const px = Math.round(size * DPR);
    if (canvasEl.width !== px || canvasEl.height !== px) {
      canvasEl.width = px;
      canvasEl.height = px;
    }
  });

  // Global drag/resize listeners
  $effect(() => {
    if (!visible) return;
    const onMove = (e: MouseEvent) => {
      if (!dragState) return;
      e.preventDefault();
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      if (dragState.mode === 'move') {
        winX = dragState.origX + dx;
        winY = dragState.origY + dy;
      } else {
        winW = Math.max(MIN_W, dragState.origW + dx);
        winH = Math.max(MIN_H, dragState.origH + dy);
      }
    };
    const onUp = () => { dragState = null; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  });

  function startDrag(e: MouseEvent) {
    e.preventDefault();
    dragState = { mode: 'move', startX: e.clientX, startY: e.clientY, origX: winX, origY: winY, origW: winW, origH: winH };
  }

  function startResize(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragState = { mode: 'resize', startX: e.clientX, startY: e.clientY, origX: winX, origY: winY, origW: winW, origH: winH };
  }

  function handleSlider(e: Event) {
    $simThreshold = parseInt((e.target as HTMLInputElement).value) / 100;
  }

  onMount(() => {
    return () => {
      killWorker();
      clearTimeout(umapTimer);
      renderer?.dispose();
      renderer = null;
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="umap-window"
  class:umap-hidden={!visible}
  data-tutorial="umap-cloud"
  style:left="{winX}px"
  style:top="{winY}px"
  style:width="{winW}px"
  style:height="{winH}px"
>
  <div class="umap-titlebar" onmousedown={startDrag}>
    <span class="text-[10px] text-gray-400 select-none">UMAP</span>
    {#if $simSelectedPixel}
      <span class="text-[9px] text-gray-500 select-none">ref ({$simSelectedPixel.ci},{$simSelectedPixel.cj}) [{$simSelectedPixel.row},{$simSelectedPixel.col}]</span>
    {/if}
    <span class="flex-1"></span>
    <span class="text-[9px] text-gray-600 select-none">{status}</span>
  </div>

  <div class="umap-body">
    <canvas bind:this={canvasEl} class="umap-canvas"></canvas>
    {#if umapState === 'sampling' || umapState === 'computing'}
      <!-- Loading overlay on top of canvas -->
      <div class="umap-loading">
        <div class="umap-ring-outer">
          <div class="umap-ring-inner"></div>
        </div>
        <div class="umap-loading-status">
          {#if umapState === 'sampling'}
            <span class="umap-loading-label">SAMPLING EMBEDDINGS</span>
            <span class="umap-loading-detail">{sampledCount.toLocaleString()} points collected</span>
          {:else}
            <span class="umap-loading-label">COMPUTING PROJECTION</span>
            <span class="umap-loading-detail">{sampledCount.toLocaleString()} pts &middot; {computeElapsed.toFixed(1)}s</span>
          {/if}
        </div>
        <div class="umap-dots"></div>
      </div>
    {/if}
  </div>

  <div class="umap-footer" data-tutorial="umap-threshold">
    <span class="text-gray-500 text-[10px] shrink-0">Thresh</span>
    <input type="range" min="0" max="100"
           value={Math.round($simThreshold * 100)}
           oninput={handleSlider}
           class="flex-1 h-1 cursor-pointer" />
    <span class="text-gray-400 text-[10px] tabular-nums w-7 text-right">{$simThreshold.toFixed(2)}</span>
    <div class="umap-resize" onmousedown={startResize}>
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path d="M9 1L1 9M9 5L5 9M9 8L8 9" stroke="rgba(100,100,100,0.6)" stroke-width="1.2"/>
      </svg>
    </div>
  </div>
</div>

<style>
  .umap-window {
    position: fixed;
    z-index: 30;
    display: flex;
    flex-direction: column;
    background: rgba(10, 10, 14, 0.45);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(0, 229, 255, 0.2);
    border-radius: 0.5rem;
    box-shadow: 0 0 30px rgba(0, 229, 255, 0.06), 0 4px 24px rgba(0,0,0,0.5);
    overflow: hidden;
    font-family: monospace;
  }

  .umap-hidden { display: none; }

  .umap-titlebar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    background: rgba(0, 0, 0, 0.35);
    border-bottom: 1px solid rgba(55, 65, 81, 0.4);
    cursor: grab;
    user-select: none;
    height: 28px;
    min-height: 28px;
  }

  .umap-titlebar:active { cursor: grabbing; }

  .umap-body {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    position: relative;
  }

  .umap-canvas {
    width: 100%;
    height: 100%;
    display: block;
    cursor: grab;
  }

  .umap-canvas:active { cursor: grabbing; }

  /* --- Loading overlay --- */
  .umap-loading {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    background: rgba(0, 2, 8, 0.6);
  }

  /* Dual counter-spinning rings */
  .umap-ring-outer {
    position: relative;
    width: 56px;
    height: 56px;
    border: 2px solid transparent;
    border-top-color: rgba(0, 229, 255, 0.8);
    border-right-color: rgba(0, 229, 255, 0.25);
    border-radius: 50%;
    animation: umap-spin 1.2s linear infinite;
    box-shadow: 0 0 16px rgba(0, 229, 255, 0.15);
  }

  .umap-ring-inner {
    position: absolute;
    inset: 7px;
    border: 2px solid transparent;
    border-bottom-color: rgba(255, 0, 128, 0.6);
    border-left-color: rgba(255, 0, 128, 0.2);
    border-radius: 50%;
    animation: umap-spin 0.8s linear infinite reverse;
  }

  @keyframes umap-spin {
    to { transform: rotate(360deg); }
  }

  .umap-loading-status {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    z-index: 1;
  }

  .umap-loading-label {
    font-size: 10px;
    letter-spacing: 3px;
    color: rgba(0, 229, 255, 0.7);
    text-transform: uppercase;
    animation: umap-pulse 2s ease-in-out infinite;
  }

  .umap-loading-detail {
    font-size: 9px;
    color: rgba(0, 229, 255, 0.35);
    font-variant-numeric: tabular-nums;
  }

  @keyframes umap-pulse {
    0%, 100% { opacity: 0.7; }
    50% { opacity: 1; }
  }

  /* Subtle animated dot grid background */
  .umap-dots {
    position: absolute;
    inset: 0;
    background-image: radial-gradient(rgba(0, 229, 255, 0.08) 1px, transparent 1px);
    background-size: 16px 16px;
    animation: umap-dots-shift 4s linear infinite;
    pointer-events: none;
  }

  @keyframes umap-dots-shift {
    to { background-position: 16px 16px; }
  }

  .umap-footer {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.5rem;
    background: rgba(0, 0, 0, 0.25);
    border-top: 1px solid rgba(55, 65, 81, 0.4);
    height: 32px;
    min-height: 32px;
  }

  .umap-resize {
    cursor: nwse-resize;
    padding: 2px;
    margin-left: 2px;
    opacity: 0.4;
  }

  .umap-resize:hover { opacity: 1; }
</style>
