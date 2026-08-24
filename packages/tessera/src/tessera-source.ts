import { EventEmitter } from './event-emitter.js';
import { UtmProjection } from './projection.js';
import { openStore, openArray, fetchRegion, type ZarrStore } from './zarr-reader.js';
import { dequantiseNCHW } from './dequantise.js';
import { depthWindowCost, groupTilesByChunk, type DepthWindowResult, type TileGroup } from './depths.js';
import type {
  TesseraOptions,
  StoreMetadata,
  TileStatistics,
  ChunkRef,
  EmbeddingRegion,
  EmbeddingAt,
  EmbeddingProgress,
  TesseraEvents,
  UtmBounds,
  ChunkBounds,
  DebugLogEntry,
} from './types.js';


// ---------------------------------------------------------------------------
// Geometry helpers for chunk–polygon overlap
// ---------------------------------------------------------------------------

/** Do two line segments (a→b) and (c→d) properly cross each other? */
function segsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
      && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Does any edge of the polygon ring cross the axis-aligned rectangle? */
function polyEdgeCrossesRect(
  ring: [number, number][],
  minE: number, maxE: number, minN: number, maxN: number,
): boolean {
  // 4 rectangle edges
  const rectEdges: [number, number, number, number][] = [
    [minE, minN, maxE, minN], // bottom
    [maxE, minN, maxE, maxN], // right
    [maxE, maxN, minE, maxN], // top
    [minE, maxN, minE, minN], // left
  ];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    for (const [cx, cy, dx, dy] of rectEdges) {
      if (segsCross(ax, ay, bx, by, cx, cy, dx, dy)) return true;
    }
  }
  return false;
}

/**
 * Options for {@link TesseraSource.loadChunks}.
 */
export interface LoadChunksOptions {
  /** AbortSignal to cancel in-flight fetches. */
  signal?: AbortSignal;

  /**
   * Progress callback invoked after each chunk completes.
   * @param loaded - Number of chunks finished so far.
   * @param total - Total number of chunks requested.
   * @param chunk - The chunk that just completed.
   */
  onProgress?: (loaded: number, total: number, chunk: ChunkRef) => void;

  /**
   * Embedding dimensions to load, from {@link TesseraSource.depths}.
   *
   * @remarks
   * Defaults to the store's full depth. A value differing from the live
   * region's width discards that region and reloads at the new depth, since
   * one buffer cannot hold two widths — that is how an upgrade happens.
   */
  depth?: number;
}

/**
 * Framework-agnostic data-access layer for a single TESSERA Zarr store.
 *
 * @remarks
 * Handles store opening, chunk loading with dequantisation, embedding
 * queries, and coordinate conversions. Contains no rendering or
 * map-framework code — those concerns live in framework-specific
 * wrappers (e.g. `MaplibreTesseraSource`).
 *
 * @example
 * ```typescript
 * const source = new TesseraSource({ url: 'https://example.com/zarr' });
 * const meta = await source.open();
 * const chunks = source.getChunksInRegion(polygon);
 * const region = await source.loadChunks(chunks);
 * const emb = source.getEmbeddingAt(13.4, 52.5);
 * ```
 */
export class TesseraSource extends EventEmitter<TesseraEvents> {
  private readonly url: string;
  private readonly concurrency: number;
  private store: ZarrStore | null = null;
  private proj: UtmProjection | null = null;
  private currentAbort: AbortController | null = null;

  /** Contiguous embedding buffer for all loaded tiles. */
  private _embeddingRegion: EmbeddingRegion | null = null;

  /** Lazily opened matryoshka depth arrays, keyed by array name. */
  private depthArrays = new Map<string, ReturnType<typeof openArray>>();

  /**
   * @param opts - Configuration for the Zarr store connection.
   */
  constructor(opts: TesseraOptions) {
    super();
    this.url = opts.url;
    this.concurrency = opts.concurrency ?? 4;
  }

  // ---------------------------------------------------------------------------
  // Read-only accessors
  // ---------------------------------------------------------------------------

  /** The current embedding region, or `null` if no chunks are loaded. */
  get embeddingRegion(): EmbeddingRegion | null {
    return this._embeddingRegion;
  }

  /** Dimensions the live region was loaded at, or `null` if none is loaded. */
  get regionDepth(): number | null {
    return this._embeddingRegion?.nBands ?? null;
  }

  /** Store metadata, available after {@link open}. */
  get metadata(): StoreMetadata | null {
    return this.store?.meta ?? null;
  }

  /** The UTM projection, available after {@link open}. */
  get projection(): UtmProjection | null {
    return this.proj;
  }

