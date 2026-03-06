<script lang="ts">
  import { Search, Crosshair } from 'lucide-svelte';
  import { zones, catalogStatus } from '../stores/stac';
  import { metadata, loading } from '../stores/zarr';
  import { mapInstance } from '../stores/map';
  import { get } from 'svelte/store';
  import TutorialDropdown from './TutorialDropdown.svelte';

  interface Props {
    onOpenCatalog: () => void;
  }

  let { onOpenCatalog }: Props = $props();

  const healthColor = $derived(
    $catalogStatus === 'loaded' ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.6)]'
    : $catalogStatus === 'loading' ? 'bg-yellow-400 shadow-[0_0_4px_rgba(250,204,21,0.6)]'
    : $catalogStatus === 'error' ? 'bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.6)]'
    : 'bg-gray-500'
  );

  const healthLabel = $derived(
    $catalogStatus === 'loaded' ? 'Connected'
    : $catalogStatus === 'loading' ? 'Loading...'
    : $catalogStatus === 'error' ? 'Error'
    : 'Idle'
  );

  // --- Search ---
  interface NominatimResult {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    boundingbox: [string, string, string, string]; // [south, north, west, east]
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

  /** Try to parse coordinates from input. Supports:
   *  51.5, -0.12  |  51.5 -0.12  |  51.5,-0.12
   *  N51.5 W0.12  |  51.5N 0.12W
   *  Returns [lat, lon] or null. */
  function tryParseCoords(q: string): [number, number] | null {
    const s = q.trim();
    // Try "lat, lon" or "lat lon" (with optional comma)
    const simple = s.match(/^([+-]?\d+\.?\d*)\s*[,\s]\s*([+-]?\d+\.?\d*)$/);
    if (simple) {
      const lat = parseFloat(simple[1]), lon = parseFloat(simple[2]);
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return [lat, lon];
    }
    // Try NSEW prefix/suffix: "N51.5 W0.12" or "51.5N 0.12W"
    const nsew = s.match(/^([NSEW])\s*(\d+\.?\d*)\s*[,\s]\s*([NSEW])\s*(\d+\.?\d*)$/i)
              || s.match(/^(\d+\.?\d*)\s*([NSEW])\s*[,\s]\s*(\d+\.?\d*)\s*([NSEW])$/i);
    if (nsew) {
      let lat: number, lon: number;
      if (/[NSns]/i.test(nsew[1])) {
        // prefix format: N51.5 W0.12
        lat = parseFloat(nsew[2]) * (/[Ss]/.test(nsew[1]) ? -1 : 1);
        lon = parseFloat(nsew[4]) * (/[Ww]/.test(nsew[3]) ? -1 : 1);
      } else {
        // suffix format: 51.5N 0.12W
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
    // Check for coordinate input — show as instant result
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
      const res = await fetch(url, {
        headers: { 'Accept-Language': 'en' },
      });
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
    map.fitBounds([[west, south], [east, north]], {
      padding: 40,
      maxZoom: 16,
      duration: 1500,
    });
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

  function closeSearch() {
    searchOpen = false;
  }

  function gotoCurrentLocation() {
    if (!navigator.geolocation) return;
    locating = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const map = get(mapInstance);
        if (map) {
          map.flyTo({
            center: [pos.coords.longitude, pos.coords.latitude],
            zoom: 14,
            duration: 1500,
          });
        }
        locating = false;
      },
      () => { locating = false; },
      { timeout: 10000 },
    );
  }

  function formatResult(name: string): string {
    // Shorten long display names: keep first two parts and last part
    const parts = name.split(', ');
    if (parts.length <= 3) return name;
    return `${parts[0]}, ${parts[1]}, ${parts[parts.length - 1]}`;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="absolute top-0 left-0 right-0 h-9 z-20
            bg-black/85 backdrop-blur-xl border-b border-gray-800/60
            flex items-center px-2 sm:px-4 gap-1.5 sm:gap-3 font-mono text-xs select-none">

  <!-- TZE branding -->
  <div class="flex items-center gap-2 shrink-0">
    <div class="w-2 h-2 rounded-full bg-term-cyan shadow-[0_0_6px_rgba(0,229,255,0.6)]"></div>
    <span class="text-term-cyan text-[11px] font-bold tracking-[0.2em] uppercase">TZE</span>
  </div>

  <!-- Tutorial dropdown (left, beside branding) -->
  <TutorialDropdown />

  <!-- Search bar -->
  <div class="relative flex items-center gap-1" data-tutorial="search-bar">
    <!-- Mobile: icon-only search toggle -->
    <button
      class="sm:hidden flex items-center justify-center w-6 h-6 rounded
             border border-gray-700/60 bg-gray-900/80
             text-gray-500 hover:text-term-cyan hover:border-term-cyan/50
             transition-colors"
      onclick={() => { searchExpanded = !searchExpanded; if (searchExpanded) setTimeout(() => searchInputEl?.focus(), 50); }}
      title="Search"
    >
      <Search size={12} />
    </button>
    <div class="relative {searchExpanded ? 'flex' : 'hidden'} sm:flex items-center">
      <Search size={11} class="absolute left-1.5 text-gray-600 pointer-events-none" />
      <input
        bind:this={searchInputEl}
        bind:value={searchQuery}
        oninput={() => debounceSearch(searchQuery)}
        onkeydown={handleSearchKeydown}
        onfocus={() => { if (searchResults.length > 0) searchOpen = true; }}
        onblur={() => { if (!searchQuery) searchExpanded = false; }}
        type="text"
        placeholder="Search or lat, lon..."
        class="w-[160px] sm:w-[220px] h-6 pl-6 pr-2 rounded bg-gray-900/80 border border-term-cyan/30
               text-[11px] text-gray-300 placeholder-gray-600
               focus:border-term-cyan/50 focus:outline-none focus:ring-0
               focus:shadow-[0_0_8px_rgba(0,229,255,0.15)]
               transition-colors font-mono"
      />
      {#if searchLoading}
        <div class="absolute right-1.5 w-3 h-3 border border-term-cyan/40 border-t-term-cyan rounded-full animate-spin"></div>
      {/if}
    </div>

    <!-- Current location button -->
    <button
      onclick={gotoCurrentLocation}
      disabled={locating}
      class="flex items-center justify-center w-6 h-6 rounded
             border border-gray-700/60 bg-gray-900/80
             text-term-cyan/60 hover:text-term-cyan hover:border-term-cyan/50
             disabled:opacity-40 transition-colors"
      title="Go to current location"
    >
      <Crosshair size={12} class={locating ? 'animate-pulse' : ''} />
    </button>

    <!-- Search results dropdown -->
    {#if searchOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="fixed inset-0 z-30" onclick={closeSearch}></div>
      <div class="absolute top-full left-0 mt-1 z-40
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

  <!-- Spacer -->
  <div class="flex-1"></div>

  <!-- Status indicator -->
  <button
    onclick={onOpenCatalog}
    class="flex items-center gap-1.5 px-2 py-1 rounded
           text-gray-300 hover:bg-gray-800/60 transition-colors"
    title="Catalog settings"
  >
    <div class="w-2 h-2 rounded-full {healthColor}"></div>
    <span class="text-[11px]">
      {#if $catalogStatus === 'loaded'}
        {$zones.length} zones
      {:else if $catalogStatus === 'loading'}
        Loading...
      {:else if $catalogStatus === 'error'}
        Error
      {:else}
        Connect
      {/if}
    </span>
    {#if $metadata}
      <span class="hidden sm:inline text-[10px] text-gray-600">{$metadata.nBands}b</span>
      {#if $loading.total > 0}
        <span class="text-[10px] text-term-cyan/60 tabular-nums">{$loading.done}/{$loading.total}</span>
      {/if}
    {/if}
  </button>
</div>
