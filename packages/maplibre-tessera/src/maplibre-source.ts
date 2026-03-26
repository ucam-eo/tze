import type { Map as MaplibreMap } from 'maplibre-gl';
import {
  TesseraSource,
  fetchRegion,
  type StoreMetadata,
  type EmbeddingRegion,
  type ChunkRef,
  type UtmBounds,
  type ChunkBounds,
  type DebugLogEntry,
} from '@ucam-eo/tessera';
import type { CachedChunk, PreviewMode, MaplibreDisplayOptions } from './types.js';
import { WorkerPool } from './worker-pool.js';
import { RegionLoadingAnimation } from './region-loading-animation.js';
import { clearZarrProtocolCache } from './zarr-tile-protocol.js';
import { rgbaToCanvas, renderRegionCanvas } from './chunk-renderer.js';

export type MaplibreTesseraOptions = MaplibreDisplayOptions;

type ResolvedDisplayOptions = Required<Omit<MaplibreDisplayOptions, 'globalPreviewBounds'>> & {
  globalPreviewBounds?: [number, number, number, number];
};

/**
 * MapLibre display wrapper around a {@link TesseraSource}.
 *
 * Owns ALL display / MapLibre concerns and delegates ALL data operations
 * to {@link source} (the core {@link TesseraSource}).
 */
export class MaplibreTesseraSource {
  /** The core data-access source. */
  readonly source: TesseraSource;

  private opts: ResolvedDisplayOptions;
  private map: MaplibreMap | null = null;
  private workerPool: WorkerPool | null = null;
  private chunkCache = new Map<string, CachedChunk>();
  private currentAbort: AbortController | null = null;
  private previewLayerId: string | null = null;
  private previewSourceId: string | null = null;
  private moveHandler: (() => void) | null = null;
  private abortHandler: ((e: PromiseRejectionEvent) => void) | null = null;
  /** Suppresses per-tile debug messages during batch loading. */
  private batchLoading = false;
  /** Region-wide loading animation (covers entire ROI polygon). */
  private regionAnimation: RegionLoadingAnimation | null = null;

  constructor(source: TesseraSource, options?: MaplibreDisplayOptions) {
    this.source = source;
    this.opts = {
      bands: options?.bands ?? [0, 1, 2],
      opacity: options?.opacity ?? 0.8,
      preview: options?.preview ?? 'rgb',
      maxCached: options?.maxCached ?? 50,
      maxLoadPerUpdate: options?.maxLoadPerUpdate ?? 80,
      globalPreviewUrl: options?.globalPreviewUrl ?? '',
      globalPreviewBounds: options?.globalPreviewBounds,
    };
  }

  // ---------------------------------------------------------------------------
  // Map lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Attach to a MapLibre map, creating raster sources/layers for tile display.
   *
   * The underlying {@link TesseraSource} must already be open (i.e. `source.open()`
   * has been called). This method sets up the display machinery only.
   */
  async addTo(map: MaplibreMap): Promise<void> {
    this.map = map;
    try {
      this.workerPool = new WorkerPool(
        Math.min(navigator.hardwareConcurrency || 4, 8),
      );
    } catch (err) {
      console.error('[MaplibreTesseraSource] Failed to create WorkerPool:', err);
      throw err;
    }

    // Suppress AbortError from MapLibre ImageSource.updateImage internal fetches.
    this.abortHandler = (e: PromiseRejectionEvent) => {
      if (e.reason?.name === 'AbortError') e.preventDefault();
    };
    window.addEventListener('unhandledrejection', this.abortHandler);
    map.on('error', (e: { error?: Error }) => {
      if (e.error?.name === 'AbortError') return;
    });

    // Source must already be open — verify metadata is available
    if (!this.source.metadata) {
      throw new Error('[MaplibreTesseraSource] TesseraSource is not open. Call source.open() before addTo().');
    }

    // Add zarr-layer preview if global preview URL is configured
    if (this.opts.globalPreviewUrl) {
      this.addPreviewLayer();
    }

    // Listen for viewport changes
    this.moveHandler = () => this.updateVisibleChunks();
    map.on('moveend', this.moveHandler);

    // Load visible chunks immediately
    this.updateVisibleChunks();
  }