  /** Number of tiles that have been loaded into the embedding region. */
  get tileCount(): number {
    const r = this._embeddingRegion;
    if (!r) return 0;
    let n = 0;
    for (let i = 0; i < r.loaded.length; i++) if (r.loaded[i]) n++;
    return n;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Open the Zarr store, read metadata, and prepare the projection.
   *
   * @returns The store metadata.
   * @throws If the store cannot be opened or is missing required attributes.
   */
  async open(): Promise<StoreMetadata> {
    this.debug('fetch', `Opening store: ${this.url}`);
    this.store = await openStore(this.url);
    this.proj = new UtmProjection(this.store.meta.epsg);
    this.debug('info', `Store opened: zone ${this.store.meta.utmZone}, EPSG:${this.store.meta.epsg}, ${this.store.meta.nBands} bands`);
    this.debug('info', `Shape: ${this.store.meta.shape.join('x')}, chunks: ${this.store.meta.chunkShape.join('x')}`);
    this.emit('metadata-loaded', this.store.meta);
    return this.store.meta;
  }

  /**
   * Close the source, cancelling any in-flight requests and releasing
   * the embedding region.
   */
  close(): void {
    this.currentAbort?.abort();
    this.currentAbort = null;
    this._embeddingRegion = null;
    this.store = null;
    this.proj = null;
    this.depthArrays.clear();
  }

  // ---------------------------------------------------------------------------
  // Chunk loading
  // ---------------------------------------------------------------------------

  /**
   * Load a batch of embedding chunks with parallel concurrency.
   *
   * @remarks
   * Creates or grows the {@link EmbeddingRegion} to cover the requested
   * chunks. Each chunk's int8 embeddings are dequantised inline using
   * per-pixel scale factors: `value = int8 * scale`. Invalid pixels
   * (zero / NaN / non-finite scales) are set to `NaN`.
   *
   * @param chunks - Chunk references to load.
   * @param opts - Optional abort signal and progress callback.
   * @returns The embedding region containing the loaded data.
   */
  async loadChunks(
    chunks: ChunkRef[],
    opts?: LoadChunksOptions,
  ): Promise<EmbeddingRegion> {
    if (!this.store || chunks.length === 0) {
      return this._embeddingRegion ?? this.createEmptyRegion();
    }

    // Cancel any previous load
    this.currentAbort?.abort();
    const abort = new AbortController();
    this.currentAbort = abort;

    // Compute grid bounds for this batch
    let ciMin = Infinity, ciMax = -Infinity, cjMin = Infinity, cjMax = -Infinity;
    for (const { ci, cj } of chunks) {
      if (ci < ciMin) ciMin = ci;
      if (ci > ciMax) ciMax = ci;
      if (cj < cjMin) cjMin = cj;
      if (cj > cjMax) cjMax = cj;
    }

    const depth = opts?.depth ?? this.store.meta.nBands;
    // A different width means a different buffer: drop the old region rather
    // than mixing depths in one allocation.
    if (this._embeddingRegion && this._embeddingRegion.nBands !== depth) {
      this.debug('info', `Reloading region at ${depth}d (was ${this._embeddingRegion.nBands}d)`);
      this.clearRegion();
    }

    // Create or grow the region
    this.ensureRegion(ciMin, ciMax, cjMin, cjMax, depth);

    const total = chunks.length;
    this.debug('fetch', `Region download started: ${total} tiles at ${depth}d [${ciMin},${ciMax}]x[${cjMin},${cjMax}]`);

    let loaded = 0;
    let succeeded = 0;
    const concurrency = this.concurrency;

    // Report a whole group at once: at shallow depths one read satisfies
    // several tiles, and progress counts tiles.
    const report = (group: TileGroup, ok: boolean) => {
      for (const tile of group.tiles) {
        if (ok) succeeded++;
        loaded++;
        opts?.onProgress?.(loaded, total, tile);
        this.emit('loading', { total, done: loaded });
      }
    };

    const groups = await this.planReads(chunks, depth);
    let cursor = 0;
    const next = async (): Promise<void> => {
      while (cursor < groups.length) {
        if (abort.signal.aborted || opts?.signal?.aborted) return;

        const group = groups[cursor++];
        const missing = group.tiles.filter(t => !this.regionHasTile(t.ci, t.cj));
        if (missing.length === 0) { report(group, true); continue; }

        try {
          await this.loadTileGroup({ ...group, tiles: missing }, depth, abort.signal);
          report(group, true);
        } catch (err) {
          if ((err as Error).name === 'AbortError') return;
          this.debug('error', `Failed to load tiles at [${group.r0},${group.c0}]: ${(err as Error).message}`);
          report(group, false);
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, groups.length) },
      () => next(),
    );
    await Promise.all(workers);

    this.debug('fetch', `Region download complete: ${succeeded}/${total} tiles at ${depth}d`);

    if (this.currentAbort === abort) {
      this.currentAbort = null;
    }

    return this._embeddingRegion!;
  }

  // ---------------------------------------------------------------------------
  // Embedding queries
  // ---------------------------------------------------------------------------

  /**
   * Extract the embedding vector at a WGS84 coordinate.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @returns The embedding with its tile/pixel location, or `null`
   *   if the coordinate is outside the data extent or the tile is
   *   not loaded.
   */
  getEmbeddingAt(lng: number, lat: number): EmbeddingAt | null {
    if (!this.store || !this.proj || !this._embeddingRegion) return null;
    const [e, n] = this.proj.forward(lng, lat);
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;

    const globalCol = Math.floor((e - originE) / px);
    const globalRow = Math.floor((originN - n) / px);
    if (globalCol < 0 || globalCol >= s[1] || globalRow < 0 || globalRow >= s[0]) return null;

    const ci = Math.floor(globalRow / cs[0]);
    const cj = Math.floor(globalCol / cs[1]);
    if (!this.regionHasTile(ci, cj)) return null;

    const region = this._embeddingRegion;
    const row = globalRow - ci * cs[0];
    const col = globalCol - cj * cs[1];
    if (row < 0 || row >= region.tileH || col < 0 || col >= region.tileW) return null;

    const tIdx = (ci - region.ciMin) * region.gridCols + (cj - region.cjMin);
    const pixBase = tIdx * region.tileW * region.tileH;
    const pixelIdx = row * region.tileW + col;
    const offset = (pixBase + pixelIdx) * region.nBands;

    if (isNaN(region.emb[offset])) return null;
    const embedding = region.emb.slice(offset, offset + region.nBands);
    return { embedding, ci, cj, row, col };
  }

  /**
   * Extract embeddings for all valid pixels in a kernel around a coordinate.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @param kernelSize - Side length of the square kernel (e.g. 3 for 3x3).
   * @returns Array of embeddings with their tile/pixel locations.
   */
  getEmbeddingsInKernel(lng: number, lat: number, kernelSize: number): EmbeddingAt[] {
    if (!this.store || !this.proj || !this._embeddingRegion) return [];
    const [e, n] = this.proj.forward(lng, lat);
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;
    const region = this._embeddingRegion;

    const centerCol = Math.floor((e - originE) / px);
    const centerRow = Math.floor((originN - n) / px);
    const radius = Math.floor((kernelSize - 1) / 2);
    const results: EmbeddingAt[] = [];

    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const gr = centerRow + dr;
        const gc = centerCol + dc;
        if (gr < 0 || gr >= s[0] || gc < 0 || gc >= s[1]) continue;

        const ci = Math.floor(gr / cs[0]);
        const cj = Math.floor(gc / cs[1]);
        if (!this.regionHasTile(ci, cj)) continue;

        const row = gr - ci * cs[0];
        const col = gc - cj * cs[1];
        const tIdx = (ci - region.ciMin) * region.gridCols + (cj - region.cjMin);
        const pixBase = tIdx * region.tileW * region.tileH;
        const pixelIdx = row * region.tileW + col;
        const offset = (pixBase + pixelIdx) * region.nBands;

        if (isNaN(region.emb[offset])) continue;
        const embedding = region.emb.slice(offset, offset + region.nBands);
        results.push({ embedding, ci, cj, row, col });
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Coordinate conversion (applies spatial:transform from Zarr metadata)
  // ---------------------------------------------------------------------------

  /**
   * Convert a pixel address `(ci, cj, row, col)` to UTM coordinates.
   * Applies the `spatial:transform` affine from the store metadata.
   *
   * @returns `{ easting, northing }` at the pixel centre, or `null` if the store is not open.
   */
  pixelToUtm(ci: number, cj: number, row: number, col: number): { easting: number; northing: number } | null {
    if (!this.store) return null;
    const tf = this.store.meta.transform;
    const cs = this.store.meta.chunkShape;
    const globalRow = ci * cs[0] + row;
    const globalCol = cj * cs[1] + col;
    return {
      easting: tf[2] + (globalCol + 0.5) * tf[0],
      northing: tf[5] - (globalRow + 0.5) * tf[0],
    };
  }

  /**
   * Convert a pixel address to WGS84 lng/lat.
   *
   * @returns `[lng, lat]` at the pixel centre, or `null` if the store is not open.
   */
  pixelToLngLat(ci: number, cj: number, row: number, col: number): [number, number] | null {
    const utm = this.pixelToUtm(ci, cj, row, col);
    if (!utm || !this.proj) return null;
    return this.proj.inverse(utm.easting, utm.northing);
  }

  /**
   * Convert the global row/col array index for a pixel within a chunk.
   * This is the raw Zarr array index — use it for slicing operations.
   */
  pixelToGlobal(ci: number, cj: number, row: number, col: number): { globalRow: number; globalCol: number } {
    const cs = this.store!.meta.chunkShape;
    return { globalRow: ci * cs[0] + row, globalCol: cj * cs[1] + col };
  }

  /**
   * Convert a WGS84 coordinate to a pixel address.
   *
   * @returns `{ ci, cj, row, col }` or `null` if outside the data extent.
   */
  lngLatToPixel(lng: number, lat: number): { ci: number; cj: number; row: number; col: number } | null {
    if (!this.store || !this.proj) return null;
    const [e, n] = this.proj.forward(lng, lat);
    const tf = this.store.meta.transform;
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;
    const globalCol = Math.floor((e - tf[2]) / tf[0]);
    const globalRow = Math.floor((tf[5] - n) / tf[0]);
    if (globalCol < 0 || globalCol >= s[1] || globalRow < 0 || globalRow >= s[0]) return null;
    const ci = Math.floor(globalRow / cs[0]);
    const cj = Math.floor(globalCol / cs[1]);
    const row = globalRow - ci * cs[0];
    const col = globalCol - cj * cs[1];
    return { ci, cj, row, col };
  }

  // ---------------------------------------------------------------------------
  // Spatial queries
  // ---------------------------------------------------------------------------

  /**
   * Return the chunk indices containing a WGS84 point, or `null` if
   * the point is outside the data extent.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   */
  getChunkAtLngLat(lng: number, lat: number): ChunkRef | null {
    if (!this.store || !this.proj) return null;
    const [e, n] = this.proj.forward(lng, lat);
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;

    const col = Math.floor((e - originE) / px);
    const row = Math.floor((originN - n) / px);
    if (col < 0 || col >= s[1] || row < 0 || row >= s[0]) return null;

    const ci = Math.floor(row / cs[0]);
    const cj = Math.floor(col / cs[1]);
    return { ci, cj };
  }

  /**
   * Return all chunk indices whose bounding boxes intersect a polygon.
   *
   * @remarks
   * Projects the polygon to UTM, uses a one-tile buffer on the chunk
   * index range, then tests overlap via center-in-polygon and
   * vertex-in-chunk. Skips chunks not in the manifest (if available)
   * and chunks already loaded in the region.
   *
   * @param polygon - A GeoJSON Polygon (outer ring used).
   */
  getChunksInRegion(polygon: GeoJSON.Polygon): ChunkRef[] {
    // NOTE: tiles already in the region are omitted — this answers "what is
    // still missing", so a fully loaded polygon yields an empty list. Callers
    // that want the tiles a region covers regardless of load state must track
    // them, or clear the region first.
    if (!this.store || !this.proj) return [];

    // Convert polygon ring to UTM coordinates
    const coords = polygon.coordinates[0];
    const utmRing: [number, number][] = [];
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const coord of coords) {
      const [lng, lat] = coord;
      const [e, n] = this.proj.forward(lng, lat);
      utmRing.push([e, n]);
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
      if (n < minN) minN = n;
      if (n > maxN) maxN = n;
    }

    // Ray-casting point-in-polygon test (UTM coords)
    const pointInPoly = (px: number, py: number): boolean => {
      let inside = false;
      for (let i = 0, j = utmRing.length - 1; i < utmRing.length; j = i++) {
        const [xi, yi] = utmRing[i], [xj, yj] = utmRing[j];
        if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      return inside;
    };

    // Convert UTM bounds to chunk index ranges with a one-tile buffer
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;
    const t = this.store.meta.transform;
    const px = t[0];
    const originE = t[2];
    const originN = t[5];
    const nChunksRow = Math.ceil(s[0] / cs[0]);
    const nChunksCol = Math.ceil(s[1] / cs[1]);

    const cjMin = Math.max(0, Math.floor((minE - originE) / (cs[1] * px)) - 1);
    const cjMax = Math.min(nChunksCol - 1, Math.floor((maxE - originE) / (cs[1] * px)) + 1);
    const ciMin = Math.max(0, Math.floor((originN - maxN) / (cs[0] * px)) - 1);
    const ciMax = Math.min(nChunksRow - 1, Math.floor((originN - minN) / (cs[0] * px)) + 1);

    const chunkW = cs[1] * px;
    const chunkH = cs[0] * px;

    const result: ChunkRef[] = [];
    for (let ci = ciMin; ci <= ciMax; ci++) {
      for (let cj = cjMin; cj <= cjMax; cj++) {
        if (this.regionHasTile(ci, cj)) continue;

        // Chunk bounds in UTM
        const cMinE = originE + cj * chunkW;
        const cMaxE = cMinE + chunkW;
        const cMaxN = originN - ci * chunkH;
        const cMinN = cMaxN - chunkH;

        // Test overlap: chunk center/corners in polygon, polygon verts in chunk,
        // or polygon edges crossing chunk edges.
        const centerE = (cMinE + cMaxE) / 2;
        const centerN = (cMinN + cMaxN) / 2;
        let overlaps = pointInPoly(centerE, centerN)
          || pointInPoly(cMinE, cMinN) || pointInPoly(cMaxE, cMinN)
          || pointInPoly(cMinE, cMaxN) || pointInPoly(cMaxE, cMaxN);
        if (!overlaps) {
          for (const [e, n] of utmRing) {
            if (e >= cMinE && e <= cMaxE && n >= cMinN && n <= cMaxN) {
              overlaps = true;
              break;
            }
          }
        }
        // Polygon edge crosses chunk rectangle (catches thin sliver intersections)
        if (!overlaps) {
          overlaps = polyEdgeCrossesRect(utmRing, cMinE, cMaxE, cMinN, cMaxN);
        }

        if (overlaps) result.push({ ci, cj });
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Coordinate helpers
  // ---------------------------------------------------------------------------

  /**
   * Get the WGS84 corners of a chunk tile.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @returns `[topLeft, topRight, bottomRight, bottomLeft]` in `[lng, lat]`,
   *   or `null` if the store is not open.
   */
  getChunkBoundsLngLat(
    ci: number,
    cj: number,
  ): [[number, number], [number, number], [number, number], [number, number]] | null {
    if (!this.store || !this.proj) return null;
    return this.chunkCorners(ci, cj);
  }

  /**
   * Probe which years have real data for a given chunk position.
   *
   * @remarks
   * For v2 stores, fetches a single pixel from the scales array for each
   * time index and checks whether the value is the fill value (Infinity)
   * or real data. Uses zarrita internally so chunk key encoding and
   * sharding are handled automatically.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @returns Map of year → boolean (true = data exists). Empty map for v1 stores.
   */
  async probeYearData(ci: number, cj: number): Promise<Map<number, boolean>> {
    const result = new Map<number, boolean>();
    if (!this.store) return result;

    const meta = this.store.meta;
    if (meta.version !== 'v2' || !meta.years || meta.years.length === 0) return result;

    const cs = meta.chunkShape;
    const { r0, c0 } = this.chunkPixelBounds(ci, cj);

    // Sample a small strip across the tile (5 pixels at 20% intervals) to
    // handle partial tiles near coastlines where the corners may be ocean.
    const probeRows: number[] = [];
    const probeCols: number[] = [];
    for (let f = 0.2; f <= 0.8; f += 0.2) {
      probeRows.push(r0 + Math.floor(cs[0] * f));
      probeCols.push(c0 + Math.floor(cs[1] * f));
    }

    // Fetch a small region encompassing all probe points for each year
    const pr0 = probeRows[0];
    const pr1 = probeRows[probeRows.length - 1] + 1;
    const pc0 = probeCols[0];
    const pc1 = probeCols[probeCols.length - 1] + 1;
    const probeW = pc1 - pc0;

    const promises = meta.years.map(async (year, t) => {
      try {
        const view = await fetchRegion(
          this.store!.scalesArr,
          [[t, t + 1], [pr0, pr1], [pc0, pc1]],
        );
        const data = view.data as Float32Array;
        // Check if any probe point has valid data
        let found = false;
        for (let ri = 0; ri < probeRows.length && !found; ri++) {
          for (let ci2 = 0; ci2 < probeCols.length && !found; ci2++) {
            const idx = (probeRows[ri] - pr0) * probeW + (probeCols[ci2] - pc0);
            const val = data[idx];
            if (isFinite(val) && val !== 0) found = true;
          }
        }
        result.set(year, found);
      } catch {
        result.set(year, false);
      }
    });
    await Promise.all(promises);
    return result;
  }

  /**
   * Get the WGS84 corners of a single embedding pixel.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @param row - Pixel row within the chunk.
   * @param col - Pixel column within the chunk.
   * @returns `[topLeft, topRight, bottomRight, bottomLeft]` in `[lng, lat]`,
   *   or `null` if the store is not open.
   */
  getPixelBoundsLngLat(
    ci: number,
    cj: number,
    row: number,
    col: number,
  ): [[number, number], [number, number], [number, number], [number, number]] | null {
    if (!this.store || !this.proj) return null;
    const tf = this.store.meta.transform;
    const px = tf[0];
    const { globalRow, globalCol } = this.pixelToGlobal(ci, cj, row, col);
    const minE = tf[2] + globalCol * px;
    const maxE = minE + px;
    const maxN = tf[5] - globalRow * px;
    const minN = maxN - px;
    return this.proj.chunkCornersToLngLat({ minE, maxE, minN, maxN });
  }

  /**
   * Compute the WGS84 bounding box of all loaded embedding tiles.
   *
   * @returns `[south, west, north, east]` or `null` if no tiles are loaded.
   */
  embeddingBoundsLngLat(): [number, number, number, number] | null {
    const r = this._embeddingRegion;
    if (!r || this.tileCount === 0) return null;
    let south = 90, west = 180, north = -90, east = -180;
    for (let t = 0; t < r.loaded.length; t++) {
      if (!r.loaded[t]) continue;
      const ci = r.ciMin + Math.floor(t / r.gridCols);
      const cj = r.cjMin + (t % r.gridCols);
      const corners = this.chunkCorners(ci, cj);
      for (const [lng, lat] of corners) {
        if (lat < south) south = lat;
        if (lat > north) north = lat;
        if (lng < west) west = lng;
        if (lng > east) east = lng;
      }
    }
    return [south, west, north, east];
  }

  // ---------------------------------------------------------------------------
  // Region management
  // ---------------------------------------------------------------------------

  /**
   * Check whether a tile has been loaded into the embedding region.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   */
  regionHasTile(ci: number, cj: number): boolean {
    const r = this._embeddingRegion;
    if (!r) return false;
    if (ci < r.ciMin || ci > r.ciMax || cj < r.cjMin || cj > r.cjMax) return false;
    const t = (ci - r.ciMin) * r.gridCols + (cj - r.cjMin);
    return r.loaded[t] === 1;
  }

  /**
   * Zero out a tile's data and mark it as unloaded.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   */
  evictTile(ci: number, cj: number): void {
    const r = this._embeddingRegion;
    if (!r) return;
    if (ci < r.ciMin || ci > r.ciMax || cj < r.cjMin || cj > r.cjMax) return;
    const tIdx = (ci - r.ciMin) * r.gridCols + (cj - r.cjMin);
    if (!r.loaded[tIdx]) return;

    const tilePixels = r.tileW * r.tileH;
    const base = tIdx * tilePixels * r.nBands;
    r.emb.fill(NaN, base, base + tilePixels * r.nBands);
    r.loaded[tIdx] = 0;
  }

  /**
   * Discard the entire embedding region, releasing memory.
   */
  clearRegion(): void {
    this._embeddingRegion = null;
  }

  /**
   * Switch to a different time index (v2 stores only).
   * Clears all loaded embeddings and forces a reload.
   */
  setTimeIndex(timeIndex: number): void {
    if (!this.store || this.store.meta.version !== 'v2') return;
    this.store.meta.timeIndex = timeIndex;
    this.clearRegion();
  }

  /**
   * Set the active year (v2 stores only).
   * Resolves the year to a time index and clears loaded data.
   */
  setYear(year: number): void {
    if (!this.store || this.store.meta.version !== 'v2') return;
    const idx = this.store.meta.years?.indexOf(year) ?? -1;
    if (idx >= 0) this.setTimeIndex(idx);
  }

  // ---------------------------------------------------------------------------
  // Tile-level data access (public API for plugins)
  // ---------------------------------------------------------------------------

  /**
   * Fetch and dequantize the embeddings for a single tile.
   *
   * Returns a flat `Float32Array` of `tileH * tileW * nBands` floats
   * in row-major, band-last order. Invalid pixels have `NaN` in all bands.
   *
   * If the tile is already in the loaded embedding region, returns a copy
   * of that data without any HTTP requests. Otherwise fetches from the
   * remote Zarr store.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   */
  async fetchTileEmbeddings(ci: number, cj: number): Promise<{
    emb: Float32Array;
    nBands: number;
    tileW: number;
    tileH: number;
  } | null> {
    if (!this.store) return null;
    const meta = this.store.meta;
    const cs = meta.chunkShape;
    const nBands = meta.nBands;
    const tilePixels = cs[0] * cs[1];

    // Check loaded region first
    const region = this._embeddingRegion;
    if (region) {
      const tIdx = (ci - region.ciMin) * region.gridCols + (cj - region.cjMin);
      if (tIdx >= 0 && tIdx < region.loaded.length && region.loaded[tIdx]) {
        const base = tIdx * tilePixels * nBands;
        return {
          emb: region.emb.slice(base, base + tilePixels * nBands),
          nBands, tileW: region.tileW, tileH: region.tileH,
        };
      }
    }

    // Fetch from store — use global array indices from spatial:transform
    const { globalRow: r0, globalCol: c0 } = this.pixelToGlobal(ci, cj, 0, 0);
    const isV2 = meta.version === 'v2';
    const t = meta.timeIndex ?? (meta.years ? meta.years.length - 1 : 0);

    const [embView, scaleView] = await Promise.all([
      isV2
        ? fetchRegion(this.store.embArr, [[t, t + 1], null, [r0, r0 + cs[0]], [c0, c0 + cs[1]]])
        : fetchRegion(this.store.embArr, [[r0, r0 + cs[0]], [c0, c0 + cs[1]], null]),
      isV2
        ? fetchRegion(this.store.scalesArr, [[t, t + 1], [r0, r0 + cs[0]], [c0, c0 + cs[1]]])
        : fetchRegion(this.store.scalesArr, [[r0, r0 + cs[0]], [c0, c0 + cs[1]]]),
    ]);

    const int8 = new Int8Array(embView.data.buffer, embView.data.byteOffset, tilePixels * nBands);
    const scalesF32 = new Float32Array(scaleView.data.buffer, scaleView.data.byteOffset, tilePixels);

    const emb = new Float32Array(tilePixels * nBands);
    for (let p = 0; p < tilePixels; p++) {
      const s = scalesF32[p];
      const valid = s && !isNaN(s) && isFinite(s);
      const dst = p * nBands;
      if (valid) {
        if (isV2) {
          for (let b = 0; b < nBands; b++) emb[dst + b] = int8[b * tilePixels + p] * s;
        } else {
          for (let b = 0; b < nBands; b++) emb[dst + b] = int8[p * nBands + b] * s;
        }
      } else {
        emb[dst] = NaN;
      }
    }

    return { emb, nBands, tileW: cs[1], tileH: cs[0] };
  }

  /**
   * Matryoshka depths this store offers, ascending (e.g. `[4, 16, 128]`).
   *
   * Empty when the store ships only its full-depth embeddings array, or
   * before the store is open.
   */
  get depths(): number[] {
    return (this.store?.meta.geoemb_depths ?? []).map(d => d.dimensions);
  }

  /**
   * Fetch one pixel window at one matryoshka depth.
   *
   * @param opts - The depth to read and the window to read it over.
   * @param opts.depth - Dimensions per pixel; must be one of {@link depths}.
   * @param opts.r0 - First row of the window.
   * @param opts.c0 - First column of the window.
   * @param opts.height - Window height in pixels.
   * @param opts.width - Window width in pixels.
   * @param opts.timeIndex - Year to read, as an index into
   *   {@link StoreMetadata.years}. Defaults to the store's active year.
   * @param opts.signal - Optional abort signal.
   * @returns Dequantised embeddings and what the read cost, or `null` if the
   *   store is closed, offers no such depth, or the window is empty.
   *
   * @remarks
   * Reads the truncated array directly rather than slicing a full-depth
   * fetch, which is the point: the shallower arrays are byte-exact prefixes
   * of the full vector, so the values match what a full read would give
   * while transferring proportionally fewer bytes. Independent of the loaded
   * embedding region — it neither reads from nor writes to it.
   */
  async fetchDepthWindow(opts: {
    depth: number;
    r0: number;
    c0: number;
    height: number;
    width: number;
    timeIndex?: number;
    signal?: AbortSignal;
  }): Promise<DepthWindowResult | null> {
    if (!this.store) return null;
    const { depth, r0, c0, height, width, signal } = opts;
    if (height <= 0 || width <= 0) return null;

    const declared = (this.store.meta.geoemb_depths ?? [])
      .find(d => d.dimensions === depth);
    // Full depth is always readable from the array the store opened with,
    // even on a store that declares no depths at all.
    const arrayName = declared?.array
      ?? (depth === this.store.meta.nBands ? 'embeddings' : null);
    if (!arrayName) return null;

    const arr = await this.getDepthArray(arrayName);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const t = opts.timeIndex ?? this.store.meta.timeIndex ?? 0;
    const r1 = r0 + height;
    const c1 = c0 + width;

    const [embView, scaleView] = await Promise.all([
      fetchRegion(arr, [[t, t + 1], null, [r0, r1], [c0, c1]], { signal }),
      fetchRegion(this.store.scalesArr, [[t, t + 1], [r0, r1], [c0, c1]], { signal }),
    ]);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const pixels = height * width;
    const int8 = new Int8Array(
      embView.data.buffer, embView.data.byteOffset, pixels * depth,
    );
    const scalesF32 = new Float32Array(
      scaleView.data.buffer, scaleView.data.byteOffset, pixels,
    );

    const emb = new Float32Array(pixels * depth);
    dequantiseNCHW(int8, scalesF32, height, width, depth, emb, 0);

    // Chunk shape is [1, bands, rows, cols] for the NCHW layout.
    const chunks = arr.chunks as number[];
    const cost = depthWindowCost({ r0, c0, height, width }, chunks[2], chunks[3], depth);

    return { emb, nBands: depth, r0, c0, height, width, ...cost };
  }

  /** Open a depth array once and reuse the handle. */
  private getDepthArray(name: string): ReturnType<typeof openArray> {
    // The full-depth array is already open — don't open a second handle to it.
    if (name === 'embeddings') return Promise.resolve(this.store!.embArr);
    let arr = this.depthArrays.get(name);
    if (!arr) {
      arr = openArray(this.store!, name);
      this.depthArrays.set(name, arr);
    }
    return arr;
  }

  /**
   * Compute statistics for a tile's dequantized embeddings.
   *
   * Fetches the tile if not already loaded. Returns null if the tile
   * has no valid pixels.
   */
  async computeTileStatistics(ci: number, cj: number): Promise<TileStatistics | null> {
    const tile = await this.fetchTileEmbeddings(ci, cj);
    if (!tile) return null;
    return TesseraSource.statsFromBuffer(tile.emb, tile.tileW * tile.tileH, tile.nBands);
  }

  /** Compute stats from a flat embedding buffer (shared implementation). */
  static statsFromBuffer(emb: Float32Array, tilePixels: number, nBands: number): TileStatistics | null {
    let validCount = 0, sumNorm = 0, minN = Infinity, maxN = -Infinity;
    const meanEmb = new Float32Array(nBands);

    for (let p = 0; p < tilePixels; p++) {
      const off = p * nBands;
      if (isNaN(emb[off])) continue;
      validCount++;
      let normSq = 0;
      for (let b = 0; b < nBands; b++) {
        const v = emb[off + b];
        meanEmb[b] += v;
        normSq += v * v;
      }
      const norm = Math.sqrt(normSq);
      sumNorm += norm;
      if (norm < minN) minN = norm;
      if (norm > maxN) maxN = norm;
    }
    if (validCount === 0) return null;

    for (let b = 0; b < nBands; b++) meanEmb[b] /= validCount;

    let varSum = 0;
    for (let p = 0; p < tilePixels; p++) {
      const off = p * nBands;
      if (isNaN(emb[off])) continue;
      let distSq = 0;
      for (let b = 0; b < nBands; b++) {
        const d = emb[off + b] - meanEmb[b];
        distSq += d * d;
      }
      varSum += distSq;
    }

    return {
      validPixels: validCount,
      totalPixels: tilePixels,
      meanNorm: sumNorm / validCount,
      minNorm: minN,
      maxNorm: maxN,
      variance: varSum / validCount,
      fingerprint: meanEmb,
    };
  }

  /**
   * Fetch a single pixel's dequantized embedding across all time steps (v2 stores).
   *
   * Returns one entry per year that has valid data at this pixel.
   * Years where the scale factor is zero/NaN/Inf are skipped.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @param row - Pixel row within the chunk.
   * @param col - Pixel column within the chunk.
   * @returns Array of `{ year, embedding, norm }`, or empty if not v2 / no data.
   */
  async fetchTemporalPixel(
    ci: number, cj: number, row: number, col: number,
  ): Promise<{ year: number; embedding: Float32Array; norm: number }[]> {
    if (!this.store) return [];
    const meta = this.store.meta;
    if (meta.version !== 'v2' || !meta.years?.length) return [];

    const T = meta.years.length;
    const nBands = meta.nBands;
    const { globalRow: r0, globalCol: c0 } = this.pixelToGlobal(ci, cj, row, col);

    const [embView, scaleView] = await Promise.all([
      fetchRegion(this.store.embArr, [null, null, [r0, r0 + 1], [c0, c0 + 1]]),
      fetchRegion(this.store.scalesArr, [null, [r0, r0 + 1], [c0, c0 + 1]]),
    ]);

    const scales = new Float32Array(scaleView.data.buffer, scaleView.data.byteOffset, T);
    const int8All = new Int8Array(embView.data.buffer, embView.data.byteOffset, T * nBands);

    const results: { year: number; embedding: Float32Array; norm: number }[] = [];
    for (let t = 0; t < T; t++) {
      const scale = scales[t];
      if (!isFinite(scale) || scale === 0) continue;
      const emb = new Float32Array(nBands);
      let normSq = 0;
      for (let b = 0; b < nBands; b++) {
        emb[b] = int8All[t * nBands + b] * scale;
        normSq += emb[b] * emb[b];
      }
      results.push({ year: meta.years[t], embedding: emb, norm: Math.sqrt(normSq) });
    }
    return results;
  }

  /**
   * Find a valid pixel within a tile by probing candidate positions.
   *
   * Useful for coastal/partial tiles where many pixels are invalid (NaN scale).
   * Returns `{ row, col }` of the first valid pixel found, or `null`.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   */
  async findValidPixel(ci: number, cj: number): Promise<{ row: number; col: number } | null> {
    if (!this.store) return null;
    const meta = this.store.meta;
    const cs = meta.chunkShape;
    const isV2 = meta.version === 'v2';
    const t = meta.timeIndex ?? (meta.years ? meta.years.length - 1 : 0);

    const offsets = [0.5, 0.3, 0.7, 0.2, 0.8];
    for (const ry of offsets) {
      for (const cx of offsets) {
        const row = Math.floor(cs[0] * ry);
        const col = Math.floor(cs[1] * cx);
        const { globalRow: r, globalCol: c } = this.pixelToGlobal(ci, cj, row, col);
        const sv = await fetchRegion(
          this.store.scalesArr,
          isV2 ? [[t, t + 1], [r, r + 1], [c, c + 1]] : [[r, r + 1], [c, c + 1]],
        );
        const val = (sv.data as Float32Array)[0];
        if (isFinite(val) && val !== 0) return { row, col };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Internal: store access (for framework wrappers)
  // ---------------------------------------------------------------------------

  /**
   * Access the underlying Zarr store.
   * @internal
   */
  get _store(): ZarrStore | null {
    return this.store;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Decide which reads satisfy a set of tiles at a given depth.
   *
   * @remarks
   * On NCHW stores the array being read has its own chunk grid — coarser the
   * shallower the depth — so tiles are batched into whole chunks and each is
   * decoded once. At full depth chunk and tile coincide, giving one tile per
   * read exactly as before. HWB stores have no depth arrays, so each tile is
   * its own read and {@link loadTileGroup} routes them to the legacy path.
   */
  private async planReads(chunks: ChunkRef[], depth: number): Promise<TileGroup[]> {
    const meta = this.store!.meta;
    const [tileH, tileW] = meta.chunkShape;

    if (meta.version !== 'v2') {
      return chunks.map(tile => ({
        r0: tile.ci * tileH, c0: tile.cj * tileW,
        height: tileH, width: tileW, tiles: [tile],
      }));
    }

    const name = (meta.geoemb_depths ?? []).find(d => d.dimensions === depth)?.array
      ?? 'embeddings';
    const arr = await this.getDepthArray(name);
    const arrChunks = arr.chunks as number[];

    return groupTilesByChunk(
      chunks, tileH, tileW,
      arrChunks[2], arrChunks[3],
      meta.shape[0], meta.shape[1],
    );
  }

  /**
   * Read one chunk of the depth array and scatter it across the tiles it covers.
   *
   * @remarks
   * The region keeps its own tile grid whatever the depth, so a read spanning
   * several tiles is split back into them here. Tiles falling outside the
   * region, or rows and columns past the array edge, are skipped rather than
   * written at a wrapped offset.
   */
  private async loadTileGroup(
    group: TileGroup,
    depth: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const region = this._embeddingRegion;
    if (!region) return;

    // HWB stores keep the original per-tile path: their layout differs and
    // they never carry depth arrays.
    if (this.store!.meta.version !== 'v2') {
      for (const { ci, cj } of group.tiles) await this.loadSingleChunk(ci, cj, signal);
      return;
    }

    for (const tile of group.tiles) {
      this.emit('embedding-progress', {
        ci: tile.ci, cj: tile.cj, stage: 'fetching',
        bytes: group.height * group.width * depth / group.tiles.length,
      });
    }

    const block = await this.fetchDepthWindow({
      depth,
      r0: group.r0, c0: group.c0,
      height: group.height, width: group.width,
      signal,
    });
    if (!block) throw new Error(`depth ${depth} is not readable from this store`);

    const { tileH, tileW } = region;
    for (const { ci, cj } of group.tiles) {
      const tIdx = (ci - region.ciMin) * region.gridCols + (cj - region.cjMin);
      if (tIdx < 0 || tIdx >= region.loaded.length) continue;

      const rowOff = ci * tileH - block.r0;
      const colOff = cj * tileW - block.c0;

      for (let row = 0; row < tileH; row++) {
        const srcRow = rowOff + row;
        if (srcRow < 0 || srcRow >= block.height) continue;
        for (let col = 0; col < tileW; col++) {
          const srcCol = colOff + col;
          if (srcCol < 0 || srcCol >= block.width) continue;
          const src = (srcRow * block.width + srcCol) * depth;
          const dst = (tIdx * tileH * tileW + row * tileW + col) * depth;
          for (let b = 0; b < depth; b++) region.emb[dst + b] = block.emb[src + b];
        }
      }

      region.loaded[tIdx] = 1;
      this.emit('chunk-loaded', { ci, cj });
      this.emit('embeddings-loaded', { ci, cj });
    }
  }

  /**
   * Load and dequantise a single chunk into the embedding region.
   */
  private async loadSingleChunk(
    ci: number,
    cj: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.store) return;

    // Ensure region covers this chunk
    this.ensureRegion(ci, ci, cj, cj);

    const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
    const h = r1 - r0;
    const w = c1 - c0;
    const nBands = this.store.meta.nBands;
    const expectedBytes = w * h * nBands;

    this.emit('embedding-progress', {
      ci, cj, stage: 'fetching', bytes: expectedBytes,
    });

    // Check for abort before starting the fetch
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const isV2 = this.store.meta.version === 'v2';
    const t = this.store.meta.timeIndex ?? 0;

    let embView: { data: ArrayBufferView; shape: number[] };
    let scalesView: { data: ArrayBufferView; shape: number[] };

    if (isV2) {
      // v2 NCHW: embeddings[t, :, r0:r1, c0:c1], scales[t, r0:r1, c0:c1]
      [embView, scalesView] = await Promise.all([
        fetchRegion(this.store.embArr, [[t, t + 1], null, [r0, r1], [c0, c1]], { signal }),
        fetchRegion(this.store.scalesArr, [[t, t + 1], [r0, r1], [c0, c1]], { signal }),
      ]);
    } else {
      // v1 HWB: embeddings[r0:r1, c0:c1, :], scales[r0:r1, c0:c1]
      [embView, scalesView] = await Promise.all([
        fetchRegion(this.store.embArr, [[r0, r1], [c0, c1], null], { signal }),
        fetchRegion(this.store.scalesArr, [[r0, r1], [c0, c1]], { signal }),
      ]);
    }

    // Check for abort after fetch
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    this.emit('embedding-progress', {
      ci, cj, stage: 'rendering', bytes: expectedBytes,
    });

    // Copy into typed arrays for dequantisation
    const embInt8 = new Int8Array(
      embView.data.buffer, embView.data.byteOffset, embView.data.byteLength,
    ).slice();
    const scalesCopy = new Uint8Array(
      scalesView.data.buffer, scalesView.data.byteOffset, scalesView.data.byteLength,
    ).slice();
    const scalesF32 = new Float32Array(scalesCopy.buffer);

    // Dequantize directly into the region buffer (NaN for invalid pixels)
    const region = this._embeddingRegion;
    if (region) {
      const tIdx = (ci - region.ciMin) * region.gridCols + (cj - region.cjMin);
      const pixBase = tIdx * region.tileW * region.tileH;
      const embBase = pixBase * nBands;

      if (isV2) {
        // v2 NCHW: embInt8 is [1, B, h, w] — band-first, transposed on the way in
        dequantiseNCHW(embInt8, scalesF32, h, w, nBands, region.emb, embBase);
      } else {
        // v1 HWB: embInt8 is [h, w, B] — pixel-first layout
        for (let i = 0; i < h * w; i++) {
          const s = scalesF32[i];
          const valid = s && !isNaN(s) && isFinite(s);
          const dst = embBase + i * nBands;
          if (valid) {
            for (let b = 0; b < nBands; b++) region.emb[dst + b] = embInt8[i * nBands + b] * s;
          } else {
            for (let b = 0; b < nBands; b++) region.emb[dst + b] = NaN;
          }
        }
      }
      region.loaded[tIdx] = 1;
    }

    this.emit('embedding-progress', {
      ci, cj, stage: 'done', bytes: w * h * nBands * 4,
    });
    this.emit('chunk-loaded', { ci, cj });
    this.emit('embeddings-loaded', { ci, cj });
  }

  /**
   * Create or grow the EmbeddingRegion to cover the given chunk bounds.
   */
  private ensureRegion(
    ciMin: number,
    ciMax: number,
    cjMin: number,
    cjMax: number,
    nBands: number = this.store?.meta.nBands ?? 0,
  ): void {
    if (!this.store) return;
    const cs = this.store.meta.chunkShape;
    const tileH = cs[0], tileW = cs[1];

    const old = this._embeddingRegion;
    if (old) {
      // Check if existing region already covers these bounds
      if (
        ciMin >= old.ciMin && ciMax <= old.ciMax &&
        cjMin >= old.cjMin && cjMax <= old.cjMax
      ) return;

      // Grow: compute union bounds
      const newCiMin = Math.min(old.ciMin, ciMin);
      const newCiMax = Math.max(old.ciMax, ciMax);
      const newCjMin = Math.min(old.cjMin, cjMin);
      const newCjMax = Math.max(old.cjMax, cjMax);
      const newCols = newCjMax - newCjMin + 1;
      const newRows = newCiMax - newCiMin + 1;
      const newTiles = newRows * newCols;
      const tilePixels = tileW * tileH;

      const newEmb = new Float32Array(newTiles * tilePixels * nBands);
      newEmb.fill(NaN);
      const newLoaded = new Uint8Array(newTiles);

      // Copy old data into new buffer at correct offsets
      for (let oci = old.ciMin; oci <= old.ciMax; oci++) {
        for (let ocj = old.cjMin; ocj <= old.cjMax; ocj++) {
          const oldT = (oci - old.ciMin) * old.gridCols + (ocj - old.cjMin);
          if (!old.loaded[oldT]) continue;
          const newT = (oci - newCiMin) * newCols + (ocj - newCjMin);
          const oldBase = oldT * tilePixels * nBands;
          const newBase = newT * tilePixels * nBands;
          newEmb.set(
            old.emb.subarray(oldBase, oldBase + tilePixels * nBands),
            newBase,
          );
          newLoaded[newT] = 1;
        }
      }

      this._embeddingRegion = {
        ciMin: newCiMin, ciMax: newCiMax,
        cjMin: newCjMin, cjMax: newCjMax,
        gridCols: newCols, gridRows: newRows,
        tileW, tileH, nBands, emb: newEmb, loaded: newLoaded,
      };
      this.debug('info', `Region grown to [${newCiMin},${newCiMax}]x[${newCjMin},${newCjMax}] (${newTiles} tiles)`);
    } else {
      // Create new region
      const gridCols = cjMax - cjMin + 1;
      const gridRows = ciMax - ciMin + 1;
      const nTiles = gridRows * gridCols;
      const tilePixels = tileW * tileH;
      const emb = new Float32Array(nTiles * tilePixels * nBands);
      emb.fill(NaN);
      this._embeddingRegion = {
        ciMin, ciMax, cjMin, cjMax, gridCols, gridRows,
        tileW, tileH, nBands, emb, loaded: new Uint8Array(nTiles),
      };
      this.debug('info', `Region created [${ciMin},${ciMax}]x[${cjMin},${cjMax}] (${nTiles} tiles, ${(emb.byteLength / 1024 / 1024).toFixed(0)} MB)`);
    }
  }

  /** Compute pixel bounds for a chunk. */
  private chunkPixelBounds(ci: number, cj: number): ChunkBounds {
    const s = this.store!.meta.shape;
    const cs = this.store!.meta.chunkShape;
    const { globalRow: r0, globalCol: c0 } = this.pixelToGlobal(ci, cj, 0, 0);
    return {
      r0,
      r1: Math.min(r0 + cs[0], s[0]),
      c0,
      c1: Math.min(c0 + cs[1], s[1]),
    };
  }

  /** Compute UTM bounds for a chunk. */
  private chunkUtmBounds(ci: number, cj: number): UtmBounds {
    const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
    const t = this.store!.meta.transform;
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

  /** Get WGS84 corners [TL, TR, BR, BL] for a chunk. */
  private chunkCorners(ci: number, cj: number) {
    return this.proj!.chunkCornersToLngLat(this.chunkUtmBounds(ci, cj));
  }

  /** Create an empty region for the degenerate case. */
  private createEmptyRegion(): EmbeddingRegion {
    return {
      ciMin: 0, ciMax: 0, cjMin: 0, cjMax: 0,
      gridRows: 1, gridCols: 1,
      tileW: 1, tileH: 1, nBands: 1,
      emb: new Float32Array(1).fill(NaN),
      loaded: new Uint8Array(1),
    };
  }

  /** Emit a debug log entry. */
  private debug(type: DebugLogEntry['type'], msg: string): void {
    this.emit('debug', { time: Date.now(), type, msg });
  }
}
