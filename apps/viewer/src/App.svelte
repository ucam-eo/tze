<script lang="ts">
  import maplibregl from 'maplibre-gl';
  import { onMount } from 'svelte';
  import { registerZarrProtocol } from '@ucam-eo/maplibre-tessera';
  import { mapInstance } from './stores/map';

  // Register zarr:// tile protocol once at module load
  registerZarrProtocol(maplibregl);
  import TopBar from './components/TopBar.svelte';
  import CatalogModal from './components/CatalogModal.svelte';
  import OsmImport from './components/OsmImport.svelte';
  import LayerSwitcher from './components/LayerSwitcher.svelte';
  import ControlPanel from './components/ControlPanel.svelte';
  import DebugConsole from './components/DebugConsole.svelte';
  import ToolSwitcher from './components/ToolSwitcher.svelte';
  import type SimilaritySearch from './components/SimilaritySearch.svelte';
  import { sourceManager, displayManager } from './stores/zarr';
  import { get } from 'svelte/store';
  import { activeClass, classes, labels, addLabel, removeLabel, isClassified, classificationStore } from './stores/classifier';
  import { activeTool } from './stores/tools';
  import { zones } from './stores/stac';
  import { pointInBbox } from './lib/stac';
  import { segmentPolygons, segmentVisible } from './stores/segmentation';
  import { explorerHover, explorerTileEmb } from './stores/zarr-explorer';
  import UmapCloud from './components/UmapCloud.svelte';
  import TutorialOverlay from './components/TutorialOverlay.svelte';
  import { simEmbeddingTileCount, simSelectedPixel } from './stores/similarity';
  import { registerAllTutorials } from './lib/tutorials/index';
  import { TerraDraw, TerraDrawPolygonMode, TerraDrawRectangleMode } from 'terra-draw';
  import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
  import { drawMode, roiDrawing, roiRegions, roiLoading, addRegion, setConfirmLargeRegion } from './stores/drawing';
  import ConfirmModal from './components/ConfirmModal.svelte';
  import WelcomeModal from './components/WelcomeModal.svelte';

  let mapContainer: HTMLDivElement;
  let similarityRef: SimilaritySearch | undefined = $state();
  let terraDraw: TerraDraw | undefined = $state();
  let catalogModalOpen = $state(true);
  let osmModalOpen = $state(false);
  let osmAutoImport = $state(false);
  let sidebarOpen = $state(false);

  // Last mouse position (for re-triggering fingerprint when tile data arrives)
  let lastMouseLngLat: { lng: number; lat: number } | null = null;
  let lastMouseClient: { x: number; y: number } | null = null;

  // Large region confirmation modal state
  let largeRegionOpen = $state(false);
  let largeRegionCount = $state(0);
  let largeRegionResolve: ((proceed: boolean) => void) | null = null;

  setConfirmLargeRegion((count: number) => {
    largeRegionCount = count;
    largeRegionOpen = true;
    return new Promise<boolean>((resolve) => {
      largeRegionResolve = resolve;
    });
  });

  const BASEMAP_TILES: Record<string, { tiles: string[]; attribution: string }> = {
    satellite: { tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg'], attribution: 'Sentinel-2 cloudless by <a href="https://s2maps.eu">EOX</a> (contains modified Copernicus Sentinel data 2021)' },
  };

  function switchBasemap(id: 'osm' | 'satellite' | 'dark') {
    const map = $mapInstance;
    if (!map) return;
    const bm = BASEMAP_TILES[id];
    if (!bm) return;
    if (map.getLayer('basemap')) map.removeLayer('basemap');
    if (map.getSource('basemap')) map.removeSource('basemap');
    map.addSource('basemap', { type: 'raster', tiles: [...bm.tiles], tileSize: 256, attribution: bm.attribution });
    const layers = map.getStyle().layers;
    const bottomLayerId = layers.length > 0 ? layers[0].id : undefined;
    map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap' }, bottomLayerId);
  }

  // --- Animated radial fingerprint ---
  // Display values lerp towards target for smooth morphing between pixels
  let fpDisplay: Float32Array | null = null;    // current animated values (normalised)
  let fpTarget: Float32Array | null = null;     // target values (normalised)
  let fpTargetNorm = 0;
  let fpNBands = 0;
  let fpAnimId: number | null = null;
  let fpVisible = false;
  let fpMouseX = 0, fpMouseY = 0;

  const FP_LERP = 0.15; // per-frame lerp factor (0 = frozen, 1 = instant)
  const FP_S = 120;
  const FP_CX = FP_S / 2, FP_CY = FP_S / 2;
  const FP_MAX_R = 52;

  function setFingerprintTarget(embedding: Float32Array) {
    const n = embedding.length;
    let maxAbs = 0, normSq = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(embedding[i]);
      if (a > maxAbs) maxAbs = a;
      normSq += embedding[i] * embedding[i];
    }
    if (maxAbs === 0) return;

    fpLoading = false; // real data arrived
    fpNBands = n;
    fpTargetNorm = Math.sqrt(normSq);

    if (!fpTarget || fpTarget.length !== n) {
      fpTarget = new Float32Array(n);
      // Keep existing display buffer for smooth morph from loading wave
      if (!fpDisplay || fpDisplay.length !== n) fpDisplay = new Float32Array(n);
    }
    for (let i = 0; i < n; i++) fpTarget[i] = embedding[i] / maxAbs;

    fpVisible = true;
    if (fpAnimId == null) fpAnimId = requestAnimationFrame(fpAnimate);
  }

  function stopFingerprint() {
    fpVisible = false;
    fpLoading = false;
  }

  function fpAnimate() {
    fpAnimId = null;
    if (!fpVisible || !fpDisplay || !fpTarget) return;

    // During loading: generate rotating wave as the target
    if (fpLoading) {
      const t = performance.now() / 1000;
      for (let i = 0; i < fpNBands; i++) {
        const phase = (i / fpNBands) * Math.PI * 2;
        fpTarget[i] = 0.3 + 0.7 * (
          Math.sin(phase + t * 3) * 0.5
          + Math.sin(phase * 3 - t * 2) * 0.3
          + Math.sin(phase * 7 + t * 5) * 0.2
        );
      }
    }

    // Lerp display towards target
    let maxDelta = 0;
    for (let i = 0; i < fpNBands; i++) {
      const d = fpTarget[i] - fpDisplay[i];
      fpDisplay[i] += d * FP_LERP;
      const ad = Math.abs(d);
      if (ad > maxDelta) maxDelta = ad;
    }

    fpRender();

    // Keep animating while visible
    if (maxDelta > 0.001 || fpVisible) {
      fpAnimId = requestAnimationFrame(fpAnimate);
    }
  }

  function fpRender() {
    if (!fpDisplay) return;
    const canvas = document.getElementById('emb-fingerprint-canvas') as HTMLCanvasElement;
    const label = document.getElementById('emb-fingerprint-label') as HTMLElement;
    const el = document.getElementById('emb-fingerprint');
    if (!canvas || !el) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const S = FP_S, cx = FP_CX, cy = FP_CY, maxR = FP_MAX_R;
    const n = fpNBands;
    const tau = Math.PI * 2;

    ctx.clearRect(0, 0, S, S);

    // Concentric rings
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.06)';
    ctx.lineWidth = 0.5;
    for (const r of [15, 30, 45]) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, tau); ctx.stroke();
    }

    // Filled polygon
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * tau - Math.PI / 2;
      const r = Math.abs(fpDisplay[i]) * maxR;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 229, 255, 0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // Spokes
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * tau - Math.PI / 2;
      const v = fpDisplay[i];
      const r = Math.abs(v) * maxR;
      const hue = ((i / n) * 270 + 180) % 360;
      const alpha = 0.3 + Math.abs(v) * 0.5;
      ctx.strokeStyle = `hsla(${hue}, 70%, 55%, ${alpha})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      ctx.stroke();
    }

    // Centre dot
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 5);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
    glow.addColorStop(0.4, 'rgba(0, 229, 255, 0.5)');
    glow.addColorStop(1, 'rgba(0, 229, 255, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, tau); ctx.fill();

    // Label
    if (label) label.textContent = `${n}d  norm ${fpTargetNorm.toFixed(1)}`;

    // Position
    el.style.display = 'block';
    el.style.left = `${fpMouseX + 16}px`;
    el.style.top = `${fpMouseY - 70}px`;
  }

  // --- Loading state: uses the same radial spoke system with animated synthetic targets ---
  let fpLoading = false;
  const FP_LOADING_BANDS = 128; // match typical embedding size

  /** Start showing a loading animation — generates rotating synthetic spokes
   *  that will smoothly morph into real data once it arrives via setFingerprintTarget. */
  function renderFingerprintLoading(el: HTMLElement, mx: number, my: number) {
    fpMouseX = mx;
    fpMouseY = my;
    el.style.display = 'block';
    el.style.left = `${mx + 16}px`;
    el.style.top = `${my - 70}px`;

    const label = document.getElementById('emb-fingerprint-label') as HTMLElement;
    if (label) label.textContent = 'loading...';

    // Initialise display buffer if needed
    if (!fpDisplay || fpDisplay.length !== FP_LOADING_BANDS) {
      fpDisplay = new Float32Array(FP_LOADING_BANDS);
      fpTarget = new Float32Array(FP_LOADING_BANDS);
    }
    fpNBands = FP_LOADING_BANDS;
    fpLoading = true;
    fpVisible = true;
    if (fpAnimId == null) fpAnimId = requestAnimationFrame(fpAnimate);
  }

  /** Set new fingerprint target and update mouse position. */
  function renderFingerprintTooltip(el: HTMLElement, embedding: Float32Array, mx: number, my: number) {
    fpMouseX = mx;
    fpMouseY = my;
    setFingerprintTarget(embedding);
    // Position immediately even if animation hasn't caught up
    el.style.display = 'block';
    el.style.left = `${mx + 16}px`;
    el.style.top = `${my - 70}px`;
  }

  onMount(() => {
    registerAllTutorials();

    const map = new maplibregl.Map({
      container: mapContainer,
      style: {
        version: 8,
        sources: {},
        layers: [],
      },
      center: [-0.12, 51.51],
      zoom: 6,
      minZoom: 2,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });

    map.on('load', () => {
      $mapInstance = map;

      // Default to satellite basemap
      switchBasemap('satellite');

      // Add hover highlight layers (initially empty)
      map.addSource('tile-hover', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      // Thick black outer stroke
      map.addLayer({
        id: 'tile-hover-line-outer',
        type: 'line',
        source: 'tile-hover',
        paint: {
          'line-color': '#000000',
          'line-width': 5,
          'line-opacity': 0.8,
          'line-opacity-transition': { duration: 200 },
        },
      });
      // Thin cyan inner stroke
      map.addLayer({
        id: 'tile-hover-line',
        type: 'line',
        source: 'tile-hover',
        paint: {
          'line-color': '#00e5ff',
          'line-width': 2,
          'line-opacity': 0.9,
          'line-opacity-transition': { duration: 200 },
        },
      });

      // Pixel hover highlight (explorer mode — single pixel box)
      // Pixel hover highlight (explorer mode — animated glow)
      map.addSource('pixel-hover', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      // Outer glow (wide, soft)
      map.addLayer({
        id: 'pixel-hover-glow',
        type: 'line',
        source: 'pixel-hover',
        paint: {
          'line-color': '#00e5ff',
          'line-width': 8,
          'line-opacity': 0.15,
          'line-blur': 6,
          'line-opacity-transition': { duration: 300 },
        },
      });
      map.addLayer({
        id: 'pixel-hover-fill',
        type: 'fill',
        source: 'pixel-hover',
        paint: {
          'fill-color': '#00e5ff',
          'fill-opacity': 0.15,
          'fill-opacity-transition': { duration: 300 },
        },
      });
      map.addLayer({
        id: 'pixel-hover-line',
        type: 'line',
        source: 'pixel-hover',
        paint: {
          'line-color': '#00e5ff',
          'line-width': 2,
          'line-opacity': 0.9,
          'line-opacity-transition': { duration: 300 },
        },
      });

      // Segmentation polygon layers
      map.addSource('segment-polygons', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'segment-polygons-fill',
        type: 'fill',
        source: 'segment-polygons',
        paint: { 'fill-color': '#f97316', 'fill-opacity': 0.3 },
      });
      map.addLayer({
        id: 'segment-polygons-line',
        type: 'line',
        source: 'segment-polygons',
        paint: { 'line-color': '#f97316', 'line-width': 1.5, 'line-opacity': 0.8 },
      });

      // Label pixel polygons (classification training labels)
      map.addSource('label-pixels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'label-pixels-fill',
        type: 'fill',
        source: 'label-pixels',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.7,
        },
      });
      map.addLayer({
        id: 'label-pixels-line',
        type: 'line',
        source: 'label-pixels',
        paint: {
          'line-color': '#ffffff',
          'line-width': 1,
          'line-opacity': 0.8,
        },
      });

      // ROI region outlines
      map.addSource('roi-regions', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'roi-regions-fill',
        type: 'fill',
        source: 'roi-regions',
        paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: 'roi-regions-line',
        type: 'line',
        source: 'roi-regions',
        paint: { 'line-color': '#00e5ff', 'line-width': 2, 'line-opacity': 0.9, 'line-dasharray': [4, 2] },
      });

      // Similarity reference pixel marker
      map.addSource('sim-ref-marker', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      // Outer ring
      map.addLayer({
        id: 'sim-ref-marker-ring',
        type: 'circle',
        source: 'sim-ref-marker',
        paint: {
          'circle-radius': 10,
          'circle-color': 'transparent',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2.5,
        },
      });
      // Inner dot
      map.addLayer({
        id: 'sim-ref-marker-dot',
        type: 'circle',
        source: 'sim-ref-marker',
        paint: {
          'circle-radius': 3.5,
          'circle-color': '#00e5ff',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
        },
      });

      // Terra-draw for polygon/rectangle drawing
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [new TerraDrawPolygonMode(), new TerraDrawRectangleMode()],
      });
      terraDraw = draw;
      draw.on('finish', (id: string | number, ctx: { action: string }) => {
        if (ctx.action === 'draw') {
          const feat = draw.getSnapshotFeature(id);
          if (feat) {
            roiDrawing.set(false);
            addRegion(feat as GeoJSON.Feature).then((proceeded) => {
              if (!proceeded) roiDrawing.set(true);
            });
          }
        }
      });

      // Start with drawing active only if not in explorer mode
      if (get(activeTool) !== 'explorer') {
        roiDrawing.set(true);
      }

      // 3D buildings — visible when map is pitched, at zoom >= 15
      map.addSource('buildings-3d-src', {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
      });
      map.addLayer({
        id: '3d-buildings',
        source: 'buildings-3d-src',
        'source-layer': 'building',
        type: 'fill-extrusion',
        minzoom: 14,
        paint: {
          'fill-extrusion-color': '#aaa',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 5],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.7,
        },
      });
      map.on('moveend', () => {
        const vis = map.getPitch() > 0 ? 'visible' : 'none';
        if (map.getLayer('3d-buildings')) {
          map.setLayoutProperty('3d-buildings', 'visibility', vis);
          // Keep buildings above embeddings/overlays
          map.moveLayer('3d-buildings');
        }
      });
    });

    // Track hovered chunk to avoid redundant updates
    let hoveredChunkKey = '';
    let hoverFadeTimer: ReturnType<typeof setTimeout> | undefined;
    // Track hovered pixel for explorer fingerprint
    let hoveredPixelKey = '';
    // Auto-select tile on dwell in explorer mode (zoom >= 12)
    let dwellTimer: ReturnType<typeof setTimeout> | undefined;
    let dwellChunkKey = '';
    const DWELL_MS = 500;
    const DWELL_MIN_ZOOM = 12;
    // (lastMouseLngLat / lastMouseClient are declared at component scope for $effect access)

    // Coordinates display + tile hover highlight
    map.on('mousemove', (e) => {
      lastMouseLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      lastMouseClient = { x: e.originalEvent.clientX, y: e.originalEvent.clientY };
      const coord = document.getElementById('coord-text');
      if (coord) coord.textContent = `${e.lngLat.lng.toFixed(4)}, ${e.lngLat.lat.toFixed(4)}`;

      // Tile hover highlight + auto-select on dwell
      const mgr = get(sourceManager);
      const hoverSource = map.getSource('tile-hover') as maplibregl.GeoJSONSource | undefined;
      if (mgr && hoverSource) {
        let chunk = mgr.getChunkAtLngLat(e.lngLat.lng, e.lngLat.lat);
        const key = chunk ? `${chunk.zoneId}:${chunk.ci}_${chunk.cj}` : '';

        // In explorer mode at sufficient zoom, if no source is open yet for this zone,
        // find the zone and schedule opening it on dwell.
        const isExplorer = get(activeTool) === 'explorer';
        const sufficientZoom = map.getZoom() >= DWELL_MIN_ZOOM;
        let dwellZoneId: string | null = null;
        if (!chunk && isExplorer && sufficientZoom) {
          const allZones = get(zones);
          const zone = allZones.find(z => pointInBbox(e.lngLat.lng, e.lngLat.lat, z.bbox));
          if (zone) dwellZoneId = zone.id;
        }

        if (key !== hoveredChunkKey) {
          hoveredChunkKey = key;
          if (chunk) {
            const corners = mgr.getChunkBoundsLngLat(chunk.zoneId, chunk.ci, chunk.cj);
            if (corners) {
              clearTimeout(hoverFadeTimer);
              map.setPaintProperty('tile-hover-line-outer', 'line-opacity', 0.8);
              map.setPaintProperty('tile-hover-line', 'line-opacity', 0.9);
              hoverSource.setData({
                type: 'FeatureCollection',
                features: [{
                  type: 'Feature',
                  properties: {},
                  geometry: {
                    type: 'Polygon',
                    coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
                  },
                }],
              });
            }

            // Auto-select tile on dwell
            if (isExplorer && key !== dwellChunkKey && sufficientZoom) {
              clearTimeout(dwellTimer);
              dwellChunkKey = key;
              const dChunk = chunk;
              dwellTimer = setTimeout(() => {
                if (hoveredChunkKey !== key) return;
                (async () => {
                  try {
                    await mgr.getSource(dChunk.zoneId);
                    explorerHover.set({
                      zoneId: dChunk.zoneId,
                      ci: dChunk.ci, cj: dChunk.cj,
                      years: [], utmBounds: [0, 0, 0, 0],
                    });
                  } catch { /* ignore */ }
                })();
              }, DWELL_MS);
            }
          } else {
            // Moved off tiles — fade out
            clearTimeout(dwellTimer);
            dwellChunkKey = '';
            map.setPaintProperty('tile-hover-line-outer', 'line-opacity', 0);
            map.setPaintProperty('tile-hover-line', 'line-opacity', 0);
            clearTimeout(hoverFadeTimer);
            hoverFadeTimer = setTimeout(() => {
              hoverSource.setData({ type: 'FeatureCollection', features: [] });
            }, 250);

            // If over a zone but source not open yet, schedule open+select on dwell
            if (dwellZoneId) {
              const zid = dwellZoneId;
              const lng = e.lngLat.lng, lat = e.lngLat.lat;
              clearTimeout(dwellTimer);
              dwellChunkKey = `pending:${zid}`;
              dwellTimer = setTimeout(() => {
                (async () => {
                  try {
                    await mgr.getSource(zid);
                    // Source is now open — retry chunk lookup
                    const c = mgr.getChunkAtLngLat(lng, lat);
                    if (c) {
                      explorerHover.set({
                        zoneId: c.zoneId,
                        ci: c.ci, cj: c.cj,
                        years: [], utmBounds: [0, 0, 0, 0],
                      });
                      // Show tile outline now that we know the chunk
                      hoveredChunkKey = `${c.zoneId}:${c.ci}_${c.cj}`;
                      dwellChunkKey = hoveredChunkKey;
                      const corners = mgr.getChunkBoundsLngLat(c.zoneId, c.ci, c.cj);
                      if (corners) {
                        map.setPaintProperty('tile-hover-line-outer', 'line-opacity', 0.8);
                        map.setPaintProperty('tile-hover-line', 'line-opacity', 0.9);
                        hoverSource.setData({
                          type: 'FeatureCollection',
                          features: [{
                            type: 'Feature', properties: {},
                            geometry: { type: 'Polygon', coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]] },
                          }],
                        });
                      }
                    }
                  } catch { /* ignore */ }
                })();
              }, DWELL_MS);
            }
          }
        }
      }

      // Embedding fingerprint tooltip + pixel highlight (explorer mode)
      const fpEl = document.getElementById('emb-fingerprint');
      const pixSrc = map.getSource('pixel-hover') as maplibregl.GeoJSONSource | undefined;
      if (fpEl) {
        let shown = false;
        const isExplorer = get(activeTool) === 'explorer';
        const tile = get(explorerTileEmb);
        const onTile = isExplorer && mgr && hoveredChunkKey && map.getZoom() >= DWELL_MIN_ZOOM;

        // Try to show pixel fingerprint from loaded tile data
        if (isExplorer && mgr && tile) {
          const src = mgr.getOpenSource(tile.zoneId);
          if (src?.metadata && src.projection) {
            const meta = src.metadata;
            const [easting, northing] = src.projection.forward(e.lngLat.lng, e.lngLat.lat);
            const tf = meta.transform;
            const globalCol = Math.floor((easting - tf[2]) / tf[0]);
            const globalRow = Math.floor((tf[5] - northing) / tf[0]);
            const cs = meta.chunkShape;
            const ci = Math.floor(globalRow / cs[0]);
            const cj = Math.floor(globalCol / cs[1]);
            if (ci === tile.ci && cj === tile.cj) {
              const row = globalRow - ci * cs[0];
              const col = globalCol - cj * cs[1];
              if (row >= 0 && row < tile.tileH && col >= 0 && col < tile.tileW) {
                const pixIdx = row * tile.tileW + col;
                const off = pixIdx * tile.nBands;
                if (!isNaN(tile.emb[off])) {
                  const embedding = tile.emb.slice(off, off + tile.nBands);
                  renderFingerprintTooltip(fpEl, embedding, e.originalEvent.clientX, e.originalEvent.clientY);
                  shown = true;
                  // Pixel highlight box
                  const pxKey = `${ci}:${cj}:${row}:${col}`;
                  if (pxKey !== hoveredPixelKey && pixSrc) {
                    hoveredPixelKey = pxKey;
                    const corners = src.getPixelBoundsLngLat(ci, cj, row, col);
                    if (corners) {
                      pixSrc.setData({
                        type: 'FeatureCollection',
                        features: [{
                          type: 'Feature', properties: {},
                          geometry: { type: 'Polygon', coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]] },
                        }],
                      });
                      map.setPaintProperty('pixel-hover-fill', 'fill-opacity', 0.4);
                      map.setPaintProperty('pixel-hover-line', 'line-opacity', 1.0);
                      map.setPaintProperty('pixel-hover-glow', 'line-opacity', 0.4);
                      setTimeout(() => {
                        if (map.getLayer('pixel-hover-fill')) {
                          map.setPaintProperty('pixel-hover-fill', 'fill-opacity', 0.15);
                          map.setPaintProperty('pixel-hover-line', 'line-opacity', 0.9);
                          map.setPaintProperty('pixel-hover-glow', 'line-opacity', 0.15);
                        }
                      }, 50);
                    }
                  }
                }
              }
            }
          }
        }

        // Show loading spinner in the circle while on a tile but no data yet
        if (!shown && onTile) {
          renderFingerprintLoading(fpEl, e.originalEvent.clientX, e.originalEvent.clientY);
          shown = true;
        }

        if (!shown) {
          stopFingerprint();
          fpEl.style.display = 'none';
          if (hoveredPixelKey && pixSrc) {
            hoveredPixelKey = '';
            pixSrc.setData({ type: 'FeatureCollection', features: [] });
          }
        }
      }

      // Floating tooltip: classification pixels + label markers
      const tip = document.getElementById('class-tooltip');
      if (!tip) return;
      const tipX = e.originalEvent.clientX + 12;
      const tipY = e.originalEvent.clientY - 10;

      // Check classification pixel under cursor
      const classId = mgr ? get(classificationStore).getAt(e.lngLat.lng, e.lngLat.lat, mgr) : null;

      if (classId != null && classId >= 0) {
        const cls = get(classes).find(c => c.id === classId);
        if (cls) {
          tip.innerHTML = `<span style="background:${cls.color}" class="inline-block w-2 h-2 rounded-sm"></span> ${cls.name}`;
          tip.style.left = `${tipX}px`;
          tip.style.top = `${tipY}px`;
          tip.style.display = 'flex';
          return;
        }
      } else if (classId === -1) {
        tip.innerHTML = '<span class="inline-block w-2 h-2 rounded-sm bg-gray-500"></span> <i class="text-gray-500">uncertain</i>';
        tip.style.left = `${tipX}px`;
        tip.style.top = `${tipY}px`;
        tip.style.display = 'flex';
        return;
      }

      // Check if cursor is on a label pixel
      const allLabels = get(labels);
      if (allLabels.length > 0 && mgr) {
        const emb = mgr.getEmbeddingAt(e.lngLat.lng, e.lngLat.lat);
        if (emb) {
          const lp = allLabels.find(l => l.ci === emb.ci && l.cj === emb.cj && l.row === emb.row && l.col === emb.col);
          if (lp) {
            const allClasses = get(classes);
            const cls = allClasses.find(c => c.id === lp.classId);
            const srcTag = lp.source === 'osm'
              ? ' <span class="text-gray-500">osm</span>'
              : ' <span class="text-gray-500">manual</span>';
            tip.innerHTML = `<span style="background:${cls?.color ?? '#888'}" class="inline-block w-2 h-2 rounded-sm"></span> ${cls?.name ?? '?'}${srcTag}`;
            tip.style.left = `${tipX}px`;
            tip.style.top = `${tipY}px`;
            tip.style.display = 'flex';
            return;
          }
        }
      }

      tip.style.display = 'none';
    });

    // Fade out hover when mouse leaves the map
    map.on('mouseout', () => {
      hoveredChunkKey = '';
      hoveredPixelKey = '';
      clearTimeout(dwellTimer);
      dwellChunkKey = '';
      stopFingerprint();
      const fpEl = document.getElementById('emb-fingerprint');
      if (fpEl) fpEl.style.display = 'none';
      const pixSrc = map.getSource('pixel-hover') as maplibregl.GeoJSONSource | undefined;
      if (pixSrc) pixSrc.setData({ type: 'FeatureCollection', features: [] });
      // Fade opacity to 0 via transitions
      map.setPaintProperty('tile-hover-line-outer', 'line-opacity', 0);
      map.setPaintProperty('tile-hover-line', 'line-opacity', 0);
      // Clear data after the transition completes
      clearTimeout(hoverFadeTimer);
      hoverFadeTimer = setTimeout(() => {
        const hoverSource = map.getSource('tile-hover') as maplibregl.GeoJSONSource | undefined;
        if (hoverSource) hoverSource.setData({ type: 'FeatureCollection', features: [] });
      }, 250);
    });

    // Map click — dispatched based on active tool
    // NOTE: use get() to read stores inside imperative callbacks —
    // the $ prefix only works in Svelte's reactive context.
    map.on('click', (e) => {
      const tool = get(activeTool);
      const mgr = get(sourceManager);
      if (!mgr) return;

      if (tool === 'explorer') {
        const lng = e.lngLat.lng;
        const lat = e.lngLat.lat;

        // Zoom in first if below minimum zoom for tile inspection
        if (map.getZoom() < DWELL_MIN_ZOOM) {
          map.flyTo({ center: [lng, lat], zoom: DWELL_MIN_ZOOM, duration: 800 });
        }

        // Find which zone the click falls in
        const allZones = get(zones);
        const zone = allZones.find(z => pointInBbox(lng, lat, z.bbox));
        if (!zone) { explorerHover.set(null); return; }
        (async () => {
          try {
            await mgr.getSource(zone.id);
            const chunk = mgr.getChunkAtLngLat(lng, lat);
            if (chunk && chunk.zoneId === zone.id) {
              explorerHover.set({
                zoneId: zone.id,
                ci: chunk.ci, cj: chunk.cj,
                years: [],
                utmBounds: [0, 0, 0, 0],
              });
            } else {
              explorerHover.set({ zoneId: zone.id, ci: -1, cj: -1, years: [], utmBounds: [0, 0, 0, 0] });
            }
          } catch { explorerHover.set(null); }
        })();
        return;
      }

      if (tool === 'similarity') {
        similarityRef?.handleClick(e.lngLat.lng, e.lngLat.lat);
        return;
      }

      if (tool === 'classifier') {
        // Check if there's already a label at this pixel — if so, remove it
        const emb0 = mgr.getEmbeddingAt(e.lngLat.lng, e.lngLat.lat);
        if (emb0) {
          const removed = removeLabel(emb0.ci, emb0.cj, emb0.row, emb0.col);
          if (removed) return;
        }

        // No existing label — add one (requires active class)
        const cls = get(activeClass);
        if (!cls) return;

        const embeddings = mgr.getEmbeddingsInKernel(e.lngLat.lng, e.lngLat.lat, 1);
        if (embeddings.length === 0) return;

        for (const emb of embeddings) {
          addLabel([e.lngLat.lng, e.lngLat.lat], emb, cls.id);
        }
      }
    });

    // Lazily open zone sources as the user pans into new zones
    map.on('moveend', () => {
      const dm = get(displayManager);
      const sm = get(sourceManager);
      if (!dm || !sm) return;
      const center = map.getCenter();
      const currentZones = get(zones);
      for (const zone of currentZones) {
        if (pointInBbox(center.lng, center.lat, zone.bbox)) {
          if (!sm.getOpenSource(zone.id)) {
            dm.getDisplaySource(zone.id);
          }
          break;
        }
      }
    });

    return () => { map.remove(); $mapInstance = null; };
  });

  // Activate/deactivate terra-draw based on roiDrawing store
  $effect(() => {
    const draw = terraDraw;
    if (!draw) return;
    const drawing = $roiDrawing;
    const mode = $drawMode;
    if (drawing) {
      if (!draw.enabled) draw.start();
      draw.setMode(mode);
    } else {
      if (draw.enabled) draw.stop();
    }
  });

  $effect(() => {
    const map = $mapInstance;
    if (!map) return;
    const canvas = map.getCanvasContainer();
    if ($activeTool === 'explorer') {
      canvas.style.cursor = 'pointer';
    } else if ($roiDrawing) {
      canvas.style.cursor = 'crosshair';
    } else if ($activeTool === 'similarity') {
      canvas.style.cursor = 'cell';
    } else if ($activeTool === 'classifier' && $activeClass) {
      canvas.style.cursor = 'cell';
    } else {
      canvas.style.cursor = 'grab';
    }
  });

  // Update similarity reference pixel marker
  $effect(() => {
    const map = $mapInstance;
    const pixel = $simSelectedPixel;
    if (!map) return;
    const src = map.getSource('sim-ref-marker') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (pixel) {
      src.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [pixel.lng, pixel.lat] }, properties: {} }],
      });
    } else {
      src.setData({ type: 'FeatureCollection', features: [] });
    }
  });

  // Zone polygon layers removed — UTM zones are now an implementation detail

  // Sync label pixel polygons reactively — only visible on classifier tab
  $effect(() => {
    const map = $mapInstance;
    const allLabels = $labels;
    const allClasses = $classes;
    const tool = $activeTool;
    const mgr = $sourceManager;
    if (!map) return;

    const src = map.getSource('label-pixels') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    // Only show labels on the classifier tab
    if (tool !== 'classifier' || !mgr) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    // Build classId → color lookup
    const colorMap = new Map<number, string>();
    for (const cls of allClasses) colorMap.set(cls.id, cls.color);

    // Build polygon features for each label — one pixel-sized square per label
    const features: GeoJSON.Feature[] = [];
    for (const lp of allLabels) {
      const corners = mgr.getPixelBoundsLngLat(lp.ci, lp.cj, lp.row, lp.col);
      if (!corners) continue;
      const color = colorMap.get(lp.classId) ?? '#888888';
      features.push({
        type: 'Feature',
        properties: { color },
        geometry: {
          type: 'Polygon',
          coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
        },
      });
    }
    src.setData({ type: 'FeatureCollection', features });
  });

  // Update segmentation polygon layers when store changes
  $effect(() => {
    const map = $mapInstance;
    const geojson = $segmentPolygons;
    const visible = $segmentVisible;
    if (!map) return;
    const src = map.getSource('segment-polygons') as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(geojson);
    const vis = visible ? 'visible' : 'none';
    if (map.getLayer('segment-polygons-fill')) map.setLayoutProperty('segment-polygons-fill', 'visibility', vis);
    if (map.getLayer('segment-polygons-line')) map.setLayoutProperty('segment-polygons-line', 'visibility', vis);
  });

  // Sync ROI regions to map overlay
  $effect(() => {
    const map = $mapInstance;
    const regions = $roiRegions;
    if (!map) return;
    const src = map.getSource('roi-regions') as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData({
        type: 'FeatureCollection',
        features: regions.map(r => r.feature),
      });
    }
  });

  // When tile embedding data arrives, re-trigger fingerprint at last mouse position
  // so the loading wave morphs into the real data without needing mouse movement.
  $effect(() => {
    const tile = $explorerTileEmb;
    if (!tile || !lastMouseLngLat || !lastMouseClient) return;
    if (get(activeTool) !== 'explorer') return;
    const mgr = get(sourceManager);
    if (!mgr) return;
    const src = mgr.getOpenSource(tile.zoneId);
    if (!src?.metadata || !src.projection) return;
    const meta = src.metadata;
    const [easting, northing] = src.projection.forward(lastMouseLngLat.lng, lastMouseLngLat.lat);
    const tf = meta.transform;
    const globalCol = Math.floor((easting - tf[2]) / tf[0]);
    const globalRow = Math.floor((tf[5] - northing) / tf[0]);
    const cs = meta.chunkShape;
    const ci = Math.floor(globalRow / cs[0]);
    const cj = Math.floor(globalCol / cs[1]);
    if (ci !== tile.ci || cj !== tile.cj) return;
    const row = globalRow - ci * cs[0];
    const col = globalCol - cj * cs[1];
    if (row < 0 || row >= tile.tileH || col < 0 || col >= tile.tileW) return;
    const pixIdx = row * tile.tileW + col;
    const off = pixIdx * tile.nBands;
    if (isNaN(tile.emb[off])) return;
    const embedding = tile.emb.slice(off, off + tile.nBands);
    const el = document.getElementById('emb-fingerprint');
    if (el) renderFingerprintTooltip(el, embedding, lastMouseClient.x, lastMouseClient.y);
  });

</script>

<div bind:this={mapContainer} id="map"></div>

<!-- Top bar -->
<TopBar onOpenCatalog={() => { catalogModalOpen = true; }} />

<!-- Large region confirmation modal -->
<ConfirmModal
  bind:open={largeRegionOpen}
  title="Large Region"
  message="This region contains {largeRegionCount.toLocaleString()} chunks. Loading may take significant time and bandwidth."
  detail="Consider drawing a smaller region, or continue if you have a fast connection."
  confirmLabel="Load {largeRegionCount.toLocaleString()} chunks"
  onconfirm={() => { largeRegionOpen = false; largeRegionResolve?.(true); largeRegionResolve = null; }}
  oncancel={() => { largeRegionOpen = false; largeRegionResolve?.(false); largeRegionResolve = null; }}
/>

<!-- Catalog modal -->
<CatalogModal bind:open={catalogModalOpen} />

<!-- OSM import modal -->
<OsmImport bind:open={osmModalOpen} autoImport={osmAutoImport} />

<!-- Sidebar (bottom sheet on mobile, side panel on desktop) -->
<div class="fixed bottom-0 left-0 right-0 w-full max-h-[60vh]
            sm:absolute sm:top-12 sm:right-4 sm:left-auto sm:bottom-auto sm:w-[240px] sm:max-h-[calc(100vh-4rem)]
            bg-black/85 backdrop-blur-xl
            border border-gray-800/80 rounded-t-lg sm:rounded-lg shadow-2xl shadow-cyan-900/20
            overflow-y-auto select-none z-10 font-mono text-gray-300 text-xs
            transition-transform duration-300
            pb-[env(safe-area-inset-bottom)]
            {sidebarOpen ? 'translate-y-0' : 'translate-y-[calc(100%-2.5rem)]'}
            sm:translate-y-0">
  <!-- Mobile drag handle -->
  <button
    class="sm:hidden flex items-center justify-center w-full py-1.5 text-gray-500"
    onclick={() => { sidebarOpen = !sidebarOpen; }}
  >
    <span class="text-[10px] tracking-wider uppercase">{sidebarOpen ? '▼ Tools' : '▲ Tools'}</span>
  </button>
  <LayerSwitcher />
  <ControlPanel />
  <ToolSwitcher bind:similarityRef={similarityRef} onOpenOsm={() => { osmModalOpen = true; }} />
</div>

<!-- UMAP floating window (outside sidebar to avoid backdrop-filter clipping) -->
<UmapCloud visible={$activeTool === 'similarity' && $simEmbeddingTileCount > 0 && !$roiLoading} />

<!-- Tutorial overlay -->
<TutorialOverlay {similarityRef} onOpenOsm={(opts) => { osmAutoImport = opts?.autoImport ?? false; osmModalOpen = true; }} onCloseOsm={() => { osmModalOpen = false; osmAutoImport = false; }} onSwitchBasemap={switchBasemap} />

<!-- Debug console -->
<DebugConsole />

<!-- Welcome modal (first visit only) -->
<WelcomeModal />

<!-- Coordinates (desktop only — no mousemove on mobile) -->
<div class="hidden sm:block absolute bottom-2 right-4 bg-black/70 backdrop-blur-sm
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

<!-- Embedding fingerprint tooltip (explorer mode, follows mouse) -->
<div id="emb-fingerprint"
     class="fixed z-50 pointer-events-none"
     style="display: none">
  <canvas id="emb-fingerprint-canvas" width="120" height="120"
          style="border-radius: 50%; box-shadow: 0 0 16px rgba(0,229,255,0.25), 0 0 4px rgba(0,229,255,0.4); background: rgba(0,2,8,0.55); border: 1px solid rgba(0,229,255,0.25);">
  </canvas>
  <div id="emb-fingerprint-label"
       class="text-center text-[8px] text-gray-500 font-mono mt-1"
       style="text-shadow: 0 0 4px rgba(0,229,255,0.3);">
  </div>
</div>
