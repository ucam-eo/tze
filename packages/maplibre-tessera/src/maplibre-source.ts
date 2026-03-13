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
  /** Tracks active loading animations per chunk key -> animation frame ID. */
  private loadingAnimations = new Map<string, number>();
  /** Per-tile download progress (0..1), keyed by chunk key. */
  private tileProgress = new Map<string, number>();
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
    for (const [, frameId] of this.loadingAnimations) cancelAnimationFrame(frameId);
    this.loadingAnimations.clear();
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

    // Start per-tile loading animations for all chunks
    for (const { ci, cj } of chunks) {
      if (!this.source.regionHasTile(ci, cj)) {
        this.startLoadingAnimation(ci, cj);
      }
    }

    await this.source.loadChunks(chunks, {
      onProgress: (loaded, total, chunk) => {
        this.stopLoadingAnimation(chunk.ci, chunk.cj);
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
    const loadLayers: string[] = [];
    const classLayers: string[] = [];
    for (const layer of style.layers) {
      if (layer.id === 'zarr-global-preview-lyr') previewLayers.push(layer.id);
      else if (layer.id.startsWith('zarr-chunk-lyr-')) chunkLayers.push(layer.id);
      else if (layer.id.startsWith('zarr-load-lyr-')) loadLayers.push(layer.id);
      else if (layer.id.startsWith('zarr-class-lyr-')) classLayers.push(layer.id);
    }
    // Preview tiles (lowest -- embeddings raster)
    for (const id of previewLayers) this.map.moveLayer(id);
    // Per-chunk embedding layers
    for (const id of chunkLayers) this.map.moveLayer(id);
    // Region loading animation (above preview, below overlays)
    if (this.map.getLayer('zarr-region-anim-lyr')) this.map.moveLayer('zarr-region-anim-lyr');
    // RGB region canvas
    if (this.map.getLayer('zarr-rgb-overlay-lyr')) this.map.moveLayer('zarr-rgb-overlay-lyr');
    for (const id of loadLayers) this.map.moveLayer(id);
    // Similarity overlay (single region-wide layer)
    if (this.map.getLayer('zarr-sim-overlay-lyr')) this.map.moveLayer('zarr-sim-overlay-lyr');
    for (const id of classLayers) this.map.moveLayer(id);
    // Label pixel polygons (training labels for classifier)
    if (this.map.getLayer('label-pixels-fill')) this.map.moveLayer('label-pixels-fill');
    if (this.map.getLayer('label-pixels-line')) this.map.moveLayer('label-pixels-line');
    // ROI polygon outlines should be above classification overlays
    if (this.map.getLayer('roi-regions-fill')) this.map.moveLayer('roi-regions-fill');
    if (this.map.getLayer('roi-regions-line')) this.map.moveLayer('roi-regions-line');
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
  // Private: loading animations
  // ---------------------------------------------------------------------------

  /** Start a scanning animation overlay on a tile while embeddings load. */
  private startLoadingAnimation(ci: number, cj: number): void {
    if (!this.map) return;
    const key = this.chunkKey(ci, cj);

    // Stop any existing animation for this tile
    if (this.loadingAnimations.has(key)) {
      cancelAnimationFrame(this.loadingAnimations.get(key)!);
    }

    const sourceId = `zarr-load-src-${key}`;
    const layerId = `zarr-load-lyr-${key}`;
    const corners = this.chunkCorners(ci, cj);
    const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
    const h = r1 - r0;
    const w = c1 - c0;

    // Create the animation canvas
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    // Capture existing tile pixels for background distortion
    const existing = this.chunkCache.get(key);
    let bgPixels: ImageData | null = null;
    if (existing?.canvas) {
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const tmpCtx = tmp.getContext('2d')!;
      tmpCtx.drawImage(existing.canvas, 0, 0, w, h);
      bgPixels = tmpCtx.getImageData(0, 0, w, h);
    }

    // If no preview tile, capture the basemap pixels from the map canvas.
    if (!bgPixels && this.map) {
      try {
        const mapCanvas = this.map.getCanvas();
        const tl = this.map.project(corners[0] as [number, number]);
        const tr = this.map.project(corners[1] as [number, number]);
        const br = this.map.project(corners[2] as [number, number]);
        const bl = this.map.project(corners[3] as [number, number]);
        const sx = Math.round(Math.min(tl.x, bl.x));
        const sy = Math.round(Math.min(tl.y, tr.y));
        const sw = Math.round(Math.max(tr.x, br.x)) - sx;
        const sh = Math.round(Math.max(bl.y, br.y)) - sy;
        if (sw > 0 && sh > 0) {
          const tmp = document.createElement('canvas');
          tmp.width = w;
          tmp.height = h;
          const tmpCtx = tmp.getContext('2d')!;
          tmpCtx.drawImage(mapCanvas, sx, sy, sw, sh, 0, 0, w, h);
          const captured = tmpCtx.getImageData(0, 0, w, h);
          // Verify pixels aren't all blank (WebGL preserveDrawingBuffer=false yields zeros)
          let nonZero = 0;
          const d = captured.data;
          for (let i = 0; i < d.length; i += 40) { if (d[i] || d[i + 1] || d[i + 2]) { nonZero++; } }
          if (nonZero > 0) bgPixels = captured;
        }
      } catch { /* ignore CORS/security errors on map canvas read */ }
    }

    // Simple hash for pseudo-random per-pixel noise
    const rng = (x: number) => {
      x = ((x >> 16) ^ x) * 0x45d9f3b;
      x = ((x >> 16) ^ x) * 0x45d9f3b;
      return ((x >> 16) ^ x) & 0xff;
    };

    const renderFrame = (canvas: HTMLCanvasElement, t: number) => {
      const ctx = canvas.getContext('2d')!;
      const progress = this.tileProgress.get(key) ?? 0;
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(w, h) * 0.30;
      const tau = Math.PI * 2;

      // --- Background: distorted RGB tile ---
      if (bgPixels) {
        const src = bgPixels.data;
        const out = ctx.createImageData(w, h);
        const dst = out.data;
        const glitchIntensity = 1.0 - progress;
        const tSec = t / 1000;

        // Chromatic aberration offset (pixels)
        const caOffset = Math.round(3 + 6 * glitchIntensity * (0.5 + 0.5 * Math.sin(tSec * 2.3)));

        // Glitch band: a horizontal band that shifts pixels sideways
        const glitchBandY = Math.floor((t * 0.15) % h);
        const glitchBandH = Math.floor(8 + 20 * glitchIntensity);
        const glitchShift = Math.floor((Math.sin(tSec * 7.1) * 12 + Math.sin(tSec * 13.3) * 6) * glitchIntensity);

        for (let y = 0; y < h; y++) {
          const scanline = y % 2 === 0 ? 1.0 : (0.85 + 0.15 * progress);
          const inGlitchBand = y >= glitchBandY && y < glitchBandY + glitchBandH;
          const lineShift = inGlitchBand ? glitchShift : 0;

          for (let x = 0; x < w; x++) {
            const di = (y * w + x) * 4;
            const sx = x + lineShift;
            const rX = Math.max(0, Math.min(w - 1, sx + caOffset));
            const gX = Math.max(0, Math.min(w - 1, sx));
            const bX = Math.max(0, Math.min(w - 1, sx - caOffset));

            const rI = (y * w + rX) * 4;
            const gI = (y * w + gX) * 4;
            const bI = (y * w + bX) * 4;

            let r = src[rI];
            let g = src[gI + 1];
            let b = src[bI + 2];

            const shift = 0.3 * glitchIntensity;
            r = Math.round(r * (1 - shift * 0.7));
            g = Math.round(g * (1 + shift * 0.15));
            b = Math.round(b * (1 + shift * 0.3));

            const wave = Math.sin(tSec * 3 + y * 0.05 + x * 0.02) * 0.5 + 0.5;
            const quantize = glitchIntensity * wave;
            if (quantize > 0.2) {
              const levels = 6;
              r = Math.round(Math.round(r / 255 * levels) / levels * 255);
              g = Math.round(Math.round(g / 255 * levels) / levels * 255);
              b = Math.round(Math.round(b / 255 * levels) / levels * 255);
            }

            const pulse = 1.0 + 0.15 * glitchIntensity * Math.sin(tSec * 4 - y * 0.03);
            r = Math.min(255, Math.round(r * pulse));
            g = Math.min(255, Math.round(g * pulse));
            b = Math.min(255, Math.round(b * pulse));

            if (inGlitchBand && Math.random() < 0.08 * glitchIntensity) {
              const n = rng(x * 7919 + y * 6271 + (t | 0)) & 0x3f;
              r = n; g = n + 40; b = n + 50;
            }

            const alpha = Math.round(200 + 55 * (1 - progress));
            dst[di]     = Math.min(255, r * scanline) | 0;
            dst[di + 1] = Math.min(255, g * scanline) | 0;
            dst[di + 2] = Math.min(255, b * scanline) | 0;
            dst[di + 3] = alpha;
          }
        }

        ctx.putImageData(out, 0, 0);

        const vg = ctx.createRadialGradient(cx, cy, radius * 0.8, cx, cy, Math.max(w, h) * 0.8);
        vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
        vg.addColorStop(1, `rgba(0, 5, 10, ${0.4 + 0.3 * glitchIntensity})`);
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, w, h);
      } else {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = `rgba(0, 8, 12, ${0.15 + 0.10 * (1 - progress)})`;
        ctx.fillRect(0, 0, w, h);

        const tSec = t / 1000;
        const gridSpacing = 16;
        const glitchIntensity = 1.0 - progress;

        ctx.strokeStyle = `rgba(0, 229, 255, ${0.04 + 0.03 * glitchIntensity})`;
        ctx.lineWidth = 0.5;
        for (let x = 0; x < w; x += gridSpacing) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
        for (let y = 0; y < h; y += gridSpacing) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }

        const scanY = (tSec * 80) % (h + 40) - 20;
        const scanGrad = ctx.createLinearGradient(0, scanY - 20, 0, scanY + 20);
        scanGrad.addColorStop(0, 'rgba(0, 229, 255, 0)');
        scanGrad.addColorStop(0.5, `rgba(0, 229, 255, ${0.12 * glitchIntensity})`);
        scanGrad.addColorStop(1, 'rgba(0, 229, 255, 0)');
        ctx.fillStyle = scanGrad;
        ctx.fillRect(0, scanY - 20, w, 40);

        const bracketLen = Math.min(w, h) * 0.1;
        const bracketInset = 6;
        ctx.strokeStyle = `rgba(0, 229, 255, ${0.15 + 0.1 * Math.sin(tSec * 2)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(bracketInset, bracketInset + bracketLen); ctx.lineTo(bracketInset, bracketInset); ctx.lineTo(bracketInset + bracketLen, bracketInset); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(w - bracketInset - bracketLen, bracketInset); ctx.lineTo(w - bracketInset, bracketInset); ctx.lineTo(w - bracketInset, bracketInset + bracketLen); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bracketInset, h - bracketInset - bracketLen); ctx.lineTo(bracketInset, h - bracketInset); ctx.lineTo(bracketInset + bracketLen, h - bracketInset); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(w - bracketInset - bracketLen, h - bracketInset); ctx.lineTo(w - bracketInset, h - bracketInset); ctx.lineTo(w - bracketInset, h - bracketInset - bracketLen); ctx.stroke();
      }

      // --- HUD overlay: spinning rings + progress arc ---
      const spin1 = (t / 600) % tau;
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.15, spin1, spin1 + tau * 0.7);
      ctx.stroke();

      const spin2 = -(t / 900) % tau;
      ctx.setLineDash([4, 8]);
      ctx.strokeStyle = 'rgba(0, 180, 220, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.30, spin2, spin2 + tau);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = 'rgba(0, 229, 255, 0.1)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * tau;
        const inner = radius * 1.02;
        const outer = i % 9 === 0 ? radius * 1.12 : radius * 1.06;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
        ctx.stroke();
      }

      const arcEnd = progress * tau;
      const arcStart = -Math.PI / 2;
      if (progress > 0) {
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.2)';
        ctx.lineWidth = Math.max(6, radius * 0.20);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(cx, cy, radius, arcStart, arcStart + arcEnd);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(0, 229, 255, 0.9)';
        ctx.lineWidth = Math.max(2, radius * 0.08);
        ctx.beginPath();
        ctx.arc(cx, cy, radius, arcStart, arcStart + arcEnd);
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(0, 229, 255, 0.06)';
      ctx.lineWidth = Math.max(2, radius * 0.08);
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, arcStart + arcEnd, arcStart + tau);
      ctx.stroke();

      if (progress > 0 && progress < 1) {
        const tipAngle = arcStart + arcEnd;
        const tx = cx + Math.cos(tipAngle) * radius;
        const ty = cy + Math.sin(tipAngle) * radius;
        const dotGlow = ctx.createRadialGradient(tx, ty, 0, tx, ty, radius * 0.15);
        dotGlow.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
        dotGlow.addColorStop(0.3, 'rgba(0, 229, 255, 0.5)');
        dotGlow.addColorStop(1, 'rgba(0, 229, 255, 0)');
        ctx.fillStyle = dotGlow;
        ctx.fillRect(tx - radius * 0.15, ty - radius * 0.15, radius * 0.3, radius * 0.3);
      }

      const pct = Math.round(progress * 100);
      const fontSize = Math.max(10, Math.round(radius * 0.40));
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgba(0, 229, 255, ${0.8 + 0.2 * Math.sin(t / 400)})`;
      ctx.fillText(`${pct}%`, cx, cy - fontSize * 0.15);

      const subSize = Math.max(7, Math.round(radius * 0.15));
      ctx.font = `${subSize}px monospace`;
      ctx.fillStyle = 'rgba(0, 229, 255, 0.3)';
      ctx.fillText('ACQUIRING', cx, cy + fontSize * 0.65);
    };

    // Initial frame
    renderFrame(canvas, performance.now());
    const dataUrl = canvas.toDataURL('image/png');

    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

    this.map.addSource(sourceId, {
      type: 'image', url: dataUrl, coordinates: corners,
    });
    this.map.addLayer({
      id: layerId, type: 'raster', source: sourceId,
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
    });
    this.raiseOverlayLayers();

    // Animation loop -- throttle updateImage to avoid MapLibre AbortError spam.
    let lastPush = 0;
    let pendingUpdate = false;
    const PUSH_INTERVAL = 150;

    const animate = (t: number) => {
      if (!this.map || !this.map.getSource(sourceId)) return;
      renderFrame(canvas, t);

      if (t - lastPush >= PUSH_INTERVAL && !pendingUpdate) {
        pendingUpdate = true;
        lastPush = t;
        const url = canvas.toDataURL('image/png');
        const src = this.map.getSource(sourceId) as
          { updateImage?: (opts: { url: string; coordinates: [number, number][] }) => unknown } | undefined;
        try {
          const result = src?.updateImage?.({ url, coordinates: corners });
          if (result && typeof (result as any).then === 'function') {
            (result as any).then(() => { pendingUpdate = false; }, () => { pendingUpdate = false; });
          } else {
            pendingUpdate = false;
          }
        } catch { pendingUpdate = false; }
      }

      this.loadingAnimations.set(key, requestAnimationFrame(animate));
    };
    this.loadingAnimations.set(key, requestAnimationFrame(animate));
  }

  /** Stop and remove loading animation for a tile. */
  private stopLoadingAnimation(ci: number, cj: number): void {
    if (!this.map) return;
    const key = this.chunkKey(ci, cj);
    this.tileProgress.delete(key);
    const frameId = this.loadingAnimations.get(key);
    if (frameId != null) {
      cancelAnimationFrame(frameId);
      this.loadingAnimations.delete(key);
    }
    const layerId = `zarr-load-lyr-${key}`;
    const sourceId = `zarr-load-src-${key}`;
    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  }

  // ---------------------------------------------------------------------------
  // Private: debug helper
  // ---------------------------------------------------------------------------

  private debug(type: DebugLogEntry['type'], msg: string): void {
    this.source.emit('debug', { time: Date.now(), type, msg });
  }
}