  /**
   * Remove all layers from the map and release display resources.
   * Does NOT close the underlying TesseraSource.
   */
  remove(): void {
    // Remove preview tile layer
    if (this.map) {
      try {
        if (this.previewLayerId && this.map.getLayer(this.previewLayerId)) this.map.removeLayer(this.previewLayerId);
        if (this.previewSourceId && this.map.getSource(this.previewSourceId)) this.map.removeSource(this.previewSourceId);
      } catch { /* already removed */ }
      this.previewLayerId = null;
      this.previewSourceId = null;
    }

    if (this.moveHandler && this.map) {
      this.map.off('moveend', this.moveHandler);
    }
    if (this.abortHandler) {
      window.removeEventListener('unhandledrejection', this.abortHandler);
      this.abortHandler = null;
    }
    this.currentAbort?.abort();
    this.stopRegionAnimation();
    for (const [key] of this.chunkCache) this.removeChunkFromMap(key);
    this.chunkCache.clear();
    this.workerPool?.terminate();
    this.map = null;
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /** Choose which three embedding bands to map to R/G/B. */
  setBands(bands: [number, number, number]): void {
    this.opts.bands = bands;
    this.recolorAllChunks();
  }

  /** Set the opacity of all tile layers (0-1). */
  setOpacity(opacity: number): void {
    this.opts.opacity = opacity;
    if (!this.map) return;
    // Update the global preview layer (RGB/PCA background)
    if (this.previewLayerId && this.map.getLayer(this.previewLayerId)) {
      this.map.setPaintProperty(this.previewLayerId, 'raster-opacity', opacity);
    }
    // Update region-wide RGB overlay
    if (this.map.getLayer('zarr-rgb-overlay-lyr')) {
      this.map.setPaintProperty('zarr-rgb-overlay-lyr', 'raster-opacity', opacity);
    }
    // Update any remaining per-tile chunk layers
    const style = this.map.getStyle();
    if (!style?.layers) return;
    for (const layer of style.layers) {
      if (layer.id.startsWith('zarr-chunk-lyr-')) {
        this.map.setPaintProperty(layer.id, 'raster-opacity', opacity);
      }
    }
  }

  /** Switch the preview rendering mode (rgb | bands). */
  setPreview(mode: PreviewMode): void {
    this.opts.preview = mode;
    if (this.previewLayerId && this.opts.globalPreviewUrl && this.map) {
      // Remove and re-add with new variable -- protocol URL encodes the variable
      clearZarrProtocolCache();
      this.removePreviewLayer();
      this.addPreviewLayer();
    } else {
      // Legacy path: clear cache and reload with new preview mode
      for (const [key] of this.chunkCache) this.removeChunkFromMap(key);
      this.chunkCache.clear();
      this.updateVisibleChunks();
    }
  }

  // ---------------------------------------------------------------------------
  // Layer management
  // ---------------------------------------------------------------------------

  /** Re-add all chunk, overlay, and grid layers to the map.
   *  Call after a basemap switch that preserves sources but resets layers. */
  reAddAllLayers(): void {
    if (!this.map || !this.source.metadata) return;

    // Re-add the global preview layer if configured
    if (this.opts.globalPreviewUrl) {
      this.previewLayerId = null; // stale after basemap switch
      this.previewSourceId = null;
      this.addPreviewLayer();
    }

    // Re-render the region-wide RGB overlay if embeddings are loaded
    if (this.source.embeddingRegion && this.source.tileCount > 0) {
      this.recolorAllChunks();
    }

    // Re-add any remaining per-tile chunk layers (preview tiles etc.)
    let reAdded = 0;
    for (const [, entry] of this.chunkCache) {
      if (!entry.canvas) continue;
      if (this.previewLayerId && entry.isPreview) continue;
      entry.sourceId = null;
      entry.layerId = null;
      const ids = this.addChunkToMap(entry.ci, entry.cj, entry.canvas);
      entry.sourceId = ids.sourceId;
      entry.layerId = ids.layerId;
      reAdded++;
    }
    if (reAdded > 0) this.debug('overlay', `Re-added ${reAdded} cached chunk layers`);
  }

  /** Re-render all loaded chunks with the current colour mapping.
   *  Renders a single region-wide canvas (no seams between tiles). */
  recolorAllChunks(): void {
    if (!this.map || !this.source.metadata || !this.source.embeddingRegion) return;
    const region = this.source.embeddingRegion;

    // Remove old per-tile chunk layers (they'll be replaced by the single region canvas)
    const { loaded, gridCols } = region;
    const nTiles = loaded.length;
    for (let t = 0; t < nTiles; t++) {
      if (!loaded[t]) continue;
      const ci = region.ciMin + Math.floor(t / gridCols);
      const cj = region.cjMin + (t % gridCols);
      const key = this.chunkKey(ci, cj);
      const entry = this.chunkCache.get(key);
      if (entry?.sourceId) this.removeChunkFromMap(key);
    }

    // Render the region canvas via the pure function
    const canvas = renderRegionCanvas(region, this.opts.bands);
    if (!canvas) return;

    // Place the single canvas as a region-wide ImageSource
    const topLeft = this.chunkUtmBounds(region.ciMin, region.cjMin);
    const bottomRight = this.chunkUtmBounds(region.ciMax, region.cjMax);
    const regionBounds: UtmBounds = {
      minE: topLeft.minE,
      maxE: bottomRight.maxE,
      minN: bottomRight.minN,
      maxN: topLeft.maxN,
    };
    const corners = this.source.projection!.chunkCornersToLngLat(regionBounds);
    const dataUrl = canvas.toDataURL('image/png');

    const sourceId = 'zarr-rgb-overlay-src';
    const layerId = 'zarr-rgb-overlay-lyr';

    // Update in-place if source exists, otherwise create
    const existing = this.map.getSource(sourceId) as
      { updateImage?: (opts: { url: string; coordinates: [number, number][] }) => void } | undefined;
    if (existing?.updateImage) {
      existing.updateImage({ url: dataUrl, coordinates: corners });
    } else {
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
      if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
      this.map.addSource(sourceId, {
        type: 'image', url: dataUrl, coordinates: corners,
      });
      this.map.addLayer({
        id: layerId, type: 'raster', source: sourceId,
        paint: { 'raster-opacity': this.opts.opacity, 'raster-fade-duration': 0 },
      });
      this.raiseOverlayLayers();
    }
  }

  /** Re-order all layers to the canonical z-order. Call after adding external overlay layers. */
  raiseAllLayers(): void {
    this.raiseOverlayLayers();
  }

  // ---------------------------------------------------------------------------
  // Batch loading
  // ---------------------------------------------------------------------------

  /**
   * Load a batch of embedding chunks. Delegates data loading to `source.loadChunks()`
   * and manages per-tile loading animations on the display side.
   *
   * @returns The number of chunks requested.
   */
  async loadChunkBatch(
    chunks: ChunkRef[],
    onProgress?: (loaded: number, total: number, ci: number, cj: number) => void,
  ): Promise<number> {
    if (chunks.length === 0) return 0;
    this.batchLoading = true;

    await this.source.loadChunks(chunks, {
      onProgress: (loaded, total, chunk) => {
        onProgress?.(loaded, total, chunk.ci, chunk.cj);
      },
    });

    this.batchLoading = false;
    return chunks.length;
  }

  // ---------------------------------------------------------------------------
  // Region animation
  // ---------------------------------------------------------------------------

  /** Start region-wide loading animation covering the given polygon. */
  startRegionAnimation(
    polygon: GeoJSON.Polygon,
    chunks: { ci: number; cj: number }[],
  ): void {
    if (!this.map || chunks.length === 0) return;
    this.stopRegionAnimation();

    // Compute bounds
    let ciMin = Infinity, ciMax = -Infinity, cjMin = Infinity, cjMax = -Infinity;
    for (const { ci, cj } of chunks) {
      if (ci < ciMin) ciMin = ci;
      if (ci > ciMax) ciMax = ci;
      if (cj < cjMin) cjMin = cj;
      if (cj > cjMax) cjMax = cj;
    }

    // Polygon bbox in lng/lat
    const coords = polygon.coordinates[0];
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const [lng, lat] of coords) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }

