<script lang="ts">
  import { onMount } from 'svelte';
  import { sourceManager, metadata } from '../stores/zarr';
  import { explorerPinned, explorerTileEmb, explorerPixel, YEAR_COLORS } from '../stores/zarr-explorer';
  import FloatingWindow from './FloatingWindow.svelte';
  import MatryoshkaPanel from './MatryoshkaPanel.svelte';
  import TileTimelapse from './TileTimelapse.svelte';
  import { get } from 'svelte/store';

  // --- Animated fingerprint canvas ---
  let fpCanvasEl = $state<HTMLCanvasElement>(undefined!);
  let fpAnimId: number | null = null;
  let fpDisplayTile: Float32Array | null = null;  // lerped tile mean values
  let fpDisplayPx: Float32Array | null = null;    // lerped pixel values
  let fpTargetTile: Float32Array | null = null;
  let fpTargetPx: Float32Array | null = null;
  let fpHasPixel = false;
  let fpNBands = 0;
  const FP_LERP = 0.12;

  function updateFpTarget(tileMean: Float32Array, pixelEmb: Float32Array | null) {
    const n = tileMean.length;
    // Find shared max for normalization
    let maxAbs = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(tileMean[i]);
      if (a > maxAbs) maxAbs = a;
    }
    if (pixelEmb) {
      for (let i = 0; i < n; i++) {
        const a = Math.abs(pixelEmb[i]);
        if (a > maxAbs) maxAbs = a;
      }
    }
    if (maxAbs === 0) maxAbs = 1;

    if (!fpTargetTile || fpTargetTile.length !== n) {
      fpTargetTile = new Float32Array(n);
      fpDisplayTile = new Float32Array(n);
      fpTargetPx = new Float32Array(n);
      fpDisplayPx = new Float32Array(n);
      // Init display to target (no initial morph)
      for (let i = 0; i < n; i++) {
        fpDisplayTile[i] = fpTargetTile[i] = tileMean[i] / maxAbs;
        fpDisplayPx[i] = fpTargetPx[i] = pixelEmb ? pixelEmb[i] / maxAbs : fpTargetTile[i];
      }
    } else {
      for (let i = 0; i < n; i++) {
        fpTargetTile![i] = tileMean[i] / maxAbs;
        fpTargetPx![i] = pixelEmb ? pixelEmb[i] / maxAbs : fpTargetTile![i];
      }
    }
    fpHasPixel = !!pixelEmb;
    fpNBands = n;
    if (fpAnimId == null) fpAnimId = requestAnimationFrame(fpAnimFrame);
  }

  function fpAnimFrame() {
    fpAnimId = null;
    if (!fpDisplayTile || !fpTargetTile || !fpDisplayPx || !fpTargetPx || !fpCanvasEl) return;

    // Lerp
    let maxDelta = 0;
    for (let i = 0; i < fpNBands; i++) {
      let d = fpTargetTile[i] - fpDisplayTile[i];
      fpDisplayTile[i] += d * FP_LERP;
      if (Math.abs(d) > maxDelta) maxDelta = Math.abs(d);
      d = fpTargetPx[i] - fpDisplayPx[i];
      fpDisplayPx[i] += d * FP_LERP;
      if (Math.abs(d) > maxDelta) maxDelta = Math.abs(d);
    }

    fpRenderCanvas();

    if (maxDelta > 0.001 || fpHasPixel) {
      fpAnimId = requestAnimationFrame(fpAnimFrame);
    }
  }

  function fpRenderCanvas() {
    if (!fpCanvasEl || !fpDisplayTile || !fpDisplayPx) return;
    const canvas = fpCanvasEl;
    const W = canvas.width;
    const H = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const n = fpNBands;
    const t = performance.now() / 1000;
    const barW = W / n;
    const midY = H / 2;
    const maxH = midY - 2;

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, W, H);

    // Centre line
    ctx.strokeStyle = 'rgba(100,100,100,0.15)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke();

    for (let i = 0; i < n; i++) {
      const x = i * barW;
      const hue = ((i / n) * 270 + 180) % 360;
      const tileV = fpDisplayTile[i];
      const pxV = fpDisplayPx[i];

      // Tile mean: dim bar
      const tileH = tileV * maxH;
      ctx.fillStyle = `hsla(${hue}, 40%, 35%, ${fpHasPixel ? 0.35 : 0.8})`;
      ctx.fillRect(x, tileH >= 0 ? midY - tileH : midY, barW, Math.abs(tileH));

      if (fpHasPixel) {
        // Pixel: bright bar
        const pxH = pxV * maxH;
        ctx.fillStyle = `hsla(${hue}, 70%, 60%, 0.85)`;
        ctx.fillRect(x, pxH >= 0 ? midY - pxH : midY, barW, Math.abs(pxH));

        // Difference glow (where pixel exceeds or falls below tile)
        const diff = pxH - tileH;
        if (Math.abs(diff) > 0.5) {
          const top = diff > 0 ? midY - pxH : midY - tileH;
          ctx.fillStyle = diff > 0 ? 'rgba(0,229,255,0.5)' : 'rgba(255,50,100,0.5)';
          ctx.fillRect(x, top, barW, Math.abs(diff));
        }
      }
    }

    if (fpHasPixel) {
      // Animated sinusoidal overlay — shows the "wave" of difference
      ctx.globalCompositeOperation = 'screen';
      ctx.lineWidth = 1;

      // Primary wave (cyan, traces the difference contour)
      ctx.strokeStyle = 'rgba(0,229,255,0.25)';
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) * barW;
        const diff = (fpDisplayPx[i] - fpDisplayTile[i]) * maxH;
        const wave = Math.sin(i * 0.3 + t * 3) * 2;
        const y = midY - diff + wave;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Secondary wave (magenta, offset phase)
      ctx.strokeStyle = 'rgba(255,0,128,0.15)';
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) * barW;
        const diff = (fpDisplayPx[i] - fpDisplayTile[i]) * maxH;
        const wave = Math.sin(i * 0.5 - t * 2) * 3;
        const y = midY - diff * 0.7 + wave;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // React to pixel/tile changes
  $effect(() => {
    const ts = tileStats;
    const px = $explorerPixel;
    if (ts && ts.fingerprint.length > 0) {
      updateFpTarget(ts.fingerprint, px?.embedding ?? null);
    }
  });

  onMount(() => {
    return () => {
      if (fpAnimId != null) cancelAnimationFrame(fpAnimId);
    };
  });

  // Year probe state
  let probeResults = $state<Map<number, 'pending' | 'found' | 'missing'>>(new Map());
  let probeGen = 0;
  let probing = $state(false);

  // Temporal analysis state
  type YearData = { year: number; norm: number; embedding: Float32Array };
  let temporalData = $state<YearData[]>([]);
  let temporalLoading = $state(false);
  let temporalGen = 0;

  // Per-tile stats (computed from loaded region OR fetched on demand)
  type TileStats = {
    validPixels: number;
    totalPixels: number;
    meanNorm: number;
    minNorm: number;
    maxNorm: number;
    variance: number;
    fingerprint: Float32Array;
  };
  let tileStats = $state<TileStats | null>(null);
  let tileStatsLoading = $state(false);
  let tileStatsGen = 0;

  /** Fetch tile embeddings + compute stats using library API (no internal access). */
  async function computeTileStats() {
    const hover = get(explorerPinned);
    if (!hover || hover.ci < 0) { tileStats = null; return; }
    const mgr = get(sourceManager);
    if (!mgr) { tileStats = null; return; }

    const myGen = ++tileStatsGen;
    tileStatsLoading = true;
    tileStats = null;

    try {
      let src = mgr.getOpenSource(hover.zoneId);
      if (!src) src = await mgr.getSource(hover.zoneId);
      if (myGen !== tileStatsGen) return;

      // Use library API — handles region cache, fetch, dequantization, v1/v2 layouts
      const tile = await src.fetchTileEmbeddings(hover.ci, hover.cj);
      if (!tile || myGen !== tileStatsGen) { tileStatsLoading = false; return; }

      // Use library stats computation
      const { TesseraSource } = await import('@ucam-eo/tessera');
      if (myGen !== tileStatsGen) return;
      const stats = TesseraSource.statsFromBuffer(tile.emb, tile.tileW * tile.tileH, tile.nBands);
      if (!stats) { tileStats = null; tileStatsLoading = false; return; }

      tileStats = stats;

      // Populate tile emb store for per-pixel fingerprint
      let meanNorm = 0;
      const fp = stats.fingerprint;
      for (let b = 0; b < fp.length; b++) meanNorm += fp[b] * fp[b];
      meanNorm = Math.sqrt(meanNorm);
      $explorerTileEmb = {
        zoneId: hover.zoneId, ci: hover.ci, cj: hover.cj,
        emb: tile.emb, nBands: tile.nBands, tileW: tile.tileW, tileH: tile.tileH,
        tileMean: fp, tileMeanNorm: meanNorm,
      };
    } catch { /* fetch failed */ }

    if (myGen === tileStatsGen) tileStatsLoading = false;
  }

  async function fetchTemporalData() {
    const hover = get(explorerPinned);
    if (!hover || hover.ci < 0) return;
    const myGen = ++temporalGen;
    temporalLoading = true;
    temporalData = [];

    const mgr = get(sourceManager);
    if (!mgr) { temporalLoading = false; return; }

    try {
      let src = mgr.getOpenSource(hover.zoneId);
      if (!src) src = await mgr.getSource(hover.zoneId);
      if (myGen !== temporalGen) return;

      // Find a valid pixel in this tile (handles coastal/partial tiles)
      const px = await src.findValidPixel(hover.ci, hover.cj);
      if (!px || myGen !== temporalGen) { temporalLoading = false; return; }

      const results = await src.fetchTemporalPixel(hover.ci, hover.cj, px.row, px.col);
      if (myGen !== temporalGen) return;
      temporalData = results;
    } catch { /* fetch failed */ }

    if (myGen === temporalGen) temporalLoading = false;
  }

  async function probeSelectedShard() {
    const hover = get(explorerPinned);
    if (!hover) return;
    const myProbeGen = ++probeGen;
    probing = true;
    const mgr = get(sourceManager);
    if (!mgr) { probing = false; return; }

    let src = mgr.getOpenSource(hover.zoneId);
    if (!src) {
      try { src = await mgr.getSource(hover.zoneId); } catch { probing = false; return; }
    }
    const meta = src.metadata;
    if (!meta?.years?.length) { probing = false; return; }

    const pending = new Map<number, 'pending' | 'found' | 'missing'>();
    for (const year of meta.years) pending.set(year, 'pending');
    probeResults = new Map(pending);

    if (myProbeGen !== probeGen) return;
    const yearMap = await mgr.probeYearData(hover.zoneId, hover.ci, hover.cj);
    if (myProbeGen !== probeGen) return;

    const results = new Map<number, 'pending' | 'found' | 'missing'>();
    for (const [year, exists] of yearMap) {
      results.set(year, exists ? 'found' : 'missing');
    }
    probeResults = results;
    probing = false;
    // Auto-fetch temporal comparison once probing is done
    if ([...results.values()].filter(s => s === 'found').length > 1) {
      fetchTemporalData();
    }
  }

  // Auto-probe after a brief pause when selection changes; cancel on new click
  let probeTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const hover = $explorerPinned;
    clearTimeout(probeTimer);
    probeResults = new Map();
    probeGen++;
    probing = false;

    temporalData = [];
    temporalGen++;
    temporalLoading = false;

    // Fetch tile stats (from region or on demand)
    tileStats = null;
    tileStatsGen++;
    tileStatsLoading = false;
    $explorerTileEmb = null;
    if (hover && hover.ci >= 0) {
      computeTileStats();
      probeTimer = setTimeout(() => probeSelectedShard(), 300);
    }

    return () => clearTimeout(probeTimer);
  });

  const selected = $derived($explorerPinned);
  /** Depth comparison earns a second column; without it the window stays narrow. */
  const hasDepths = $derived(($metadata?.geoemb_depths?.length ?? 0) > 1);

  /** Pretty-print a URL: show just the hostname + last path segment. */
  function shortUrl(url: string): string {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      return u.hostname + (parts.length > 0 ? '/.../' + parts[parts.length - 1] : '');
    } catch { return url; }
  }

