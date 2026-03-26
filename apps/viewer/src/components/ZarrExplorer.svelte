<script lang="ts">
  import { sourceManager } from '../stores/zarr';
  import { explorerHover, YEAR_COLORS } from '../stores/zarr-explorer';
  import { get } from 'svelte/store';

  // Year probe state
  let probeResults = $state<Map<number, 'pending' | 'found' | 'missing'>>(new Map());
  let probeGen = 0;
  let probing = $state(false);

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

  $effect(() => {
    const _hover = $explorerHover;
    probeResults = new Map();
    probeGen++;
    probing = false;
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

      <!-- Year verification -->
      {#if probeResults.size > 0}
        <div class="text-[9px] text-gray-500 uppercase tracking-wider">Years (verified)</div>
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
      {:else}
        <button
          onclick={probeSelectedShard}
          disabled={probing}
          class="text-[9px] text-gray-500 hover:text-term-cyan border border-gray-700/60
                 hover:border-term-cyan/40 px-2 py-1 rounded transition-all
                 disabled:opacity-40 disabled:pointer-events-none"
        >
          {probing ? 'Checking...' : 'Verify years'}
        </button>
      {/if}
    </div>
  {/if}
</div>
