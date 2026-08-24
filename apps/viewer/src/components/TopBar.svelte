<script lang="ts">
  import {
    Search, Crosshair, BoxSelect, Pentagon, Save, FolderOpen, User,
    X, Trash2, Upload, Download, Tags, Scan, ChevronDown, Layers,
  } from 'lucide-svelte';
  import { catalogStatus, catalogUrl, availableYears, activeYear, switchYear, loadCatalog, DATASET_VERSIONS } from '../stores/stac';
  import { metadata, loading, networkActivity } from '../stores/zarr';
  import { mapInstance } from '../stores/map';
  import { get } from 'svelte/store';
  import { roiDrawing, drawMode, roiRegions, roiLoading, roiTileCount, clearAllRegions, removeRegion, addRegion, upgradeRegions, type DrawMode } from '../stores/drawing';
  import { availableDepths, loadDepth, loadedDepth, fullDepth, upgradeState, estimateBytes, formatBytes } from '../stores/depth';
  import { activeTool, type ToolId } from '../stores/tools';
  import { simSelectedPixel } from '../stores/similarity';
  import { displayManager } from '../stores/zarr';
  import { activeClass } from '../stores/classifier';
  import TutorialDropdown from './TutorialDropdown.svelte';
  import { welcomeJustDismissed } from '../stores/welcome';

  interface Props {
    onOpenCatalog: () => void;
  }

  let { onOpenCatalog }: Props = $props();

  // --- Health / network activity indicator ---
  // A hard failure outranks a retry, which outranks routine traffic. Only the
  // colour and a soft pulse change; the dot never changes size, so sustained
  // tile loading stays quiet in the corner of the eye.
  const health = $derived(
    $catalogStatus === 'error' ? 'error'
    : $catalogStatus === 'loading' ? 'catalog'
    : $networkActivity.retrying > 0 ? 'retrying'
    : $networkActivity.inflight > 0 ? 'active'
    : $catalogStatus === 'loaded' ? 'idle'
    : 'unknown'
  );

  const healthColor = $derived({
    error:    'bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.6)]',
    catalog:  'bg-yellow-400 shadow-[0_0_4px_rgba(250,204,21,0.6)]',
    retrying: 'bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.7)] net-pulse',
    active:   'bg-term-cyan shadow-[0_0_4px_rgba(0,229,255,0.6)] net-pulse',
    idle:     'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.6)]',
    unknown:  'bg-gray-500',
  }[health]);

  const plural = (n: number) => (n === 1 ? '' : 's');
  const healthTitle = $derived({
    error:    'Catalog unavailable',
    catalog:  'Loading catalog…',
    retrying: `Retrying ${$networkActivity.retrying} request${plural($networkActivity.retrying)} — connection unstable`,
    active:   `Loading ${$networkActivity.inflight} request${plural($networkActivity.inflight)}`,
    idle:     'Dataset version — idle',
    unknown:  'Dataset version',
  }[health]);

  // --- Search ---
  interface NominatimResult {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    boundingbox: [string, string, string, string];
    type: string;
    class: string;
  }

  let searchQuery = $state('');
  let searchResults = $state<NominatimResult[]>([]);
  let searchOpen = $state(false);
  let searchLoading = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let searchInputEl = $state<HTMLInputElement>(undefined!);
  let locating = $state(false);
  let searchExpanded = $state(false);

  function tryParseCoords(q: string): [number, number] | null {
    const s = q.trim();
    const simple = s.match(/^([+-]?\d+\.?\d*)\s*[,\s]\s*([+-]?\d+\.?\d*)$/);
    if (simple) {
      const lat = parseFloat(simple[1]), lon = parseFloat(simple[2]);
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return [lat, lon];
    }
    const nsew = s.match(/^([NSEW])\s*(\d+\.?\d*)\s*[,\s]\s*([NSEW])\s*(\d+\.?\d*)$/i)
              || s.match(/^(\d+\.?\d*)\s*([NSEW])\s*[,\s]\s*(\d+\.?\d*)\s*([NSEW])$/i);
    if (nsew) {
      let lat: number, lon: number;
      if (/[NSns]/i.test(nsew[1])) {
        lat = parseFloat(nsew[2]) * (/[Ss]/.test(nsew[1]) ? -1 : 1);
        lon = parseFloat(nsew[4]) * (/[Ww]/.test(nsew[3]) ? -1 : 1);
      } else {
        lat = parseFloat(nsew[1]) * (/[Ss]/.test(nsew[2]) ? -1 : 1);
        lon = parseFloat(nsew[3]) * (/[Ww]/.test(nsew[4]) ? -1 : 1);
      }
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return [lat, lon];
    }
    return null;
  }

  function flyToCoords(lat: number, lon: number) {
    const map = get(mapInstance);
    if (!map) return;
    map.flyTo({ center: [lon, lat], zoom: 14, duration: 1500 });
    searchQuery = '';
    searchResults = [];
    searchOpen = false;
  }

  function debounceSearch(q: string) {
    clearTimeout(debounceTimer);
    if (q.trim().length < 2) {
      searchResults = [];
      searchOpen = false;
      return;
    }
    const coords = tryParseCoords(q.trim());
    if (coords) {
      searchResults = [{
        place_id: -1,
        display_name: `${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}`,
        lat: String(coords[0]),
        lon: String(coords[1]),
        boundingbox: [String(coords[0] - 0.01), String(coords[0] + 0.01), String(coords[1] - 0.01), String(coords[1] + 0.01)],
        type: 'coordinate',
        class: 'coordinate',
      }];
      searchOpen = true;
      return;
    }
    debounceTimer = setTimeout(() => fetchResults(q.trim()), 300);
  }

  async function fetchResults(q: string) {
    searchLoading = true;
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const data: NominatimResult[] = await res.json();
      searchResults = data;
      searchOpen = data.length > 0;
    } catch {
      searchResults = [];
      searchOpen = false;
    } finally {
      searchLoading = false;
    }
  }

  function selectResult(r: NominatimResult) {
    const map = get(mapInstance);
    if (!map) return;
    const [south, north, west, east] = r.boundingbox.map(Number);
    map.fitBounds([[west, south], [east, north]], { padding: 40, maxZoom: 16, duration: 1500 });
    searchQuery = '';
    searchResults = [];
    searchOpen = false;
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      searchQuery = '';
      searchResults = [];
      searchOpen = false;
      searchInputEl?.blur();
    } else if (e.key === 'Enter') {
      const coords = tryParseCoords(searchQuery.trim());
      if (coords) {
        flyToCoords(coords[0], coords[1]);
      } else if (searchResults.length > 0) {
        selectResult(searchResults[0]);
      }
    }
  }

  function closeSearch() { searchOpen = false; }

  function gotoCurrentLocation() {
    if (!navigator.geolocation) return;
    locating = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const map = get(mapInstance);
        if (map) map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 14, duration: 1500 });
        locating = false;
      },
      () => { locating = false; },
      { timeout: 10000 },
    );
  }

  function formatResult(name: string): string {
    const parts = name.split(', ');
    if (parts.length <= 3) return name;
    return `${parts[0]}, ${parts[1]}, ${parts[parts.length - 1]}`;
  }

  // --- Drawing ---
  function toggleDraw(mode: DrawMode) {
    if ($roiDrawing && $drawMode === mode) {
      $roiDrawing = false;
    } else {
      $drawMode = mode;
      $roiDrawing = true;
    }
  }

  // --- Year dropdown ---
  let yearDropdownOpen = $state(false);

  // --- Dataset version dropdown ---
  let versionDropdownOpen = $state(false);

  // Tile progress overlay. `loading.total === 0` means "nothing to show" —
  // stores/zarr.ts clears it on completion, on a stall, and on dataset or
  // year switch, so this never strands a stale count on screen.
  const showTileProgress = $derived(
    $metadata !== null && $loading.total > 0 && !versionDropdownOpen && !yearDropdownOpen
  );
  const tileProgressPct = $derived(
    $loading.total > 0 ? Math.min(100, ($loading.done / $loading.total) * 100) : 0
  );
  const activeVersion = $derived(DATASET_VERSIONS.find(v => v.url === $catalogUrl));
  const activeVersionLabel = $derived(activeVersion?.label ?? 'Custom');

  // --- Regions dropdown ---
  let regionsOpen = $state(false);
  let upgrading = $state(false);

  /** Whether the loaded data is narrower than the store offers.
   *  Keyed on the width actually in memory, the same fact upgradeRegions
   *  acts on, so the button cannot offer an upgrade that would no-op. */
  const canUpgrade = $derived(
    $roiRegions.length > 0 && !!$loadedDepth && !!$fullDepth && $loadedDepth < $fullDepth,
  );

  /** Decoded size of re-reading every shallow region at full depth. */
  const upgradeBytes = $derived.by(() => {
    const cs = $metadata?.chunkShape;
    if (!cs || !$fullDepth) return 0;
    const tiles = $roiRegions.reduce((n, r) => n + r.chunkKeys.length, 0);
    return estimateBytes(tiles, cs[0], cs[1], $fullDepth);
  });

  async function runUpgrade() {
    upgrading = true;
    try { await upgradeRegions(); } finally { upgrading = false; }
  }
  let fileInput: HTMLInputElement;

  function featureBbox(feature: GeoJSON.Feature): string {
    const coords = (feature.geometry as GeoJSON.Polygon).coordinates[0];
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lng, lat] of coords) {
      if (lng < w) w = lng; if (lng > e) e = lng;
      if (lat < s) s = lat; if (lat > n) n = lat;
    }
    return `${w.toFixed(3)}, ${s.toFixed(3)} \u2192 ${e.toFixed(3)}, ${n.toFixed(3)}`;
  }

  function exportGeoJSON() {
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: $roiRegions.map(r => r.feature),
    };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'regions.geojson';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleFileImport(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const features: GeoJSON.Feature[] = [];
      if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
        features.push(...data.features);
      } else if (data.type === 'Feature') {
        features.push(data);
      }
      for (const f of features) {
        if (f.geometry?.type === 'Polygon') await addRegion(f);
      }
    } catch { /* Invalid file */ }
    (e.target as HTMLInputElement).value = '';
  }

  function flyToRegion(feature: GeoJSON.Feature) {
    const map = get(mapInstance);
    if (!map) return;
    const coords = (feature.geometry as GeoJSON.Polygon).coordinates[0];
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lng, lat] of coords) {
      if (lng < w) w = lng; if (lng > e) e = lng;
      if (lat < s) s = lat; if (lat > n) n = lat;
    }
    map.fitBounds([[w, s], [e, n]], { padding: 60, duration: 1200 });
  }

  // --- Tool tabs ---
  const tools: { id: ToolId; label: string; icon: typeof Search }[] = [
    { id: 'explorer',   label: 'Explorer', icon: Layers },
    { id: 'similarity', label: 'Similar', icon: Search },
    { id: 'classifier', label: 'Classify', icon: Tags },
    { id: 'segmenter',  label: 'Segment', icon: Scan },
  ];

  // --- Contextual status ---
  const status = $derived.by(() => {
    if ($catalogStatus !== 'loaded') return { text: 'Connect to catalog', color: 'text-gray-600' };
    if ($roiDrawing) {
      const hint = $drawMode === 'polygon' ? 'Click to draw polygon' : 'Drag to draw rectangle';
      return { text: hint, color: 'text-term-cyan animate-pulse' };
    }
    if ($upgradeState.kind === 'error') {
      return { text: `Upgrade failed: ${$upgradeState.message}`, color: 'text-red-400' };
    }
    if ($upgradeState.kind === 'done') {
      return {
        text: `Upgraded ${$upgradeState.tiles} tiles to d${$upgradeState.depth}`,
        color: 'text-term-cyan',
      };
    }
    if ($roiLoading) {
      const at = $loadDepth ? ` at d${$loadDepth}` : '';
      // total is 0 until the chunk lookup finishes.
      const count = $roiLoading.total > 0 ? ` ${$roiLoading.loaded}/${$roiLoading.total}` : '';
      return { text: `Loading${count}${at}`, color: 'text-term-cyan' };
    }
    if ($roiTileCount === 0) return { text: 'Draw a region to load embeddings', color: 'text-gray-500' };
    if ($loadedDepth && $availableDepths.length > 1) {
      const full = $loadedDepth === $fullDepth;
      return {
        text: `${$roiTileCount} tiles at d${$loadedDepth}${full ? '' : ' — upgradeable'}`,
        color: full ? 'text-gray-400' : 'text-amber-400/80',
      };
    }
    if ($activeTool === 'similarity') {
      return $simSelectedPixel
        ? { text: 'Similarity search active', color: 'text-purple-400' }
        : { text: 'Click pixel to search', color: 'text-gray-400' };
    }
    if ($activeTool === 'classifier') {
      return $activeClass
        ? { text: `Labeling: ${$activeClass.name}`, color: 'text-gray-300' }
        : { text: 'Add classes to label', color: 'text-gray-400' };
    }
    return { text: 'Ready to detect', color: 'text-gray-400' };
  });