</script>

<FloatingWindow
  open={!!selected}
  title={selected ? `${selected.zoneId} shard [${selected.ci}, ${selected.cj}]` : ''}
  subtitle={$metadata?.geoemb_modelName}
  width={hasDepths ? 700 : 360}
  onclose={() => explorerPinned.set(null)}
>
  <div class="flex items-start gap-3" data-tutorial="explorer-panel">
    <div class="flex-1 min-w-0 space-y-3">
    {#if selected}
      {@const mgr = $sourceManager}
      {@const src = mgr?.getOpenSource(selected.zoneId)}
      {@const meta = src?.metadata}
      <div class="bg-gray-900/80 border border-term-cyan/30 rounded px-2.5 py-2 space-y-1.5">
        <div class="text-[10px] text-gray-300 font-medium">
          {selected.zoneId}
          <span class="text-gray-500 font-normal">shard [{selected.ci}, {selected.cj}]</span>
        </div>
        {#if $explorerPixel && $explorerPixel.ci === selected.ci && $explorerPixel.cj === selected.cj}
          {@const px = $explorerPixel}
          {@const cos = px.cosineVsTile}
          {@const cosHue = cos > 0.95 ? 120 : cos > 0.8 ? 60 : 0}
          <div class="text-[9px] text-term-cyan/70 tabular-nums">
            {px.lng.toFixed(6)}, {px.lat.toFixed(6)}
            <span class="text-gray-600 ml-1">px [{px.row}, {px.col}]</span>
          </div>
          <div class="flex items-center gap-2 text-[9px]">
            <span class="text-gray-500">norm</span>
            <span class="text-gray-400 tabular-nums">{px.norm.toFixed(2)}</span>
            <span class="text-gray-500">vs tile</span>
            <span class="tabular-nums" style="color: hsl({cosHue}, 70%, 55%)">{cos.toFixed(3)}</span>
            {#if cos < 0.8}
              <span class="text-red-400/60 text-[8px]">outlier</span>
            {:else if cos < 0.95}
              <span class="text-yellow-400/60 text-[8px]">deviant</span>
            {/if}
          </div>
        {/if}
        {#if meta}
          {@const px = meta.transform[0]}
          {@const originE = meta.transform[2]}
          {@const originN = meta.transform[5]}
          {@const chunkE = originE + selected.cj * meta.chunkShape[1] * px}
          {@const chunkN = originN - selected.ci * meta.chunkShape[0] * px}
          {@const chunkW = meta.chunkShape[1] * px}
          {@const chunkH = meta.chunkShape[0] * px}
          <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
            <span class="text-gray-500">CRS</span>
            <span class="text-gray-400">EPSG:{meta.epsg}</span>
            <span class="text-gray-500">Pixel</span>
            <span class="text-gray-400">{px}m, {meta.nBands} bands</span>
            <span class="text-gray-500">Shard</span>
            <span class="text-gray-400">{meta.chunkShape[1]}x{meta.chunkShape[0]} px ({(chunkW/1000).toFixed(1)}x{(chunkH/1000).toFixed(1)} km)</span>
            <span class="text-gray-500">UTM NW</span>
            <span class="text-gray-400 tabular-nums">{chunkE.toFixed(0)}, {chunkN.toFixed(0)}</span>
            <span class="text-gray-500">UTM SE</span>
            <span class="text-gray-400 tabular-nums">{(chunkE + chunkW).toFixed(0)}, {(chunkN - chunkH).toFixed(0)}</span>
            {#if src?.projection}
              {@const nw = src.projection.inverse(chunkE, chunkN)}
              {@const se = src.projection.inverse(chunkE + chunkW, chunkN - chunkH)}
              <span class="text-gray-500">Lon/Lat NW</span>
              <span class="text-gray-400 tabular-nums">{nw[0].toFixed(4)}, {nw[1].toFixed(4)}</span>
              <span class="text-gray-500">Lon/Lat SE</span>
              <span class="text-gray-400 tabular-nums">{se[0].toFixed(4)}, {se[1].toFixed(4)}</span>
            {/if}
            {#if meta.years && meta.years.length > 0}
              {@const latestT = meta.years.length - 1}
              {@const baseUrl = meta.url}
              <span class="text-gray-500">Shard URL</span>
              <span class="text-gray-400 text-[8px] break-all">
                <a href="{baseUrl}/embeddings/c/{latestT}/{selected.ci}/{selected.cj}"
                   target="_blank" class="text-term-cyan/60 hover:text-term-cyan underline">
                  c/{latestT}/{selected.ci}/{selected.cj}
                </a>
              </span>
            {/if}
          </div>

          <!-- Provenance (geoemb: convention) — compact -->
          {#if meta.geoemb_model || meta.geoemb_dataType}
            <div class="border-t border-gray-800/40 pt-1.5">
              <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
                {#if meta.geoemb_model}
                  <span class="text-gray-500">Model</span>
                  <a href={meta.geoemb_model} target="_blank"
                     class="text-term-cyan/60 hover:text-term-cyan">{meta.geoemb_modelName ?? meta.geoemb_model}</a>
                {/if}
                {#if meta.geoemb_dataType}
                  <span class="text-gray-500">Type</span>
                  <span class="text-gray-400">{meta.geoemb_dataType}{meta.geoemb_quantMethod ? ` / ${meta.geoemb_quantMethod}` : ''}</span>
                {/if}
                {#if meta.geoemb_buildVersion}
                  <span class="text-gray-500">Build</span>
                  <span class="text-gray-400">{meta.geoemb_buildVersion}</span>
                {/if}
                {#if meta.geoemb_sourceData}
                  <span class="text-gray-500">Source</span>
                  <span class="text-gray-400">
                    {#if Array.isArray(meta.geoemb_sourceData)}
                      {#each meta.geoemb_sourceData as url, i}
                        <a href={url} target="_blank" class="text-term-cyan/60 hover:text-term-cyan">[{i + 1}]</a>{' '}
                      {/each}
                    {:else}
                      <a href={meta.geoemb_sourceData} target="_blank" class="text-term-cyan/60 hover:text-term-cyan">[1]</a>
                    {/if}
                  </span>
                {/if}
              </div>
            </div>
          {/if}

          <!-- Per-tile stats + embedding fingerprint -->
          {#if tileStats}
            <div class="border-t border-gray-800/40 pt-1.5 space-y-1">
              <div class="text-[9px] text-gray-500 uppercase tracking-wider">Tile Stats</div>
              <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
                <span class="text-gray-500">Valid pixels</span>
                <span class="text-gray-400">{tileStats.validPixels.toLocaleString()}/{tileStats.totalPixels.toLocaleString()} ({(tileStats.validPixels / tileStats.totalPixels * 100).toFixed(0)}%)</span>
                <span class="text-gray-500">Norm range</span>
                <span class="text-gray-400 tabular-nums">{tileStats.minNorm.toFixed(1)} – {tileStats.maxNorm.toFixed(1)}</span>
                <span class="text-gray-500">Mean norm</span>
                <span class="text-gray-400 tabular-nums">{tileStats.meanNorm.toFixed(2)}</span>
                <span class="text-gray-500">Variance</span>
                <span class="text-gray-400 tabular-nums">{tileStats.variance.toFixed(1)}</span>
              </div>

              <!-- Animated fingerprint: tile mean + pixel overlay with morphing + sinusoidal waves -->
              <div class="text-[8px] text-gray-600 mt-1">
                {$explorerPixel ? 'Pixel vs tile' : 'Tile fingerprint'}
              </div>
              <canvas bind:this={fpCanvasEl} width="256" height="48"
                      class="w-full h-10 rounded" style="image-rendering: auto;"></canvas>
            </div>
          {:else if tileStatsLoading}
            <div class="text-[9px] text-gray-600 italic border-t border-gray-800/40 pt-1.5">
              <span class="inline-block w-2 h-2 border border-gray-500 border-t-term-cyan rounded-full animate-spin mr-1"></span>
              Fetching tile embeddings...
            </div>
          {/if}
        {:else}
          <div class="text-[9px] text-gray-500">Loading zone metadata...</div>
        {/if}

        <!-- Year availability bar -->
        {#if probeResults.size > 0}
          {@const sorted = [...probeResults.entries()].sort((a, b) => a[0] - b[0])}
          {@const found = sorted.filter(([,s]) => s === 'found').length}
          {@const pending = sorted.some(([,s]) => s === 'pending')}
          <div class="flex items-center gap-1.5 text-[9px]">
            <span class="text-gray-500 shrink-0">Years</span>
            <div class="flex flex-1 h-3.5 rounded overflow-hidden border border-gray-700/40">
              {#each sorted as [year, status]}
                {@const color = YEAR_COLORS[year] ?? '#888'}
                <div class="flex-1 flex items-center justify-center text-[7px] font-mono leading-none"
                     style="background: {status === 'found' ? color + '44' : 'transparent'};
                            color: {status === 'found' ? color : '#444'}"
                     title="{year}: {status}"
                >{String(year).slice(2)}</div>
              {/each}
            </div>
            <span class="text-gray-600 shrink-0 tabular-nums">{pending ? '...' : `${found}/${sorted.length}`}</span>
          </div>
        {:else if selected && selected.ci >= 0}
          <div class="text-[9px] text-gray-600 italic">Checking years...</div>
        {/if}

        <!-- Temporal analysis -->
        {#if selected && selected.ci >= 0}
          {#if temporalData.length > 1}
            {@const maxNorm = Math.max(...temporalData.map(d => d.norm))}
            {@const minNorm = Math.min(...temporalData.map(d => d.norm))}
            {@const normRange = maxNorm - minNorm || 1}
            {@const cosines = temporalData.slice(1).map((d, i) => {
              const prev = temporalData[i].embedding;
              const curr = d.embedding;
              let dot = 0, n1 = 0, n2 = 0;
              for (let b = 0; b < prev.length; b++) {
                dot += prev[b] * curr[b];
                n1 += prev[b] * prev[b];
                n2 += curr[b] * curr[b];
              }
              return dot / (Math.sqrt(n1) * Math.sqrt(n2) || 1);
            })}
            <div class="border-t border-gray-800/40 pt-1.5 space-y-1">
              <div class="text-[9px] text-gray-500 uppercase tracking-wider">Temporal</div>
              <!-- Norm sparkline -->
              <div class="text-[8px] text-gray-600">Embedding norm</div>
              <svg viewBox="0 0 200 40" class="w-full h-8">
                {#each temporalData as d, i}
                  {@const x = (i / (temporalData.length - 1)) * 180 + 10}
                  {@const y = 35 - ((d.norm - minNorm) / normRange) * 30}
                  {@const color = YEAR_COLORS[d.year] ?? '#888'}
                  <circle cx={x} cy={y} r="3" fill={color} opacity="0.9" />
                  {#if i > 0}
                    {@const px = ((i - 1) / (temporalData.length - 1)) * 180 + 10}
                    {@const py = 35 - ((temporalData[i-1].norm - minNorm) / normRange) * 30}
                    <line x1={px} y1={py} x2={x} y2={y} stroke={color} stroke-width="1.5" opacity="0.5" />
                  {/if}
                  <text x={x} y="38" text-anchor="middle" fill="#666" font-size="5">{String(d.year).slice(2)}</text>
                {/each}
              </svg>
              <div class="flex justify-between text-[8px] text-gray-600 tabular-nums">
                <span>{minNorm.toFixed(1)}</span>
                <span>{maxNorm.toFixed(1)}</span>
              </div>

              <!-- Cosine similarity between consecutive years -->
              <div class="text-[8px] text-gray-600 mt-1 flex items-center gap-1">
                Year-to-year similarity
                <span class="relative group cursor-help">
                  <span class="inline-flex items-center justify-center w-3 h-3 rounded-full border border-gray-600 text-[6px] text-gray-500">?</span>
                  <span class="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-44 p-1.5 bg-gray-900 border border-gray-700 rounded text-[8px] text-gray-400 leading-snug hidden group-hover:block z-50 shadow-lg">
                    Cosine similarity measures how similar two embedding vectors are regardless of magnitude.
                    <strong class="text-gray-300">1.0</strong> = identical direction,
                    <strong class="text-green-400">&gt;0.95</strong> = stable (green),
                    <strong class="text-yellow-400">&gt;0.80</strong> = moderate change (yellow),
                    <strong class="text-red-400">&lt;0.80</strong> = significant change (red) — likely land cover change.
                  </span>
                </span>
              </div>
              <svg viewBox="0 0 200 30" class="w-full h-6">
                {#each cosines as cos, i}
                  {@const x = ((i + 0.5) / cosines.length) * 180 + 10}
                  {@const barH = Math.max(1, cos * 25)}
                  {@const hue = cos > 0.95 ? 120 : cos > 0.8 ? 60 : 0}
                  <rect x={x - 6} y={25 - barH} width="12" height={barH}
                        fill="hsl({hue}, 70%, 50%)" opacity="0.7" rx="1" />
                  <text x={x} y="29" text-anchor="middle" fill="#666" font-size="4.5">
                    {cos.toFixed(2)}
                  </text>
                {/each}
              </svg>
            </div>
          {:else if temporalLoading}
            <div class="text-[9px] text-gray-600 italic border-t border-gray-800/40 pt-1.5">
              Loading temporal data...
            </div>
          {:else if temporalData.length === 0 && !temporalLoading}
            <button
              onclick={fetchTemporalData}
              class="w-full text-[9px] text-gray-500 hover:text-term-cyan border border-gray-700/60
                     hover:border-term-cyan/40 px-2 py-1.5 rounded transition-all mt-1"
            >
              Compare across years
            </button>
          {/if}
        {/if}
      </div>
    {/if}
    </div>

    {#if selected && hasDepths}
      <div class="w-[340px] shrink-0 space-y-3">
        <TileTimelapse />
        <MatryoshkaPanel />
      </div>
    {/if}
  </div>
</FloatingWindow>
