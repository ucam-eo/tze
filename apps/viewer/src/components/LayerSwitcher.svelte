<script lang="ts">
  import { Map as MapIcon, Globe, Mountain, Moon, Grid3x3, Square } from 'lucide-svelte';
  import { mapInstance } from '../stores/map';
  import { zarrSource, gridVisible, utmBoundaryVisible } from '../stores/zarr';

  const BASEMAPS = [
    { id: 'osm', label: 'Streets', icon: MapIcon, tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '&copy; OpenStreetMap' },
    { id: 'satellite', label: 'Satellite', icon: Globe, tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Esri, Maxar' },
    { id: 'terrain', label: 'Terrain', icon: Mountain, tiles: ['https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}.png'], attribution: 'Stadia Maps, Stamen' },
    { id: 'dark', label: 'Dark', icon: Moon, tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'], attribution: 'CartoDB, OSM' },
  ] as const;

  let selected = $state('dark');

  function switchBasemap(id: string) {
    const map = $mapInstance;
    if (!map || selected === id) return;
    selected = id;
    const bm = BASEMAPS.find(b => b.id === id)!;

    if (map.getLayer('basemap')) map.removeLayer('basemap');
    if (map.getSource('basemap')) map.removeSource('basemap');

    map.addSource('basemap', {
      type: 'raster',
      tiles: [...bm.tiles],
      tileSize: 256,
      attribution: bm.attribution,
    });
    const firstLayer = map.getStyle().layers[0];
    map.addLayer(
      { id: 'basemap', type: 'raster', source: 'basemap' },
      firstLayer?.id,
    );
  }

  function toggleGrid() {
    $gridVisible = !$gridVisible;
    $zarrSource?.setGridVisible($gridVisible);
  }

  function toggleUtm() {
    $utmBoundaryVisible = !$utmBoundaryVisible;
    $zarrSource?.setUtmBoundaryVisible($utmBoundaryVisible);
  }
</script>

<div class="px-4 py-3 border-b border-gray-800/60">
  <span class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Layers</span>
  <div class="mt-2 flex gap-1">
    {#each BASEMAPS as bm}
      <button
        onclick={() => switchBasemap(bm.id)}
        title={bm.label}
        class="w-7 h-7 flex items-center justify-center rounded border transition-all
               {selected === bm.id
                 ? 'bg-term-cyan/20 text-term-cyan border-term-cyan/40'
                 : 'bg-gray-950 text-gray-500 border-gray-700/60 hover:text-gray-300'}"
      >
        <bm.icon size={14} />
      </button>
    {/each}

    <div class="w-px bg-gray-800/60 mx-0.5"></div>

    <button
      onclick={toggleGrid}
      title="Chunk grid"
      class="w-7 h-7 flex items-center justify-center rounded border transition-all
             {$gridVisible
               ? 'bg-term-cyan/15 text-term-cyan border-term-cyan/40'
               : 'bg-gray-950 text-gray-500 border-gray-700/60 hover:text-gray-300'}"
    >
      <Grid3x3 size={14} />
    </button>
    <button
      onclick={toggleUtm}
      title="UTM boundary"
      class="w-7 h-7 flex items-center justify-center rounded border transition-all
             {$utmBoundaryVisible
               ? 'bg-green-400/15 text-green-400 border-green-400/40'
               : 'bg-gray-950 text-gray-500 border-gray-700/60 hover:text-gray-300'}"
    >
      <Square size={14} />
    </button>
  </div>
</div>
