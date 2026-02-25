<script lang="ts">
  import maplibregl from 'maplibre-gl';
  import { onMount } from 'svelte';
  import { mapInstance } from './stores/map';
  import StoreSelector from './components/StoreSelector.svelte';
  import LayerSwitcher from './components/LayerSwitcher.svelte';
  import ControlPanel from './components/ControlPanel.svelte';
  import InfoPanel from './components/InfoPanel.svelte';
  import DebugConsole from './components/DebugConsole.svelte';
  import ToolSwitcher from './components/ToolSwitcher.svelte';
  import type SimilaritySearch from './components/SimilaritySearch.svelte';
  import { zarrSource } from './stores/zarr';
  import { get } from 'svelte/store';
  import { activeClass, classes, kernelSize, addLabel, isClassified } from './stores/classifier';
  import { activeTool } from './stores/tools';
  import { zones, activeZoneId, switchZone } from './stores/stac';
  import { pointInBbox } from './lib/stac';

  let mapContainer: HTMLDivElement;
  let labelMarkers: maplibregl.Marker[] = [];
  let similarityRef: SimilaritySearch | undefined = $state();

  onMount(() => {
    const map = new maplibregl.Map({
      container: mapContainer,
      style: {
        version: 8,
        sources: {
          basemap: {
            type: 'raster',
            tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: 'CartoDB, OSM',
          },
        },
        layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
      },
      center: [0, 20],
      zoom: 3,
    });

    map.on('load', () => { $mapInstance = map; });

    // Coordinates display
    map.on('mousemove', (e) => {
      const coord = document.getElementById('coord-text');
      if (coord) coord.textContent = `${e.lngLat.lng.toFixed(4)}, ${e.lngLat.lat.toFixed(4)}`;

      // Floating classification tooltip
      const tip = document.getElementById('class-tooltip');
      if (!tip) return;
      if (get(isClassified)) {
        const src = get(zarrSource);
        const classId = src?.getClassificationAt(e.lngLat.lng, e.lngLat.lat) ?? null;

        if (classId != null && classId >= 0) {
          const cls = get(classes).find(c => c.id === classId);
          if (cls) {
            tip.innerHTML = `<span style="background:${cls.color}" class="inline-block w-2 h-2 rounded-sm"></span> ${cls.name}`;
            tip.style.left = `${e.originalEvent.clientX + 12}px`;
            tip.style.top = `${e.originalEvent.clientY - 10}px`;
            tip.style.display = 'flex';
            return;
          }
        } else if (classId === -1) {
          tip.innerHTML = '<span class="inline-block w-2 h-2 rounded-sm bg-gray-500"></span> <i class="text-gray-500">uncertain</i>';
          tip.style.left = `${e.originalEvent.clientX + 12}px`;
          tip.style.top = `${e.originalEvent.clientY - 10}px`;
          tip.style.display = 'flex';
          return;
        }
      }
      tip.style.display = 'none';
    });

    // Map click — dispatched based on active tool
    // NOTE: use get() to read stores inside imperative callbacks —
    // the $ prefix only works in Svelte's reactive context.
    map.on('click', (e) => {
      const tool = get(activeTool);
      const src = get(zarrSource);
      if (!src) return;

      if (tool === 'similarity') {
        similarityRef?.handleClick(e.lngLat.lng, e.lngLat.lat);
        return;
      }

      if (tool === 'classifier') {
        const cls = get(activeClass);
        if (!cls) return;

        const ks = get(kernelSize);
        const embeddings = src.getEmbeddingsInKernel(e.lngLat.lng, e.lngLat.lat, ks);
        if (embeddings.length === 0) return;

        for (const emb of embeddings) {
          addLabel([e.lngLat.lng, e.lngLat.lat], emb, cls.id);
        }

        // Add visual marker at click location
        const marker = new maplibregl.Marker({
          color: cls.color,
          scale: 0.5,
        })
          .setLngLat(e.lngLat)
          .addTo(map);
        labelMarkers.push(marker);
      }
    });

    // Auto-switch zone on pan
    map.on('moveend', () => {
      const center = map.getCenter();
      const currentZones = get(zones);
      if (currentZones.length === 0) return;

      for (const zone of currentZones) {
        if (pointInBbox(center.lng, center.lat, zone.bbox)) {
          if (zone.id !== get(activeZoneId)) {
            switchZone(zone.id);
          }
          break;
        }
      }
    });

    return () => { map.remove(); $mapInstance = null; };
  });

  $effect(() => {
    const map = $mapInstance;
    if (!map) return;
    const canvas = map.getCanvasContainer();
    if ($activeTool === 'similarity') {
      canvas.style.cursor = 'crosshair';
    } else if ($activeTool === 'classifier' && $activeClass) {
      canvas.style.cursor = 'crosshair';
    } else {
      canvas.style.cursor = '';
    }
  });

  // Add/update zone polygon layers when zones change
  $effect(() => {
    const map = $mapInstance;
    const zoneList = $zones;
    if (!map || zoneList.length === 0) return;

    const geojson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: zoneList.map(z => ({
        type: 'Feature' as const,
        id: z.id,
        properties: { id: z.id, utmZone: z.utmZone },
        geometry: z.geometry,
      })),
    };

    if (map.getSource('stac-zones')) {
      (map.getSource('stac-zones') as maplibregl.GeoJSONSource).setData(geojson);
    } else {
      map.addSource('stac-zones', { type: 'geojson', data: geojson });
      map.addLayer({
        id: 'stac-zones-line',
        type: 'line',
        source: 'stac-zones',
        paint: {
          'line-color': '#00e5ff',
          'line-opacity': 0,
          'line-width': 1,
          'line-dasharray': [4, 2],
        },
      });
    }
  });

  // Highlight active zone border
  $effect(() => {
    const map = $mapInstance;
    const active = $activeZoneId;
    if (!map || !map.getLayer('stac-zones-line')) return;

    map.setPaintProperty('stac-zones-line', 'line-opacity', [
      'case',
      ['==', ['get', 'id'], active ?? ''],
      0.6,
      0,
    ]);
  });
