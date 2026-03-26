<script lang="ts">
  import { sourceManager } from '../stores/zarr';
  import { explorerHover, YEAR_COLORS } from '../stores/zarr-explorer';
  import { get } from 'svelte/store';

  // Year probe state
  let probeResults = $state<Map<number, 'pending' | 'found' | 'missing'>>(new Map());
  let probeGen = 0;
  let probing = $state(false);

  // Temporal analysis state
  type YearData = { year: number; norm: number; embedding: Float32Array };
  let temporalData = $state<YearData[]>([]);
  let temporalLoading = $state(false);
  let temporalGen = 0;

  async function fetchTemporalData() {
    const hover = get(explorerHover);
    if (!hover || hover.ci < 0) return;
    const myGen = ++temporalGen;
    temporalLoading = true;
    temporalData = [];

    const mgr = get(sourceManager);
    if (!mgr) { temporalLoading = false; return; }

    let src = mgr.getOpenSource(hover.zoneId);
    if (!src) {
      try { src = await mgr.getSource(hover.zoneId); } catch { temporalLoading = false; return; }
    }
    const meta = src.metadata;
    if (!meta?.years?.length || meta.version !== 'v2') { temporalLoading = false; return; }

    const store = (src as unknown as { store: { embArr: unknown; scalesArr: unknown } }).store;
    if (!store) { temporalLoading = false; return; }

    // Pixel at top-left of shard + 100 pixels in (avoid edge/water pixels)
    const r0 = hover.ci * meta.chunkShape[0] + 100;
    const c0 = hover.cj * meta.chunkShape[1] + 100;
    const T = meta.years.length;
    const nBands = meta.nBands;

    try {
      const { fetchRegion } = await import('@ucam-eo/tessera');
      if (myGen !== temporalGen) return;

      // Fetch all years at once: embeddings[0:T, :, r0:r0+1, c0:c0+1] and scales[0:T, r0:r0+1, c0:c0+1]
      const [embView, scaleView] = await Promise.all([
        fetchRegion(store.embArr as Parameters<typeof fetchRegion>[0], [null, null, [r0, r0 + 1], [c0, c0 + 1]]),
        fetchRegion(store.scalesArr as Parameters<typeof fetchRegion>[0], [null, [r0, r0 + 1], [c0, c0 + 1]]),
      ]);
      if (myGen !== temporalGen) return;

      const scales = new Float32Array(scaleView.data.buffer, scaleView.data.byteOffset, T);
      const int8All = new Int8Array(embView.data.buffer, embView.data.byteOffset, T * nBands);

      const results: YearData[] = [];
      for (let t = 0; t < T; t++) {
        const scale = scales[t];
        if (!isFinite(scale) || scale === 0) continue;
        const emb = new Float32Array(nBands);
        let normSq = 0;
        for (let b = 0; b < nBands; b++) {
          emb[b] = int8All[t * nBands + b] * scale;
          normSq += emb[b] * emb[b];
        }
        results.push({ year: meta.years[t], norm: Math.sqrt(normSq), embedding: emb });
      }
      temporalData = results;
    } catch { /* fetch failed */ }

    if (myGen === temporalGen) temporalLoading = false;
  }

  async function probeSelectedShard() {
    const hover = get(explorerHover);
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
  }

  // Auto-probe after a brief pause when selection changes; cancel on new click
  let probeTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const hover = $explorerHover;
    // Cancel any pending probe
    clearTimeout(probeTimer);
    probeResults = new Map();
    probeGen++;
    probing = false;

    // Reset temporal data
    temporalData = [];
    temporalGen++;
    temporalLoading = false;

    // Start a new probe after 300ms if a valid shard is selected
    if (hover && hover.ci >= 0) {
      probeTimer = setTimeout(() => probeSelectedShard(), 300);
    }

    return () => clearTimeout(probeTimer);
  });

  const selected = $derived($explorerHover);
</script>

<div class="space-y-3" data-tutorial="explorer-panel">
  {#if !selected}
    <div class="text-[10px] text-gray-500">
      Click on the map to inspect a shard.
    </div>
  {/if}

  <!-- Selected shard info -->
  {#if selected}
    {@const mgr = $sourceManager}
    {@const src = mgr?.getOpenSource(selected.zoneId)}
    {@const meta = src?.metadata}
    <div class="bg-gray-900/80 border border-term-cyan/30 rounded px-2.5 py-2 space-y-1.5">
      <div class="text-[10px] text-gray-300 font-medium">
        {selected.zoneId}
        <span class="text-gray-500 font-normal">shard [{selected.ci}, {selected.cj}]</span>
      </div>
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
          <span class="text-gray-500">Pixel size</span>
          <span class="text-gray-400">{px}m</span>
          <span class="text-gray-500">Bands</span>
          <span class="text-gray-400">{meta.nBands}</span>
          <span class="text-gray-500">Shard</span>
          <span class="text-gray-400">{meta.chunkShape[1]}×{meta.chunkShape[0]} px ({(chunkW/1000).toFixed(1)}×{(chunkH/1000).toFixed(1)} km)</span>
          <span class="text-gray-500">UTM NW</span>
          <span class="text-gray-400 tabular-nums">{chunkE.toFixed(0)}, {chunkN.toFixed(0)}</span>
          <span class="text-gray-500">UTM SE</span>
          <span class="text-gray-400 tabular-nums">{(chunkE + chunkW).toFixed(0)}, {(chunkN - chunkH).toFixed(0)}</span>
          {#if src?.projection}
            {@const nw = src.projection.inverse(chunkE, chunkN)}
            {@const se = src.projection.inverse(chunkE + chunkW, chunkN - chunkH)}
            <span class="text-gray-500">Lon/Lat NW</span>
            <span class="text-gray-400 tabular-nums">{nw[0].toFixed(4)}°, {nw[1].toFixed(4)}°</span>
            <span class="text-gray-500">Lon/Lat SE</span>
            <span class="text-gray-400 tabular-nums">{se[0].toFixed(4)}°, {se[1].toFixed(4)}°</span>
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
      {:else}
        <div class="text-[9px] text-gray-500">Loading zone metadata...</div>
      {/if}

      <!-- Year verification (auto-probes after 300ms) -->
      {#if probeResults.size > 0}
        <div class="text-[9px] text-gray-500 uppercase tracking-wider">Years</div>
        <div class="flex flex-wrap gap-1">
          {#each [...probeResults.entries()] as [year, status]}
            {@const color = YEAR_COLORS[year] ?? '#888'}
            <span class="text-[9px] px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                  style="background: {status === 'found' ? color + '22' : 'transparent'};
                         color: {status === 'found' ? color : status === 'pending' ? '#666' : '#444'};
                         {status === 'missing' ? 'text-decoration: line-through;' : ''}
                         border: 1px solid {status === 'found' ? color + '44' : status === 'pending' ? '#333' : '#222'}">
              {#if status === 'pending'}
                <span class="inline-block w-1.5 h-1.5 border border-gray-500 border-t-gray-300 rounded-full animate-spin"></span>
              {/if}
              {year}
            </span>
          {/each}
        </div>
        {@const found = [...probeResults.values()].filter(s => s === 'found').length}
        {@const total = probeResults.size}
        {@const pending = [...probeResults.values()].filter(s => s === 'pending').length}
        {#if pending === 0}
          <div class="text-[9px] text-gray-500">{found}/{total} years have data</div>
        {/if}
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
