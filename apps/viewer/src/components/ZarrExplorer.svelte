<script lang="ts">
  import { untrack } from 'svelte';
  import { sourceManager } from '../stores/zarr';
  import { zones } from '../stores/stac';
  import { explorerGrid, explorerVisible, explorerHover, YEAR_COLORS } from '../stores/zarr-explorer';
  import { mapInstance } from '../stores/map';
  import { get } from 'svelte/store';
  import type { Feature } from 'geojson';

  let featureCount = $state(0);
  let overflow = $state(false);
  let gridError = $state<string | null>(null);
  let selectedZoneShards = $state(0);

  const MAX_FEATURES = 5000;
  let gen = 0;

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
    selectedZoneShards = 0;
  });

  /**
   * Build the zone boundary grid from zone descriptors (instant, no HTTP).
   * Each zone's WGS84 bbox becomes a polygon feature.
   */
  function buildZoneGrid(hoverOverride?: { zoneId: string; ci: number; cj: number } | null) {
    const myGen = ++gen;
    const map = get(mapInstance);
    const allZones = get(zones);
    if (!map || !allZones.length) return;

    const bounds = map.getBounds();
    const vW = bounds.getWest(), vE = bounds.getEast();
    const vS = bounds.getSouth(), vN = bounds.getNorth();
    const features: Feature[] = [];

    for (const zone of allZones) {
      const [zW, zS, zE, zN] = zone.bbox;
      if (zE < vW || zW > vE || zN < vS || zS > vN) continue;
      if (features.length >= MAX_FEATURES) { overflow = true; break; }

      features.push({
        type: 'Feature',
        properties: { zone: zone.id, utmZone: zone.utmZone, kind: 'zone' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[zW, zS], [zE, zS], [zE, zN], [zW, zN], [zW, zS]]],
        },
      });
    }

    // Also add shard grid for any zone that has been opened + selected
    const mgr = get(sourceManager);
    const hover = hoverOverride !== undefined ? hoverOverride : get(explorerHover);
    console.log(`[explorer] buildZoneGrid: ${features.length} zones, hover=${hover?.zoneId ?? 'none'}, mgr=${!!mgr}`);
    if (mgr && hover) {
      const src = mgr.getOpenSource(hover.zoneId);
      console.log(`[explorer] hover zone=${hover.zoneId}, src open=${!!src}, meta=${!!src?.metadata}`);
      if (src) {
        const meta = src.metadata;
        const proj = src.projection;
        if (meta && proj) {
          const [H, W] = meta.shape;
          const [shardH, shardW] = meta.chunkShape;
          const nRows = Math.ceil(H / shardH);
          const nCols = Math.ceil(W / shardW);
          const t = meta.transform;
          const px = t[0];
          const originE = t[2];
          const originN = t[5];
          const shardM = shardH * px;

          // Only show shards in viewport
          const utmCorners = [
            proj.forward(Math.max(vW, meta.transform[2] > 0 ? vW : vW), Math.max(vS, -80)),
            proj.forward(Math.min(vE, 180), Math.min(vN, 84)),
          ];
          // Simple approach: iterate visible shards
          const clampLng = (v: number) => {
            const zone = get(zones).find(z => z.id === hover.zoneId);
            if (!zone) return v;
            return Math.max(zone.bbox[0], Math.min(zone.bbox[2], v));
          };
          const clampLat = (v: number) => {
            const zone = get(zones).find(z => z.id === hover.zoneId);
            if (!zone) return v;
            return Math.max(zone.bbox[1], Math.min(zone.bbox[3], v));
          };
          const uc = [
            proj.forward(clampLng(vW), clampLat(vN)),
            proj.forward(clampLng(vE), clampLat(vN)),
            proj.forward(clampLng(vW), clampLat(vS)),
            proj.forward(clampLng(vE), clampLat(vS)),
          ];
          const minE = Math.min(...uc.map(c => c[0]));
          const maxE = Math.max(...uc.map(c => c[0]));
          const minN = Math.min(...uc.map(c => c[1]));
          const maxN = Math.max(...uc.map(c => c[1]));

          const cjMin = Math.max(0, Math.floor((minE - originE) / shardM));
          const cjMax = Math.min(nCols - 1, Math.floor((maxE - originE) / shardM));
          const ciMin = Math.max(0, Math.floor((originN - maxN) / shardM));
          const ciMax = Math.min(nRows - 1, Math.floor((originN - minN) / shardM));

          let shardCount = 0;
          for (let ci = ciMin; ci <= ciMax; ci++) {
            for (let cj = cjMin; cj <= cjMax; cj++) {
              if (features.length >= MAX_FEATURES) break;
              const corners = src.getChunkBoundsLngLat(ci, cj);
              if (!corners) continue;
              features.push({
                type: 'Feature',
                properties: { zone: hover.zoneId, ci, cj, kind: 'shard' },
                geometry: {
                  type: 'Polygon',
                  coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
                },
              });
              shardCount++;
            }
          }
          selectedZoneShards = shardCount;
        }
      }
    }

    if (myGen !== gen) return;
    featureCount = features.length;
    explorerGrid.set({ type: 'FeatureCollection', features });
    explorerVisible.set(true);
  }

  // Build grid on activation and on map move
  $effect(() => {
    const _zones = $zones;
    const _mgr = $sourceManager;
    const map = $mapInstance;
    const hover = $explorerHover;  // rebuild when selection changes
    if (!map) return;

    untrack(() => buildZoneGrid(hover));

    let debounceTimer: ReturnType<typeof setTimeout>;
    const handler = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => buildZoneGrid(), 150);
    };
    map.on('moveend', handler);
    return () => {
      clearTimeout(debounceTimer);
      map.off('moveend', handler);
      explorerVisible.set(false);
      explorerGrid.set({ type: 'FeatureCollection', features: [] });
    };
  });

  const selected = $derived($explorerHover);

  const yearEntries = $derived(
    Object.entries(YEAR_COLORS).map(([y, c]) => ({ year: Number(y), color: c }))
  );
</script>

<div class="space-y-3" data-tutorial="explorer-panel">
  <div class="text-[10px] text-gray-500">
    Click a zone to load its shard grid. Click a shard for details.
  </div>

  {#if gridError}
    <div class="text-[9px] text-red-400 break-all">{gridError}</div>
  {/if}

  {#if featureCount > 0}
    <div class="text-[10px] text-gray-400">
      <span class="text-gray-300 font-bold">{featureCount}</span> feature{featureCount !== 1 ? 's' : ''} in view
      {#if selectedZoneShards > 0}
        <span class="text-gray-500">({selectedZoneShards} shards)</span>
      {/if}
    </div>
  {/if}

  {#if overflow}
    <div class="text-[9px] text-yellow-500/80">Zoom in to see all features</div>
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
  {:else if featureCount > 0}
    <div class="text-[9px] text-gray-600 italic">Click a zone boundary to explore</div>
  {/if}
</div>