</script>

<div bind:this={mapContainer} id="map"></div>

<!-- Control panel -->
<div class="absolute top-4 right-4 w-[280px] max-h-[calc(100vh-2rem)] bg-black/85 backdrop-blur-xl
            border border-gray-800/80 rounded-lg shadow-2xl shadow-cyan-900/20
            overflow-y-auto select-none z-10 font-mono text-gray-300 text-xs">
  <!-- Header -->
  <div class="px-4 py-3 border-b border-gray-800/60">
    <div class="flex items-center gap-2">
      <div class="w-2 h-2 rounded-full bg-term-cyan shadow-[0_0_6px_rgba(0,229,255,0.6)]"></div>
      <h1 class="text-term-cyan text-sm font-bold tracking-[0.2em] uppercase">TZE</h1>
    </div>
    <p class="text-gray-600 text-[10px] mt-0.5 tracking-wider">TESSERA ZARR EXPLORER</p>
  </div>

  <StoreSelector />
  <LayerSwitcher />
  <ControlPanel />
  <ToolSwitcher bind:similarityRef={similarityRef} />
  <InfoPanel />
</div>

<!-- Debug console -->
<DebugConsole />

<!-- Coordinates -->
<div class="absolute bottom-2 right-4 bg-black/70 backdrop-blur-sm
            text-[10px] text-gray-500 font-mono px-2.5 py-1 rounded
            border border-gray-800/40 z-10 tabular-nums">
  <span id="coord-text">--</span>
</div>

<!-- Floating classification tooltip (follows mouse) -->
<div id="class-tooltip"
     class="fixed items-center gap-1.5 bg-black/85 backdrop-blur-sm
            text-[11px] text-gray-200 font-mono px-2 py-1 rounded
            border border-gray-700/50 z-50 pointer-events-none
            shadow-lg shadow-black/40 whitespace-nowrap"
     style="display: none">
</div>
