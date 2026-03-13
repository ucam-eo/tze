/**
 * Configuration for opening a single TESSERA Zarr store.
 */
export interface TesseraOptions {
  /** HTTP URL of the Zarr v3 store root. */
  url: string;

  /**
   * Maximum number of concurrent chunk fetches.
   * @defaultValue 4
   */
  concurrency?: number;
}

/**
 * Metadata read from a TESSERA Zarr store's group attributes.
 *
 * @remarks
 * Populated by {@link TesseraSource.open} after reading the store's
 * root group attributes and discovering available arrays.
 */
export interface StoreMetadata {
  /** HTTP URL of the store this metadata was read from. */
  url: string;

  /** UTM zone number (1–60). */
  utmZone: number;

  /** EPSG code for the store's CRS (e.g. 32633 for UTM 33N). */
  epsg: number;

  /**
   * 6-element affine transform mapping pixel indices to UTM coordinates.
   *
   * @remarks
   * GDAL GeoTransform layout: `[pixelW, 0, originX, 0, -pixelH, originY]`.
   * Pixel `(col, row)` maps to UTM `(originX + col*pixelW, originY - row*pixelH)`,
   * where `originX = t[2]`, `pixelW = t[0]`, `originY = t[5]`, `pixelH = -t[4]`.
   */
  transform: [number, number, number, number, number, number];

  /** Array shape `[height, width, nBands]`. */
  shape: [number, number, number];

  /** Chunk shape `[tileH, tileW, nBands]`. */
  chunkShape: [number, number, number];

  /** Number of embedding dimensions (typically 128). */
  nBands: number;

  /** Whether the store contains a pre-rendered RGB preview array. */
  hasRgb: boolean;
}

/**
 * Reference to a single chunk in a Zarr tile grid.
 */
export interface ChunkRef {
  /** Chunk row index (0-based). */
  ci: number;

  /** Chunk column index (0-based). */
  cj: number;
}

/**
 * A chunk reference qualified by its parent zone.
 *
 * @remarks
 * Used by {@link SourceManager} when aggregating chunks across
 * multiple UTM zones.
 */
export interface ManagedChunk extends ChunkRef {
  /** Identifier of the zone this chunk belongs to. */
  zoneId: string;
}

/**
 * Contiguous buffer holding dequantised embeddings for a rectangular
 * region of the tile grid.
 *
 * @remarks
 * Tiles are stored in row-major order. Each tile occupies
 * `tileH × tileW × nBands` floats. Global pixel `(gy, gx)` maps to
 * tile `(floor(gy/tileH), floor(gx/tileW))` with a local offset.
 *
 * Invalid pixels (outside the data extent or with zero scale factors)
 * are represented as `NaN` in the embedding buffer.
 */
export interface EmbeddingRegion {
  /** Minimum chunk row index in the region. */
  ciMin: number;

  /** Maximum chunk row index (inclusive). */
  ciMax: number;

  /** Minimum chunk column index. */
  cjMin: number;

  /** Maximum chunk column index (inclusive). */
  cjMax: number;

  /** Number of tile rows: `ciMax - ciMin + 1`. */
  gridRows: number;

  /** Number of tile columns: `cjMax - cjMin + 1`. */
  gridCols: number;

  /** Pixel width of each tile (from chunk shape). */
  tileW: number;

  /** Pixel height of each tile (from chunk shape). */
  tileH: number;

  /** Number of embedding bands (typically 128). */
  nBands: number;

  /**
   * Dequantised embedding data as a flat Float32Array.
   *
   * @remarks
   * Layout: row-major tiles, each tile is `tileH × tileW × nBands` floats.
   * Access pattern:
   * ```
   * tileIdx = (ci - ciMin) * gridCols + (cj - cjMin)
   * offset  = tileIdx * tileH * tileW * nBands
   *         + row * tileW * nBands
   *         + col * nBands
   * value   = emb[offset + band]
   * ```
   * `NaN` indicates an invalid pixel.
   */
  emb: Float32Array;

  /**
   * Per-tile loaded bitmap.
   *
   * @remarks
   * Index `tileIdx = (ci - ciMin) * gridCols + (cj - cjMin)`.
   * Value `1` = loaded, `0` = not yet fetched.
   */
  loaded: Uint8Array;
}