</script>

<input bind:this={fileInput} type="file" accept=".geojson,.json" class="hidden" onchange={handleFileImport} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="absolute top-0 left-0 right-0 h-9 z-20
            bg-black/85 backdrop-blur-xl border-b border-gray-800/60
            flex items-center px-2 sm:px-3 gap-1 sm:gap-2 font-mono text-xs select-none">

  <!-- TZE branding -->
  <div class="flex items-center gap-1.5 shrink-0">
    <div class="w-2 h-2 rounded-full bg-term-cyan shadow-[0_0_6px_rgba(0,229,255,0.6)]"></div>
    <span class="text-term-cyan text-[11px] font-bold tracking-[0.2em] uppercase hidden sm:inline">TZE</span>
  </div>

  <!-- Tutorial dropdown (desktop) -->
  <div class="hidden sm:block" class:welcome-pulse={$welcomeJustDismissed}><TutorialDropdown /></div>

  <div class="w-px h-4 bg-gray-700/40 hidden sm:block"></div>

  <!-- Drawing tools -->
  <div class="flex items-center gap-0.5">
    {#each [
      { mode: 'rectangle' as DrawMode, icon: BoxSelect, tip: 'Rectangle' },
      { mode: 'polygon' as DrawMode, icon: Pentagon, tip: 'Polygon' },
    ] as tool}
      {@const isActive = $roiDrawing && $drawMode === tool.mode}
      {@const isSelected = $drawMode === tool.mode && !$roiDrawing}
      <button
        onclick={() => toggleDraw(tool.mode)}
        class="flex items-center justify-center w-7 h-7 rounded
               border transition-all
               {isActive
                 ? 'text-term-cyan border-term-cyan/60 bg-term-cyan/10 shadow-[0_0_6px_rgba(0,229,255,0.15)]'
                 : isSelected
                   ? 'text-term-cyan/50 border-term-cyan/25 bg-term-cyan/5'
                   : 'text-gray-300 border-gray-600 hover:text-white hover:border-gray-400 hover:bg-gray-800/50'}"
        title={tool.tip}
      >
        <tool.icon size={15} />
      </button>
    {/each}
  </div>

  <div class="w-px h-4 bg-gray-700/40"></div>

  <!-- Task tabs -->
  <div class="flex items-center gap-0.5" data-tutorial="tool-switcher">
    {#each tools as tool}
      <button
        onclick={() => {
          if (tool.id !== 'similarity') $displayManager?.clearSimilarityOverlay();
          $activeTool = tool.id;
        }}
        class="flex items-center gap-1 px-1.5 h-6 rounded text-[10px]
               border transition-all
               {$activeTool === tool.id
                 ? 'text-term-cyan border-term-cyan/40 bg-term-cyan/5'
                 : 'text-gray-600 border-transparent hover:text-gray-400'}
               {$welcomeJustDismissed ? 'welcome-pulse' : ''}"
      >
        <tool.icon size={11} />
        <span class="hidden md:inline">{tool.label}</span>
      </button>
    {/each}
  </div>

  <!-- Status (spacer) -->
  <div class="flex-1 flex items-center justify-center min-w-0 gap-2">
    <span class="text-[10px] truncate {status.color}">{status.text}</span>
    {#if $roiLoading}
      <div class="w-12 h-1 bg-gray-800 rounded-full overflow-hidden shrink-0">
        <div class="h-full bg-term-cyan/70 rounded-full transition-all"
          class:animate-pulse={$roiLoading.total === 0}
          style="width: {$roiLoading.total > 0 ? ($roiLoading.loaded / $roiLoading.total) * 100 : 100}%"></div>
      </div>
    {/if}
  </div>

  <!-- Search -->
  <div class="relative flex items-center gap-0.5" data-tutorial="search-bar">
    <button
      class="sm:hidden flex items-center justify-center w-6 h-6 rounded
             border border-gray-700/60 bg-gray-900/80
             text-gray-500 hover:text-term-cyan hover:border-term-cyan/50 transition-colors"
      onclick={() => { searchExpanded = !searchExpanded; if (searchExpanded) setTimeout(() => searchInputEl?.focus(), 50); }}
      title="Search"
    >
      <Search size={12} />
    </button>
    <div class="relative {searchExpanded ? 'flex' : 'hidden'} sm:flex items-center">
      <Search size={11} class="absolute left-1.5 text-gray-500 pointer-events-none" />
      <input
        bind:this={searchInputEl}
        bind:value={searchQuery}
        oninput={() => debounceSearch(searchQuery)}
        onkeydown={handleSearchKeydown}
        onfocus={() => { if (searchResults.length > 0) searchOpen = true; }}
        onblur={() => { if (!searchQuery) searchExpanded = false; }}
        type="text"
        placeholder="Search or lat, lon..."
        class="w-[140px] sm:w-[180px] h-6 pl-6 pr-2 rounded
               bg-gray-900/90 border border-gray-600/50
               text-[11px] text-gray-200 placeholder-gray-500
               focus:border-term-cyan/60 focus:outline-none focus:ring-0
               focus:shadow-[0_0_8px_rgba(0,229,255,0.15)]
               transition-colors font-mono"
      />
      {#if searchLoading}
        <div class="absolute right-1.5 w-3 h-3 border border-term-cyan/40 border-t-term-cyan rounded-full animate-spin"></div>
      {/if}
    </div>

    <button
      onclick={gotoCurrentLocation}
      disabled={locating}
      class="hidden sm:flex items-center justify-center w-6 h-6 rounded
             border border-gray-700/60 bg-gray-900/80
             text-term-cyan/60 hover:text-term-cyan hover:border-term-cyan/50
             disabled:opacity-40 transition-colors"
      title="Go to current location"
    >
      <Crosshair size={12} class={locating ? 'animate-pulse' : ''} />
    </button>

    {#if searchOpen}
      <button type="button" class="fixed inset-0 z-30 cursor-default" tabindex="-1" aria-label="Close search" onclick={closeSearch}></button>
      <div class="absolute top-full right-0 mt-1 z-40
                  bg-gray-950 border border-gray-700/80 rounded shadow-xl
                  min-w-[240px] py-1">
        {#each searchResults as result}
          <button
            onclick={() => result.class === 'coordinate'
              ? flyToCoords(parseFloat(result.lat), parseFloat(result.lon))
              : selectResult(result)}
            class="flex items-center gap-2 w-full text-left px-3 py-1.5
                   text-[11px] text-gray-400 hover:text-gray-200 hover:bg-gray-800/50
                   transition-colors"
          >
            {#if result.class === 'coordinate'}
              <Crosshair size={11} class="shrink-0 text-term-cyan/60" />
              <span class="text-term-cyan/80">Jump to {result.display_name}</span>
            {:else}
              <span class="truncate">{formatResult(result.display_name)}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Regions dropdown -->
  <div class="relative">
    <button
      onclick={() => { regionsOpen = !regionsOpen; }}
      class="flex items-center gap-1 px-1.5 h-6 rounded text-[10px]
             border border-gray-700/60 transition-all
             {$roiRegions.length > 0
               ? 'text-gray-300 hover:border-gray-500'
               : 'text-gray-600 hover:text-gray-400 hover:border-gray-600'}"
    >
      {#if $roiRegions.length > 0}
        <span class="tabular-nums">{$roiRegions.length}</span>
        <span class="hidden sm:inline">region{$roiRegions.length !== 1 ? 's' : ''}</span>
        {#if $roiTileCount > 0}
          <span class="text-gray-600 hidden md:inline">&middot; {$roiTileCount}t</span>
        {/if}
      {:else}
        <span class="hidden sm:inline">Regions</span>
        <span class="sm:hidden text-gray-600">0</span>
      {/if}
      <ChevronDown size={9} class="text-gray-600" />
    </button>

    {#if regionsOpen}
      <button type="button" class="fixed inset-0 z-30 cursor-default" tabindex="-1" aria-label="Close regions menu" onclick={() => { regionsOpen = false; }}></button>
      <div class="absolute top-full right-0 mt-1 z-40
                  bg-gray-950 border border-gray-700/80 rounded shadow-xl
                  min-w-[260px] p-2 space-y-2">

        {#if $availableDepths.length > 1}
          <div class="flex items-center gap-1 pb-1 border-b border-gray-800/60">
            <span class="text-[9px] text-gray-500 shrink-0"
                  title="Embedding dimensions new regions load at">Detail</span>
            {#each $availableDepths as d}
              <button
                onclick={() => loadDepth.set(d)}
                class="px-1.5 py-0.5 rounded text-[9px] border transition-colors
                       {$loadDepth === d
                         ? 'text-term-cyan border-term-cyan/40 bg-term-cyan/10'
                         : 'text-gray-500 border-gray-700/60 hover:text-gray-300'}"
              >d{d}</button>
            {/each}
            <span class="flex-1"></span>
            <span class="text-[8px] text-gray-600">{$loadDepth === $fullDepth ? 'full' : 'faster'}</span>
          </div>
        {/if}

        {#if $roiRegions.length === 0}
          <div class="text-[10px] text-gray-600 px-1 py-2 text-center">
            No regions yet. Use the draw tools to select an area.
          </div>
        {:else}
          <div class="space-y-1 max-h-[200px] overflow-y-auto">
            {#each $roiRegions as region, i}
              <div class="flex items-start gap-1.5 text-[9px] bg-gray-800/40 rounded px-2 py-1.5 border border-gray-700/30
                          hover:border-term-cyan/30 hover:bg-gray-800/60 transition-all cursor-pointer"
                   role="button" tabindex="0"
                   onclick={() => flyToRegion(region.feature)}
                   onkeydown={(e) => { if (e.key === 'Enter') flyToRegion(region.feature); }}>
                <div class="flex-1 min-w-0">
                  <div class="text-gray-400 font-medium">Region {i + 1}</div>
                  <div class="text-gray-600 truncate" title={featureBbox(region.feature)}>
                    {featureBbox(region.feature)}
                  </div>
                  <div class="text-gray-600">
                    {region.chunkKeys.length} tiles
                    {#if region.depth}<span class="text-gray-700">&middot; d{region.depth}</span>{/if}
                  </div>
                </div>
                <button
                  onclick={(e) => { e.stopPropagation(); removeRegion(region.id); }}
                  class="text-gray-600 hover:text-red-400 transition-colors mt-0.5 shrink-0"
                  title="Remove region"
                >
                  <X size={10} />
                </button>
              </div>
            {/each}
          </div>

          {#if canUpgrade}
            <button
              onclick={runUpgrade}
              disabled={upgrading}
              class="w-full text-[9px] px-2 py-1 rounded transition-colors
                     bg-term-cyan/10 text-term-cyan border border-term-cyan/30
                     hover:bg-term-cyan/20 disabled:opacity-50 disabled:cursor-wait"
              title="Reload at full depth and rerun the current analysis"
            >
              {upgrading
                ? `Reloading at d${$fullDepth}…`
                : `Upgrade to d${$fullDepth} — ${formatBytes(upgradeBytes)}`}
            </button>
          {/if}
        {/if}

        <div class="flex items-center gap-1 pt-1 border-t border-gray-800/60">
          <button
            onclick={() => { fileInput.click(); }}
            class="flex items-center gap-1 text-[9px] text-gray-500 hover:text-term-cyan px-1.5 py-1 rounded
                   border border-gray-700/60 hover:border-term-cyan/40 transition-all"
          >
            <Upload size={9} /> Import
          </button>
          {#if $roiRegions.length > 0}
            <button
              onclick={exportGeoJSON}
              class="flex items-center gap-1 text-[9px] text-gray-500 hover:text-term-cyan px-1.5 py-1 rounded
                     border border-gray-700/60 hover:border-term-cyan/40 transition-all"
            >
              <Download size={9} /> Export
            </button>
            <div class="flex-1"></div>
            <button
              onclick={() => { clearAllRegions(); }}
              class="flex items-center gap-1 text-[9px] text-gray-500 hover:text-red-400 px-1.5 py-1 rounded
                     border border-gray-700/60 hover:border-red-400/40 transition-all"
            >
              <Trash2 size={9} /> Clear
            </button>
          {/if}
        </div>

        {#if $roiLoading}
          <div class="space-y-1 pt-1 border-t border-gray-800/60">
            <div class="flex justify-between text-[9px]">
              <span class="text-term-cyan">
                Loading{$loadDepth ? ` at d${$loadDepth}` : ''}…
              </span>
              <span class="text-gray-500 tabular-nums">
                {$roiLoading.total > 0 ? `${$roiLoading.loaded}/${$roiLoading.total}` : 'preparing'}
              </span>
            </div>
            <div class="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
              <div class="h-full bg-term-cyan/70 rounded-full"
                class:animate-pulse={$roiLoading.total === 0}
                style="width: {$roiLoading.total > 0 ? ($roiLoading.loaded / $roiLoading.total) * 100 : 100}%"></div>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="w-px h-4 bg-gray-700/40 hidden sm:block"></div>

  <!-- Save / Load / Login -->
  <div class="hidden sm:flex items-center gap-0.5">
    <button class="flex items-center justify-center w-6 h-6 rounded
                   text-gray-500 border border-gray-700/60
                   hover:text-term-cyan hover:border-term-cyan/40 transition-all"
            title="Save project">
      <Save size={12} />
    </button>
    <button class="flex items-center justify-center w-6 h-6 rounded
                   text-gray-500 border border-gray-700/60
                   hover:text-term-cyan hover:border-term-cyan/40 transition-all"
            title="Load project">
      <FolderOpen size={12} />
    </button>
    <div class="w-px h-4 bg-gray-700/40 mx-0.5"></div>
    <button class="flex items-center justify-center w-6 h-6 rounded
                   text-gray-500 border border-gray-700/60
                   hover:text-term-cyan hover:border-term-cyan/40 transition-all"
            title="Login">
      <User size={12} />
    </button>
  </div>

  <!-- Dataset version + catalog status + year selector -->
  <div class="relative flex items-center shrink-0">
    <button
      onclick={() => { versionDropdownOpen = !versionDropdownOpen; yearDropdownOpen = false; }}
      class="flex items-center gap-1 px-1.5 py-1 rounded-l
             text-gray-300 hover:bg-gray-800/60 transition-colors"
      title={healthTitle}
    >
      <div class="w-1.5 h-1.5 rounded-full transition-colors {healthColor}"></div>
      <span class="text-[10px] hidden sm:inline">
        {#if $catalogStatus === 'loading'}
          ...
        {:else if $catalogStatus === 'error'}
          Err
        {:else}
          {activeVersionLabel}
        {/if}
      </span>
      <ChevronDown size={8} class="text-gray-600" />
    </button>

    <!-- Tile progress. Absolutely positioned and pointer-events-none so it
         floats clear of the bar: the button keeps its width whether or not a
         load is running, and the top bar never reflows. Suppressed while a
         dropdown is open, since both anchor to top-full. -->
    {#if showTileProgress}
      <div
        class="absolute top-full right-0 mt-1 z-20 pointer-events-none
               flex flex-col items-stretch gap-0.5 px-1.5 py-1 w-[4.5rem]
               bg-gray-950/95 border border-gray-700/60 rounded shadow-lg
               tile-progress"
        aria-hidden="true"
      >
        <span class="text-[9px] text-term-cyan/80 tabular-nums text-center leading-none">
          {$loading.done}/{$loading.total}{$loadDepth ? ` · d${$loadDepth}` : ''}
        </span>
        <div class="h-0.5 bg-gray-800 rounded-full overflow-hidden">
          <div class="h-full bg-term-cyan/70 rounded-full transition-all duration-150"
               style="width: {tileProgressPct}%"></div>
        </div>
      </div>
    {/if}

    {#if versionDropdownOpen}
      <button type="button" class="fixed inset-0 z-30 cursor-default" tabindex="-1" aria-label="Close version menu" onclick={() => { versionDropdownOpen = false; }}></button>
      <div class="absolute top-full left-0 mt-1 z-40
                  bg-gray-950 border border-gray-700/80 rounded shadow-xl
                  min-w-[150px] py-1">
        {#each DATASET_VERSIONS as version}
          <button
            onclick={() => { loadCatalog(version.url); versionDropdownOpen = false; }}
            class="flex flex-col items-start w-full text-left px-3 py-1
                   text-[10px] transition-colors
                   {$catalogUrl === version.url
                     ? 'text-term-cyan bg-term-cyan/10'
                     : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}"
          >
            <span>{version.label}</span>
            <span class="text-[9px] text-gray-600">{version.sublabel}</span>
          </button>
        {/each}
        <div class="my-1 h-px bg-gray-800/60"></div>
        <button
          onclick={() => { onOpenCatalog(); versionDropdownOpen = false; }}
          class="flex items-center w-full text-left px-3 py-1 text-[10px] transition-colors
                 {activeVersion
                   ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                   : 'text-term-cyan bg-term-cyan/10'}"
        >
          Custom URL…
        </button>
      </div>
    {/if}

    {#if $availableYears.length > 1}
      <button
        onclick={() => { yearDropdownOpen = !yearDropdownOpen; versionDropdownOpen = false; }}
        class="flex items-center gap-0.5 px-1 py-1 rounded-r
               text-term-cyan text-[10px] hover:bg-gray-800/60 transition-colors
               border-l border-gray-700/40"
        title="Switch year"
      >
        {$activeYear}
        <ChevronDown size={8} class="text-gray-600" />
      </button>

      {#if yearDropdownOpen}
        <button type="button" class="fixed inset-0 z-30 cursor-default" tabindex="-1" aria-label="Close year menu" onclick={() => { yearDropdownOpen = false; }}></button>
        <div class="absolute top-full right-0 mt-1 z-40
                    bg-gray-950 border border-gray-700/80 rounded shadow-xl
                    min-w-[70px] py-1">
          {#each $availableYears as year}
            <button
              onclick={() => { switchYear(year); yearDropdownOpen = false; }}
              class="flex items-center w-full text-left px-3 py-1
                     text-[10px] transition-colors
                     {$activeYear === year
                       ? 'text-term-cyan bg-term-cyan/10'
                       : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}"
            >
              {year}
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .welcome-pulse {
    animation: welcome-glow 1s ease-in-out 4;
  }
  @keyframes welcome-glow {
    0%, 100% { box-shadow: none; }
    50% { box-shadow: 0 0 8px rgba(0, 229, 255, 0.6), 0 0 16px rgba(0, 229, 255, 0.25); }
  }

  /* Tile progress chip: fade in, so a short load does not pop. */
  .tile-progress {
    animation: tile-progress-in 120ms ease-out;
  }
  @keyframes tile-progress-in {
    from { opacity: 0; transform: translateY(-2px); }
    to   { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .tile-progress { animation: none; }
  }

  /* Network activity: fade the status dot rather than move or resize it. */
  .net-pulse {
    animation: net-pulse 1.4s ease-in-out infinite;
  }
  @keyframes net-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  @media (prefers-reduced-motion: reduce) {
    .net-pulse { animation: none; opacity: 0.7; }
  }
</style>