    this.regionAnimation = new RegionLoadingAnimation({
      map: this.map as any,
      polygon: coords as [number, number][],
      bbox: [west, south, east, north],
      chunks,
      ciMin, ciMax, cjMin, cjMax,
      chunkCorners: (ci, cj) => this.chunkCorners(ci, cj),
    });
    this.raiseOverlayLayers();
  }

  /** Update region animation progress and mark a tile as loaded. */
  updateRegionAnimation(loaded: number, total: number, ci?: number, cj?: number): void {
    if (!this.regionAnimation) return;
    this.regionAnimation.updateProgress(loaded, total);
    if (ci != null && cj != null) {
      this.regionAnimation.markTileLoaded(ci, cj);
    }
  }

  /** Stop and remove the region loading animation. */
  stopRegionAnimation(): void {
    if (this.regionAnimation) {
      this.regionAnimation.destroy();
      this.regionAnimation = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Overlay methods
  // ---------------------------------------------------------------------------

  /** Add or update a single overlay canvas covering the entire embedding region.
   *  One PNG encode + one ImageSource -- much faster than per-tile overlays.
   *  Uses updateImage when possible to avoid remove+re-add flicker. */
  setSimilarityOverlay(canvas: HTMLCanvasElement): void {
    if (!this.map || !this.source.embeddingRegion) return;
    const r = this.source.embeddingRegion;
    // Compute corners spanning the full region grid
    const topLeft = this.chunkUtmBounds(r.ciMin, r.cjMin);
    const bottomRight = this.chunkUtmBounds(r.ciMax, r.cjMax);
    const regionBounds: UtmBounds = {
      minE: topLeft.minE,
      maxE: bottomRight.maxE,
      minN: bottomRight.minN,
      maxN: topLeft.maxN,
    };
    const corners = this.source.projection!.chunkCornersToLngLat(regionBounds);
    const dataUrl = canvas.toDataURL('image/png');

    const sourceId = 'zarr-sim-overlay-src';
    const layerId = 'zarr-sim-overlay-lyr';

    // Fast path: update existing source in-place (no flicker, no layer re-order)
    const existing = this.map.getSource(sourceId) as
      { updateImage?: (opts: { url: string; coordinates: [number, number][] }) => void } | undefined;
    if (existing?.updateImage) {
      existing.updateImage({ url: dataUrl, coordinates: corners });
      return;
    }

    // First time: create source + layer
    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

    this.map.addSource(sourceId, {
      type: 'image', url: dataUrl, coordinates: corners,
    });
    this.map.addLayer({
      id: layerId, type: 'raster', source: sourceId,
      paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0 },
    });
    this.raiseOverlayLayers();
  }

  /** Remove the similarity overlay. */
  clearSimilarityOverlay(): void {
    if (!this.map) return;
    const layerId = 'zarr-sim-overlay-lyr';
    const sourceId = 'zarr-sim-overlay-src';
    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  }

  /** Remove the region-wide RGB overlay. */
  clearRgbOverlay(): void {
    if (!this.map) return;
    const layerId = 'zarr-rgb-overlay-lyr';
    const sourceId = 'zarr-rgb-overlay-src';
    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  }

  /** Add or update a classification RGBA canvas as a map layer for a chunk. */
  addClassificationOverlay(ci: number, cj: number, canvas: HTMLCanvasElement): void {
    this.addClassificationOverlayBatch([{ ci, cj, canvas }]);
  }

  /** Add or update classification overlays for multiple tiles at once.
   *  Only raises overlay layers once at the end (O(N) instead of O(N^2)). */
  addClassificationOverlayBatch(tiles: { ci: number; cj: number; canvas: HTMLCanvasElement }[]): void {
    if (!this.map || tiles.length === 0) return;
    let needsRaise = false;

    for (const { ci, cj, canvas } of tiles) {
      const key = this.chunkKey(ci, cj);
      const sourceId = `zarr-class-src-${key}`;
      const layerId = `zarr-class-lyr-${key}`;
      const corners = this.chunkCorners(ci, cj);

      // Always remove + re-add to guarantee the canvas content is picked up
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
      if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

      this.map.addSource(sourceId, {
        type: 'image',
        url: canvas.toDataURL('image/png'),
        coordinates: corners,
      });
      this.map.addLayer({
        id: layerId, type: 'raster', source: sourceId,
        paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 0 },
      });
      needsRaise = true;
    }

    if (needsRaise) this.raiseOverlayLayers();
  }

  /** Remove all classification overlay layers from the map.
   *  NOTE: Does NOT clear classificationMaps (that's now in ClassificationStore). */
  clearClassificationOverlays(): void {
    if (!this.map) return;
    const style = this.map.getStyle();
    if (!style?.layers) return;
    // Remove per-tile classification overlays only
    const classLayers = style.layers.filter(l => l.id.startsWith('zarr-class-lyr-'));
    for (const layer of classLayers) {
      this.map.removeLayer(layer.id);
      const srcId = layer.id.replace('zarr-class-lyr-', 'zarr-class-src-');
      if (this.map.getSource(srcId)) this.map.removeSource(srcId);
    }
  }

  /** Set opacity on all classification overlay layers. */
  setClassificationOpacity(opacity: number): void {
    if (!this.map) return;
    const style = this.map.getStyle();
    if (!style?.layers) return;
    for (const layer of style.layers) {
      if (layer.id.startsWith('zarr-class-lyr-')) {
        this.map.setPaintProperty(layer.id, 'raster-opacity', opacity);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Convenience accessors
  // ---------------------------------------------------------------------------

  /** The store metadata for this source. Convenience alias for `source.metadata`. */
  getMetadata(): StoreMetadata | null {
    return this.source.metadata;
  }

  /** Check if a tile is loaded in the embedding region. */
  regionHasTile(ci: number, cj: number): boolean {
    return this.source.regionHasTile(ci, cj);
  }

  /** Return the number of loaded tiles in the region. */
  regionTileCount(): number {
    return this.source.tileCount;
  }

  // ---------------------------------------------------------------------------
  // Private: coordinate helpers
  // ---------------------------------------------------------------------------

  private chunkKey(ci: number, cj: number): string { return `${ci}_${cj}`; }

  private chunkPixelBounds(ci: number, cj: number): ChunkBounds {
    const meta = this.source.metadata!;
    const s = meta.shape;
    const cs = meta.chunkShape;
    return {
      r0: ci * cs[0],
      r1: Math.min(ci * cs[0] + cs[0], s[0]),
      c0: cj * cs[1],
      c1: Math.min(cj * cs[1] + cs[1], s[1]),
    };
  }

  private chunkUtmBounds(ci: number, cj: number): UtmBounds {
    const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
    const t = this.source.metadata!.transform;
    const px = t[0];
    const originE = t[2];
    const originN = t[5];
    return {
      minE: originE + c0 * px,
      maxE: originE + c1 * px,
      minN: originN - r1 * px,
      maxN: originN - r0 * px,
    };
  }

  private chunkCorners(ci: number, cj: number) {
    return this.source.projection!.chunkCornersToLngLat(this.chunkUtmBounds(ci, cj));
  }

  // ---------------------------------------------------------------------------
  // Private: viewport loading
  // ---------------------------------------------------------------------------

  private visibleChunkIndices(): [number, number][] {
    const store = this.source._store;
    if (!store || !this.map || !this.source.projection) return [];
    const proj = this.source.projection;
    const bounds = this.map.getBounds();
    const sw = proj.forward(bounds.getWest(), bounds.getSouth());
    const ne = proj.forward(bounds.getEast(), bounds.getNorth());
    const nw = proj.forward(bounds.getWest(), bounds.getNorth());
    const se = proj.forward(bounds.getEast(), bounds.getSouth());

    const minE = Math.min(sw[0], nw[0]) - 1000;
    const maxE = Math.max(ne[0], se[0]) + 1000;
    const minN = Math.min(sw[1], se[1]) - 1000;
    const maxN = Math.max(ne[1], nw[1]) + 1000;

    const cs = store.meta.chunkShape;
    const s = store.meta.shape;
    const t = store.meta.transform;
    const px = t[0];
    const originE = t[2];
    const originN = t[5];
    const nChunksRow = Math.ceil(s[0] / cs[0]);
    const nChunksCol = Math.ceil(s[1] / cs[1]);

    const cjMin = Math.max(0, Math.floor((minE - originE) / (cs[1] * px)));
    const cjMax = Math.min(nChunksCol - 1, Math.floor((maxE - originE) / (cs[1] * px)));
    const ciMin = Math.max(0, Math.floor((originN - maxN) / (cs[0] * px)));
    const ciMax = Math.min(nChunksRow - 1, Math.floor((originN - minN) / (cs[0] * px)));

    const result: [number, number][] = [];
    for (let ci = ciMin; ci <= ciMax; ci++) {
      for (let cj = cjMin; cj <= cjMax; cj++) {
        if (store.chunkManifest && !store.chunkManifest.has(`${ci}_${cj}`)) continue;
        result.push([ci, cj]);
      }
    }
    return result;
  }

  private async updateVisibleChunks(): Promise<void> {
    const store = this.source._store;
    if (!store || !this.map) return;
    // When the global preview layer handles RGB/PCA rendering, the legacy
    // per-chunk loading is unnecessary.
    if (this.previewLayerId) return;
    this.currentAbort?.abort();
    const abort = this.currentAbort = new AbortController();
    const signal = abort.signal;

    const visible = this.visibleChunkIndices();
    const visibleKeys = new Set(visible.map(([ci, cj]) => this.chunkKey(ci, cj)));

    // Remove off-screen chunks from map (keep in cache)
    let removed = 0;
    for (const [key, entry] of this.chunkCache) {
      if (!visibleKeys.has(key) && entry.sourceId) { this.removeChunkFromMap(key); removed++; }
    }

    // Re-add cached chunks and collect new ones to load
    const toLoad: [number, number][] = [];
    for (const [ci, cj] of visible) {
      const key = this.chunkKey(ci, cj);
      const entry = this.chunkCache.get(key);
      if (entry?.canvas && !entry.sourceId) {
        const ids = this.addChunkToMap(ci, cj, entry.canvas);
        entry.sourceId = ids.sourceId;
        entry.layerId = ids.layerId;
      } else if (!entry) {
        toLoad.push([ci, cj]);
      }
    }

    // Sort by distance from center
    try {
      const center = this.map.getCenter();
      const proj = this.source.projection!;
      const [cE, cN] = proj.forward(center.lng, center.lat);
      toLoad.sort((a, b) => {
        const ba = this.chunkUtmBounds(a[0], a[1]);
        const bb = this.chunkUtmBounds(b[0], b[1]);
        const da = Math.hypot((ba.minE + ba.maxE) / 2 - cE, (ba.minN + ba.maxN) / 2 - cN);
        const db = Math.hypot((bb.minE + bb.maxE) / 2 - cE, (bb.minN + bb.maxN) / 2 - cN);
        return da - db;
      });
    } catch { /* keep original order */ }

    if (toLoad.length > this.opts.maxLoadPerUpdate) {
      toLoad.length = this.opts.maxLoadPerUpdate;
    }

    // Determine preview mode
    const meta = this.source.metadata!;
    const usePreview = this.opts.preview === 'rgb' && meta.hasRgb;

    let done = 0;
    const concurrency = 4; // default concurrency for viewport tiles

    for (let i = 0; i < toLoad.length; i += concurrency) {
      if (signal.aborted) break;
      const batch = toLoad.slice(i, i + concurrency);
      await Promise.all(batch.map(([ci, cj]) =>
        this.loadChunk(ci, cj, signal, usePreview).then(() => {
          done++;
        }),
      ));
    }

    // LRU eviction
    if (this.chunkCache.size > this.opts.maxCached) {
      const keys = [...this.chunkCache.keys()];
      for (let i = 0; i < keys.length && this.chunkCache.size > this.opts.maxCached; i++) {
        if (!visibleKeys.has(keys[i])) {
          this.removeChunkFromMap(keys[i]);
          this.chunkCache.delete(keys[i]);
        }
      }
    }
  }

  /** Load a single viewport preview tile. */
  private async loadChunk(
    ci: number, cj: number, signal: AbortSignal, usePreview: boolean,
  ): Promise<void> {
    const store = this.source._store;
    if (!store) return;
    const key = this.chunkKey(ci, cj);
    if (this.chunkCache.has(key)) return;

    try {
      const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
      const h = r1 - r0;
      const w = c1 - c0;

      let result: Record<string, unknown>;

      if (usePreview && !this.source.regionHasTile(ci, cj)) {
        const previewArr = store.rgbArr!;
        const rgbView = await fetchRegion(previewArr, [[r0, r1], [c0, c1], null]);
        if (signal.aborted) return;
        const rgbData = new Uint8Array(
          rgbView.data.buffer, rgbView.data.byteOffset, rgbView.data.byteLength,
        ).slice().buffer;

        result = await this.workerPool!.dispatch({
          type: 'render-rgb', rgbData, width: w, height: h,
        }, [rgbData]);
      } else {
        const [embView, scalesView] = await Promise.all([
          fetchRegion(store.embArr, [[r0, r1], [c0, c1], null]),
          fetchRegion(store.scalesArr, [[r0, r1], [c0, c1]]),
        ]);
        if (signal.aborted) return;
        const embBuf = new Int8Array(
          embView.data.buffer, embView.data.byteOffset, embView.data.byteLength,
        ).slice().buffer;
        const scalesBuf = new Uint8Array(
          new Float32Array(scalesView.data.buffer, scalesView.data.byteOffset, scalesView.data.byteLength).buffer,
        ).slice().buffer;

        result = await this.workerPool!.dispatch({
          type: 'render-emb', embRaw: embBuf, scalesRaw: scalesBuf,
          width: w, height: h, nBands: store.meta.nBands, bands: this.opts.bands,
        }, [embBuf, scalesBuf]);
      }

      let canvas: HTMLCanvasElement | null = null;
      let sourceId: string | null = null;
      let layerId: string | null = null;

      if ((result.nValid as number) > 0) {
        canvas = rgbaToCanvas(result.rgba as ArrayBuffer, w, h);
        ({ sourceId, layerId } = this.addChunkToMap(ci, cj, canvas));
      }

      this.chunkCache.set(key, {
        ci, cj,
        canvas, sourceId, layerId, isPreview: usePreview,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.chunkCache.set(key, {
        ci, cj,
        canvas: null, sourceId: null, layerId: null, isPreview: false,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: map layer operations
  // ---------------------------------------------------------------------------

  private addChunkToMap(ci: number, cj: number, canvas: HTMLCanvasElement) {
    const key = this.chunkKey(ci, cj);
    const sourceId = `zarr-chunk-src-${key}`;
    const layerId = `zarr-chunk-lyr-${key}`;
    const corners = this.chunkCorners(ci, cj);
    const dataUrl = canvas.toDataURL('image/png');

    if (this.map!.getLayer(layerId)) this.map!.removeLayer(layerId);
    if (this.map!.getSource(sourceId)) this.map!.removeSource(sourceId);

    this.map!.addSource(sourceId, {
      type: 'image', url: dataUrl, coordinates: corners,
    });
    this.map!.addLayer({
      id: layerId, type: 'raster', source: sourceId,
      paint: { 'raster-opacity': this.opts.opacity, 'raster-fade-duration': 0 },
    });

    this.raiseOverlayLayers();
    return { sourceId, layerId };
  }

  private removeChunkFromMap(key: string): void {
    const entry = this.chunkCache.get(key);
    if (!entry) return;
    try {
      if (entry.layerId && this.map?.getLayer(entry.layerId)) this.map.removeLayer(entry.layerId);
      if (entry.sourceId && this.map?.getSource(entry.sourceId)) this.map.removeSource(entry.sourceId);
    } catch { /* ignore */ }
    entry.sourceId = null;
    entry.layerId = null;
  }

  // ---------------------------------------------------------------------------
  // Private: preview layer
  // ---------------------------------------------------------------------------

  private addPreviewLayer(): void {
    if (!this.map || !this.opts.globalPreviewUrl) return;

    this.removePreviewLayer();

    const variable = 'rgb';
    const sourceId = 'zarr-global-preview-src';
    const layerId = 'zarr-global-preview-lyr';

    // If the shared preview layer already exists (added by another zone source),
    // just take ownership so updateVisibleChunks() gates correctly.
    if (this.map.getLayer(layerId)) {
      this.previewSourceId = sourceId;
      this.previewLayerId = layerId;
      return;
    }

    try {
      this.map.addSource(sourceId, {
        type: 'raster',
        tiles: [`zarr://${this.opts.globalPreviewUrl}/${variable}/{z}/{x}/{y}`],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 14,
      });

      this.map.addLayer({
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: {
          'raster-opacity': this.opts.opacity,
          'raster-fade-duration': 200,
        },
      });

      this.previewSourceId = sourceId;
      this.previewLayerId = layerId;

      // Remove legacy preview chunk layers
      for (const [key, entry] of this.chunkCache) {
        if (entry.isPreview) this.removeChunkFromMap(key);
      }

      this.raiseOverlayLayers();
    } catch (err) {
      this.previewLayerId = null;
      this.previewSourceId = null;
    }
  }

  private removePreviewLayer(): void {
    if (!this.map) return;
    try {
      if (this.previewLayerId && this.map.getLayer(this.previewLayerId)) this.map.removeLayer(this.previewLayerId);
      if (this.previewSourceId && this.map.getSource(this.previewSourceId)) this.map.removeSource(this.previewSourceId);
    } catch { /* already removed */ }
    this.previewLayerId = null;
    this.previewSourceId = null;
  }

  // ---------------------------------------------------------------------------
  // Private: overlay layer ordering
  // ---------------------------------------------------------------------------

  private raiseOverlayLayers(): void {
    if (!this.map) return;
    const style = this.map.getStyle();
    if (!style?.layers) return;
    // Collect layer IDs in a single pass, then move in order
    const previewLayers: string[] = [];
    const chunkLayers: string[] = [];
    const classLayers: string[] = [];
    for (const layer of style.layers) {
      if (layer.id === 'zarr-global-preview-lyr') previewLayers.push(layer.id);
      else if (layer.id.startsWith('zarr-chunk-lyr-')) chunkLayers.push(layer.id);
      else if (layer.id.startsWith('zarr-class-lyr-')) classLayers.push(layer.id);
    }
    // Preview tiles (lowest -- embeddings raster)
    for (const id of previewLayers) this.map.moveLayer(id);
    // Per-chunk embedding layers
    for (const id of chunkLayers) this.map.moveLayer(id);
    // Region loading animation (above preview + chunks)
    if (this.map.getLayer('zarr-region-anim-lyr')) this.map.moveLayer('zarr-region-anim-lyr');
    // RGB region canvas
    if (this.map.getLayer('zarr-rgb-overlay-lyr')) this.map.moveLayer('zarr-rgb-overlay-lyr');
    // Similarity overlay (single region-wide layer)
    if (this.map.getLayer('zarr-sim-overlay-lyr')) this.map.moveLayer('zarr-sim-overlay-lyr');
    for (const id of classLayers) this.map.moveLayer(id);
    // Label pixel polygons (training labels for classifier)
    if (this.map.getLayer('label-pixels-fill')) this.map.moveLayer('label-pixels-fill');
    if (this.map.getLayer('label-pixels-line')) this.map.moveLayer('label-pixels-line');
    // ROI polygon outlines should be above classification overlays
    if (this.map.getLayer('roi-regions-fill')) this.map.moveLayer('roi-regions-fill');
    if (this.map.getLayer('roi-regions-line')) this.map.moveLayer('roi-regions-line');
    // Pixel hover highlight (explorer mode)
    if (this.map.getLayer('pixel-hover-glow')) this.map.moveLayer('pixel-hover-glow');
    if (this.map.getLayer('pixel-hover-fill')) this.map.moveLayer('pixel-hover-fill');
    if (this.map.getLayer('pixel-hover-line')) this.map.moveLayer('pixel-hover-line');
    // Similarity reference marker
    if (this.map.getLayer('sim-ref-marker-ring')) this.map.moveLayer('sim-ref-marker-ring');
    if (this.map.getLayer('sim-ref-marker-dot')) this.map.moveLayer('sim-ref-marker-dot');
    // Vector overlay should be topmost (above all embeddings/overlays)
    for (const vid of [
      'vector-landuse', 'vector-landcover', 'vector-water-fill', 'vector-waterway',
      'vector-water-line', 'vector-aeroway', 'vector-boundary',
      'vector-roads', 'vector-rail', 'vector-paths',
      'vector-buildings', 'vector-road-labels',
      'vector-poi', 'vector-labels',
    ]) {
      if (this.map.getLayer(vid)) this.map.moveLayer(vid);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: debug helper
  // ---------------------------------------------------------------------------

  private debug(type: DebugLogEntry['type'], msg: string): void {
    this.source.emit('debug', { time: Date.now(), type, msg });
  }
}