/**
 * A single embedding vector with its location in the tile grid.
 *
 * @remarks
 * Returned by {@link TesseraSource.getEmbeddingAt} and
 * {@link TesseraSource.getEmbeddingsInKernel}.
 */
export interface EmbeddingAt {
  /** The embedding vector (typically 128 floats). */
  embedding: Float32Array;

  /** Chunk row index. */
  ci: number;

  /** Chunk column index. */
  cj: number;

  /** Pixel row within the chunk. */
  row: number;

  /** Pixel column within the chunk. */
  col: number;
}

/**
 * Descriptor for a geographic zone in a TESSERA catalog.
 *
 * @remarks
 * Each zone corresponds to a single UTM zone with its own Zarr store.
 * The {@link SourceManager} uses these descriptors for geographic routing.
 */
export interface ZoneDescriptor {
  /** Unique identifier for the zone (e.g. `"32N"`). */
  id: string;

  /** WGS84 bounding box `[west, south, east, north]`. */
  bbox: [number, number, number, number];

  /** HTTP URL of the zone's Zarr v3 store. */
  zarrUrl: string;
}

/**
 * Progress information emitted during chunk loading.
 *
 * @remarks
 * Matches the current `EmbeddingProgress` payload structure.
 */
export interface EmbeddingProgress {
  /** Chunk row being loaded. */
  ci: number;

  /** Chunk column being loaded. */
  cj: number;

  /** Current loading stage. */
  stage: 'fetching' | 'rendering' | 'done';

  /** Expected total bytes for this chunk. */
  bytes?: number;

  /** Bytes received so far. */
  bytesLoaded?: number;

  /** Number of Zarr sub-chunks fetched. */
  chunksCompleted?: number;

  /** Total Zarr sub-chunks to fetch. */
  chunksTotal?: number;
}

/**
 * Debug log entry for diagnostic events.
 *
 * @remarks
 * Emitted via the `'debug'` event on {@link TesseraSource} and
 * {@link SourceManager}. Useful for performance monitoring and
 * troubleshooting.
 */
export interface DebugLogEntry {
  /** Timestamp (ms since epoch). */
  time: number;

  /** Category of the debug event. */
  type: 'fetch' | 'render' | 'overlay' | 'info' | 'error';

  /** Human-readable message. */
  msg: string;
}

/**
 * UTM coordinate bounds.
 *
 * @remarks
 * Uses easting/northing conventions standard for UTM coordinates.
 */
export interface UtmBounds {
  /** Minimum easting (metres). */
  minE: number;

  /** Maximum easting (metres). */
  maxE: number;

  /** Minimum northing (metres). */
  minN: number;

  /** Maximum northing (metres). */
  maxN: number;
}

/**
 * Chunk grid bounds (row/column ranges).
 *
 * @internal
 */
export interface ChunkBounds {
  /** Start row. */
  r0: number;

  /** End row (exclusive). */
  r1: number;

  /** Start column. */
  c0: number;

  /** End column (exclusive). */
  c1: number;
}

/**
 * Event map for {@link TesseraSource} and {@link SourceManager}.
 *
 * @remarks
 * Both classes extend `EventEmitter<TesseraEvents>`. Subscribe with
 * `.on('event-name', callback)`. Each event name maps to a payload
 * type; the callback receives the payload as its single argument.
 */
export interface TesseraEvents {
  /** Fired after the store is opened and metadata is available. */
  'metadata-loaded': StoreMetadata;

  /** Fired each time a single chunk finishes loading and dequantising. */
  'chunk-loaded': ChunkRef;

  /** Fired when all requested chunks in a batch have finished loading. */
  'embeddings-loaded': ChunkRef;

  /** Fired periodically during a batch load with progress information. */
  'embedding-progress': EmbeddingProgress;

  /** Fired when an error occurs during store access or chunk loading. */
  'error': Error;

  /**
   * Fired with loading progress counts.
   *
   * @remarks
   * `total` is the number of chunks requested; `done` is the number
   * completed so far.
   */
  'loading': { total: number; done: number };

  /** Diagnostic log entries for performance monitoring. */
  'debug': DebugLogEntry;
}

/**
 * Options for {@link TesseraTileRenderer}.
 */
export interface TileRendererOptions {
  /**
   * Zarr array variable to render (e.g. `'rgb'`, `'pca_rgb'`).
   * @defaultValue `'rgb'`
   */
  variable?: string;
}
