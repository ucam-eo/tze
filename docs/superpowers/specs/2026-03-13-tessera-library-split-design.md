# Design: Split maplibre-zarr-tessera into Core + Map Plugins

**Date**: 2026-03-13
**Status**: Draft

## Problem

`@ucam-eo/maplibre-zarr-tessera` conflates two concerns: generic TESSERA
embedding data access (Zarr reading, dequantisation, coordinate projection,
tile rendering) and MapLibre-specific display logic (layers, viewport
management, overlays, loading animations). This coupling means:

- `geotessera.org` depends on the full MapLibre plugin just to serve preview
  tiles.
- Porting to Leaflet or OpenLayers would require duplicating the data access
  layer.
- The 1,765-line `zarr-source.ts` mixes data loading with display rendering.

## Solution

Extract a framework-agnostic **`@ucam-eo/tessera`** core library. Slim the
existing package into **`@ucam-eo/maplibre-tessera`**. Validate the
abstraction by designing **`@ucam-eo/leaflet-tessera`** and
**`@ucam-eo/openlayers-tessera`** plugins that consume the same core API.

---

## Package Structure

```
tze/
├── packages/
│   ├── tessera/                      # @ucam-eo/tessera — core library
│   │   ├── src/
│   │   │   ├── index.ts              # Public API re-exports
│   │   │   ├── types.ts              # All shared types
│   │   │   ├── event-emitter.ts      # Generic typed EventEmitter
│   │   │   ├── zarr-reader.ts        # Zarr v3 store opening & chunk fetching
│   │   │   ├── projection.ts         # UTM ↔ WGS84 coordinate conversion
│   │   │   ├── tessera-source.ts     # Single-zone data access & dequantisation
│   │   │   ├── source-manager.ts     # Multi-zone routing & aggregation
│   │   │   └── tile-renderer.ts      # Pyramid discovery & (z,x,y) → PNG
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   └── typedoc.json
│   │
│   ├── maplibre-tessera/             # @ucam-eo/maplibre-tessera — MapLibre plugin
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts              # MaplibreDisplayOptions, PreviewMode
│   │   │   ├── zarr-protocol.ts      # registerZarrProtocol (thin wrapper)
│   │   │   ├── maplibre-source.ts    # Display layer for a single zone
│   │   │   ├── maplibre-manager.ts   # Multi-zone display management
│   │   │   ├── worker-pool.ts        # Web Worker pool (RGBA rendering)
│   │   │   ├── render-worker.ts      # Inline worker: bands → RGBA canvas
│   │   │   └── region-loading-animation.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vite.config.ts
│   │
│   ├── leaflet-tessera/              # @ucam-eo/leaflet-tessera
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── tessera-tile-layer.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── openlayers-tessera/           # @ucam-eo/openlayers-tessera
│       ├── src/
│       │   ├── index.ts
│       │   └── tessera-tile-source.ts
│       ├── package.json
│       └── tsconfig.json
```

### Dependency Graph

```
leaflet-tessera ──────┐
maplibre-tessera ─────┤──▶ @ucam-eo/tessera ──▶ zarrita, proj4
openlayers-tessera ───┘
```

Each map plugin declares its map library as a **peer dependency**. The core
library has **zero** map framework dependencies.

### Build Order (pnpm workspace)

```
tessera → maplibre-tessera → viewer
       → leaflet-tessera
       → openlayers-tessera
```

---

## Core Library: `@ucam-eo/tessera`

### Dependencies

| Dependency | Purpose |
|-----------|---------|
| `zarrita` | Zarr v3 HTTP reads with chunk coalescing |
| `proj4`   | UTM ↔ WGS84 coordinate transforms |

**Browser dependency**: `TesseraTileRenderer` uses `HTMLCanvasElement` and
`canvas.toDataURL()` for PNG encoding. This is available in all browsers.
For future Node usage, a `createCanvas` factory could be injected, but this
is not needed now — all current consumers are browser-based.

### event-emitter.ts — Typed Event Emitter

```typescript
/**
 * Minimal typed event emitter used by {@link TesseraSource} and
 * {@link SourceManager}.
 *
 * @remarks
 * Events use a payload-record style: each event name maps to a
 * payload type. Listeners receive the payload as their single argument.
 *
 * @typeParam T - Event map: `{ eventName: PayloadType }`.
 *
 * @example
 * ```typescript
 * const emitter = new EventEmitter<{ 'loaded': StoreMetadata }>();
 * emitter.on('loaded', (meta) => console.log(meta.nBands));
 * emitter.emit('loaded', metadata);
 * ```
 */
export class EventEmitter<T extends Record<string, unknown>> {
  private listeners = new Map<string, Set<(data: unknown) => void>>();

  /** Subscribe to an event. */
  on<K extends keyof T & string>(
    event: K,
    callback: (data: T[K]) => void,
  ): void;

  /** Unsubscribe from an event. */
  off<K extends keyof T & string>(
    event: K,
    callback: (data: T[K]) => void,
  ): void;

  /** Emit an event to all subscribers. */
  protected emit<K extends keyof T & string>(
    event: K,
    data: T[K],
  ): void;
}
```

### types.ts — Shared Types

```typescript
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

  /** Whether the store contains a PCA-projected RGB preview array. */
  hasPca: boolean;

  /**
   * Explained variance per PCA component, if available.
   * Used for labelling PCA band selectors.
   */
  pcaExplainedVariance?: number[];
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
```

### tessera-source.ts — Single-Zone Data Access

```typescript
import type {
  TesseraOptions, StoreMetadata, ChunkRef, EmbeddingRegion,
  EmbeddingAt, EmbeddingProgress, TesseraEvents,
} from './types';
import { EventEmitter } from './event-emitter';
import { UtmProjection } from './projection';

/**
 * Access layer for a single TESSERA Zarr store (one UTM zone).
 *
 * @remarks
 * `TesseraSource` handles:
 * - Opening the Zarr v3 store and reading metadata
 * - Fetching quantised embedding chunks over HTTP
 * - Dequantising int8 × float32 scale → float32 embeddings
 * - Managing a contiguous {@link EmbeddingRegion} buffer
 * - Querying embeddings by WGS84 or pixel coordinates
 *
 * It has **no dependency on any map framework**. Display logic
 * (layers, overlays, animations) belongs in map-specific plugins
 * such as `@ucam-eo/maplibre-tessera`.
 *
 * @example
 * ```typescript
 * const source = new TesseraSource({ url: 'https://example.com/zone32n.zarr' });
 * const meta = await source.open();
 * console.log(`${meta.nBands} bands, UTM zone ${meta.utmZone}`);
 *
 * const chunks = source.getChunksInRegion(polygon);
 * const region = await source.loadChunks(chunks, {
 *   onProgress: (p) => console.log(`${p.chunksCompleted}/${p.chunksTotal}`),
 * });
 *
 * const hit = source.getEmbeddingAt(0.1, 52.2);
 * if (hit) console.log('128-d vector:', hit.embedding);
 *
 * source.close();
 * ```
 */
export class TesseraSource extends EventEmitter<TesseraEvents> {
  /**
   * Create a new source for a TESSERA Zarr store.
   *
   * @param options - Store URL and loading configuration.
   */
  constructor(options: TesseraOptions);

  /**
   * Open the Zarr store, read group attributes, and discover arrays.
   *
   * @returns Store metadata including CRS, dimensions, and available
   *   preview arrays.
   * @throws If the store cannot be reached or lacks required attributes.
   *
   * @remarks
   * Must be called before any data access methods. Emits
   * `'metadata-loaded'` on success.
   */
  open(): Promise<StoreMetadata>;

  /**
   * Release resources and cancel any in-flight fetches.
   *
   * @remarks
   * After calling `close()`, the source cannot be reopened.
   */
  close(): void;

  /**
   * Store metadata, available after {@link open} resolves.
   * `null` before the store is opened.
   */
  readonly metadata: StoreMetadata | null;

  /**
   * UTM ↔ WGS84 projection for this zone.
   * Available after {@link open} resolves.
   */
  readonly projection: UtmProjection;

  /**
   * Fetch, dequantise, and store embedding chunks.
   *
   * @param chunks - Chunk references to load.
   * @param opts.signal - Abort signal to cancel loading.
   * @param opts.onProgress - Callback fired periodically with progress.
   * @returns The {@link EmbeddingRegion} containing all loaded data
   *   (may include previously loaded chunks).
   *
   * @remarks
   * Replaces the current `loadChunkBatch()` method. The return type
   * changes from `number` (count of succeeded) to the region itself.
   *
   * Chunks are fetched with bounded concurrency (see
   * {@link TesseraOptions.concurrency}). Each chunk's int8 embeddings
   * are multiplied by their per-pixel float32 scale factors and written
   * into the contiguous region buffer. Invalid pixels (scale = 0 or NaN)
   * become `NaN` in the output.
   *
   * The region buffer grows automatically to encompass all requested
   * chunks. Previously loaded chunks are preserved.
   *
   * Emits `'chunk-loaded'` per chunk, `'embedding-progress'`
   * periodically, and `'embeddings-loaded'` when the batch completes.
   */
  loadChunks(
    chunks: ChunkRef[],
    opts?: {
      signal?: AbortSignal;
      onProgress?: (progress: EmbeddingProgress) => void;
    },
  ): Promise<EmbeddingRegion>;

  /**
   * Get the embedding vector at a WGS84 coordinate.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @returns The embedding and its grid location, or `null` if the
   *   coordinate falls outside loaded tiles or on an invalid pixel.
   *
   * @remarks
   * Projects the coordinate to UTM, maps to pixel indices, and reads
   * from the {@link embeddingRegion} buffer. Returns `null` if the
   * tile has not been loaded or the pixel is invalid (NaN).
   */
  getEmbeddingAt(lng: number, lat: number): EmbeddingAt | null;

  /**
   * Get all valid embeddings in an N×N pixel kernel centred on a
   * WGS84 coordinate.
   *
   * @param lng - Centre longitude in degrees.
   * @param lat - Centre latitude in degrees.
   * @param size - Kernel side length in pixels (e.g. 3 for a 3×3 area).
   * @returns Array of embeddings with their grid locations. May be
   *   shorter than `size × size` if some pixels are invalid or unloaded.
   */
  getEmbeddingsInKernel(
    lng: number,
    lat: number,
    size: number,
  ): EmbeddingAt[];

  /**
   * Find all chunks that intersect a GeoJSON polygon.
   *
   * @param polygon - A GeoJSON Polygon in WGS84 coordinates.
   * @returns Chunk references covering the polygon's bounding box
   *   within this zone.
   */
  getChunksInRegion(polygon: GeoJSON.Polygon): ChunkRef[];

  /**
   * Find the chunk containing a WGS84 coordinate.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @returns The chunk reference, or `null` if the coordinate falls
   *   outside this zone's extent.
   */
  getChunkAtLngLat(lng: number, lat: number): ChunkRef | null;

  /**
   * Get the WGS84 corner coordinates of a chunk.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @returns Four `[lng, lat]` pairs: `[TL, TR, BR, BL]`.
   */
  getChunkBoundsLngLat(
    ci: number,
    cj: number,
  ): [[number, number], [number, number], [number, number], [number, number]];

  /**
   * Get the WGS84 corner coordinates of a single pixel within a chunk.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @param row - Pixel row within the chunk.
   * @param col - Pixel column within the chunk.
   * @returns Four `[lng, lat]` pairs: `[TL, TR, BR, BL]`.
   */
  getPixelBoundsLngLat(
    ci: number,
    cj: number,
    row: number,
    col: number,
  ): [[number, number], [number, number], [number, number], [number, number]];

  /**
   * The current embedding region buffer, or `null` if no chunks have
   * been loaded.
   *
   * @remarks
   * This is a live reference — it grows as more chunks are loaded.
   * Read from it directly for analysis (similarity, classification,
   * segmentation). To modify region state, use {@link evictTile} or
   * {@link clearRegion}.
   */
  readonly embeddingRegion: EmbeddingRegion | null;

  /**
   * Evict a single tile from the region, zeroing its data and marking
   * it as unloaded.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   *
   * @remarks
   * Sets all embedding values for the tile to 0 and marks
   * `region.loaded[tileIdx] = 0`. Does not shrink the region buffer.
   */
  evictTile(ci: number, cj: number): void;

  /**
   * Clear the entire embedding region, releasing the buffer.
   *
   * @remarks
   * Sets {@link embeddingRegion} to `null`. Subsequent loads will
   * create a new region.
   */
  clearRegion(): void;

  /**
   * Check whether a specific tile has been loaded into the region.
   *
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   */
  regionHasTile(ci: number, cj: number): boolean;

  /**
   * Number of tiles currently loaded in the region.
   */
  readonly tileCount: number;
}
```

### source-manager.ts — Multi-Zone Routing

```typescript
import type {
  TesseraOptions, ZoneDescriptor, ManagedChunk,
  EmbeddingAt, EmbeddingRegion, TesseraEvents, StoreMetadata,
} from './types';
import { EventEmitter } from './event-emitter';
import { TesseraSource } from './tessera-source';

/**
 * Manages multiple {@link TesseraSource} instances across UTM zones.
 *
 * @remarks
 * The `SourceManager` provides a unified interface over a TESSERA
 * catalog that spans multiple UTM zones. It:
 *
 * - Lazily opens zone sources on first access
 * - Routes geographic queries to the correct zone(s)
 * - Aggregates embedding regions across all open zones
 * - Forwards events from child sources
 *
 * Like `TesseraSource`, this class has no map framework dependency.
 *
 * @example
 * ```typescript
 * const manager = new SourceManager(catalog.zones, { concurrency: 4 });
 *
 * // Find and load chunks for a drawn polygon
 * const chunks = await manager.getChunksInRegion(polygon);
 * for (const [zoneId, zoneChunks] of groupByZone(chunks)) {
 *   const source = await manager.getSource(zoneId);
 *   await source.loadChunks(zoneChunks);
 * }
 *
 * // Query across zones
 * const hit = manager.getEmbeddingAt(0.1, 52.2);
 * ```
 */
export class SourceManager extends EventEmitter<TesseraEvents> {
  /**
   * @param zones - Zone descriptors from a STAC catalog.
   * @param options - Default options applied to each zone source.
   *   The `url` field is omitted since each zone provides its own URL.
   */
  constructor(zones: ZoneDescriptor[], options?: Omit<TesseraOptions, 'url'>);

  /**
   * Get or lazily open a zone's source.
   *
   * @param zoneId - Zone identifier.
   * @returns The opened source. Concurrent calls for the same zone
   *   return the same Promise (deduplication).
   * @throws If the zone ID is unknown.
   */
  getSource(zoneId: string): Promise<TesseraSource>;

  /**
   * Synchronously get an already-opened source.
   *
   * @param zoneId - Zone identifier.
   * @returns The source, or `null` if not yet opened.
   */
  getOpenSource(zoneId: string): TesseraSource | null;

  /**
   * All currently open sources, keyed by zone ID.
   */
  getActiveSources(): Map<string, TesseraSource>;

  /**
   * Find zones whose bounding box contains a point.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   */
  zonesAtPoint(lng: number, lat: number): ZoneDescriptor[];

  /**
   * Find zones whose bounding box overlaps a polygon's extent.
   *
   * @param polygon - GeoJSON Polygon in WGS84.
   */
  zonesForPolygon(polygon: GeoJSON.Polygon): ZoneDescriptor[];

  /**
   * Get all chunks across all zones that intersect a polygon.
   *
   * @param polygon - GeoJSON Polygon in WGS84.
   * @returns Zone-qualified chunk references.
   *
   * @remarks
   * This method is **async** because it lazily opens zone sources
   * (via {@link getSource}) for each zone overlapping the polygon.
   * If you only want to search already-opened zones, iterate
   * {@link getActiveSources} manually.
   */
  getChunksInRegion(polygon: GeoJSON.Polygon): Promise<ManagedChunk[]>;

  /**
   * Query the embedding at a point, searching across open zones.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @returns The embedding with zone ID, or `null` if no open zone
   *   covers the point or the pixel is unloaded/invalid.
   *
   * @remarks
   * Only searches already-opened zones (synchronous). Does not
   * trigger lazy zone opening.
   */
  getEmbeddingAt(lng: number, lat: number): (EmbeddingAt & { zoneId: string }) | null;

  /**
   * Get a kernel of embeddings around a point.
   *
   * @param lng - Centre longitude.
   * @param lat - Centre latitude.
   * @param size - Kernel side length in pixels.
   *
   * @remarks
   * Only searches already-opened zones (synchronous).
   */
  getEmbeddingsInKernel(
    lng: number,
    lat: number,
    size: number,
  ): (EmbeddingAt & { zoneId: string })[];

  /**
   * Get the WGS84 corner coordinates of a single pixel.
   *
   * @remarks
   * Searches all open zone sources for the tile containing the chunk.
   */
  getPixelBoundsLngLat(
    ci: number,
    cj: number,
    row: number,
    col: number,
  ): [[number, number], [number, number], [number, number], [number, number]] | null;

  /**
   * Get chunk indices at a WGS84 coordinate, routing to correct zone.
   */
  getChunkAtLngLat(lng: number, lat: number): ManagedChunk | null;

  /**
   * Get chunk corner bounds from a specific zone.
   */
  getChunkBoundsLngLat(
    zoneId: string,
    ci: number,
    cj: number,
  ): [[number, number], [number, number], [number, number], [number, number]] | null;

  /**
   * Get all loaded embedding regions, keyed by zone ID.
   */
  getEmbeddingRegions(): Map<string, EmbeddingRegion>;

  /**
   * Check whether a tile is loaded in a specific zone.
   */
  regionHasTile(zoneId: string, ci: number, cj: number): boolean;

  /**
   * Total number of loaded tiles across all open zones.
   */
  totalTileCount(): number;

  /**
   * Bounding box of all loaded tiles across all zones.
   *
   * @returns `[south, west, north, east]` or `null` if no tiles are loaded.
   *
   * @remarks
   * Preserves the current return order `[south, west, north, east]`.
   * Note this differs from the WGS84 convention `[west, south, east, north]`
   * used in {@link ZoneDescriptor.bbox} — this matches the existing API
   * for backwards compatibility.
   */
  embeddingBoundsLngLat(): [number, number, number, number] | null;

  /**
   * Metadata from the first opened source (convenience accessor).
   */
  getMetadata(): StoreMetadata | null;

  /**
   * All zone descriptors.
   */
  getZones(): ZoneDescriptor[];

  /**
   * Close all open sources and release resources.
   */
  close(): void;
}
```

### tile-renderer.ts — Framework-Agnostic Tile Rendering

```typescript
import type { TileRendererOptions } from './types';

/**
 * Renders RGB preview tiles from a TESSERA Zarr pyramid.
 *
 * @remarks
 * `TesseraTileRenderer` handles:
 * - Discovering pyramid levels from Zarr multiscales metadata
 * - Selecting the coarsest level with sufficient resolution for each
 *   zoom level
 * - Sampling RGB data from equirectangular source arrays
 * - Correcting Mercator distortion via inverse projection
 * - Encoding the result as a 256×256 PNG
 *
 * This class has **no map framework dependency**. Map plugins wrap
 * it with their framework's tile loading interface:
 *
 * - MapLibre: `addProtocol('zarr', handler)`
 * - Leaflet: `L.TileLayer.createTile()`
 * - OpenLayers: `ol/source/Tile.getTile()`
 *
 * **Browser dependency**: Uses `HTMLCanvasElement` and `canvas.toDataURL()`
 * for PNG encoding. This is available in all browser environments.
 *
 * @example
 * ```typescript
 * const renderer = new TesseraTileRenderer(
 *   'https://dl2.geotessera.org/zarr/v1/2025.zarr/global_rgb',
 *   { variable: 'rgb' },
 * );
 *
 * const png = await renderer.renderTile(4, 8, 5);
 * const blob = new Blob([png], { type: 'image/png' });
 * img.src = URL.createObjectURL(blob);
 * ```
 */
export class TesseraTileRenderer {
  /**
   * @param url - Base URL of the Zarr store containing the pyramid.
   * @param options - Rendering options.
   */
  constructor(url: string, options?: TileRendererOptions);

  /**
   * Render a single Web Mercator tile as a PNG image.
   *
   * @param z - Zoom level.
   * @param x - Tile column.
   * @param y - Tile row.
   * @returns PNG-encoded image as raw bytes.
   *
   * @remarks
   * On first call, discovers pyramid levels by reading Zarr
   * multiscales metadata (cached for subsequent calls).
   *
   * For each output pixel in the 256×256 tile:
   * 1. Convert tile pixel → Web Mercator → WGS84 (lat/lng)
   * 2. Map WGS84 → equirectangular pixel coordinate in source
   * 3. Sample RGB from the appropriate pyramid level
   * 4. Write RGBA (alpha = 255 for valid, 0 for nodata)
   *
   * The Mercator inverse projection corrects the latitude distortion
   * that would otherwise stretch pixels near the poles.
   */
  renderTile(z: number, x: number, y: number): Promise<ArrayBuffer>;

  /**
   * Switch the Zarr array variable used for rendering.
   *
   * @param variable - Array name within the store (e.g. `'rgb'`,
   *   `'pca_rgb'`).
   *
   * @remarks
   * Clears the internal pyramid cache. Subsequent `renderTile` calls
   * will re-discover levels from the new variable.
   */
  setVariable(variable: string): void;

  /**
   * Clear the pyramid level cache and any buffered tile data.
   */
  clearCache(): void;

  /**
   * Release all resources.
   */
  destroy(): void;
}
```

### projection.ts — Coordinate Conversion

```typescript
import type { UtmBounds } from './types';

/**
 * Bidirectional converter between WGS84 (longitude/latitude) and
 * UTM (easting/northing) coordinates.
 *
 * @remarks
 * Uses proj4 internally. Derives the UTM zone and hemisphere from
 * the EPSG code (e.g. 32633 → zone 33 North, 32733 → zone 33 South).
 *
 * @example
 * ```typescript
 * const proj = new UtmProjection(32633);
 * const [easting, northing] = proj.forward(13.4, 52.5);
 * const [lng, lat] = proj.inverse(easting, northing);
 * ```
 */
export class UtmProjection {
  /** EPSG code this projection was created with. */
  readonly epsg: number;

  /** UTM zone number (1–60). */
  readonly zone: number;

  /** Whether this is a southern hemisphere zone. */
  readonly isSouth: boolean;

  /**
   * @param epsg - EPSG code for a UTM CRS (32601–32660 for north,
   *   32701–32760 for south).
   */
  constructor(epsg: number);

  /**
   * Project WGS84 → UTM.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @returns `[easting, northing]` in metres.
   */
  forward(lng: number, lat: number): [number, number];

  /**
   * Project UTM → WGS84.
   *
   * @param easting - Easting in metres.
   * @param northing - Northing in metres.
   * @returns `[longitude, latitude]` in degrees.
   */
  inverse(easting: number, northing: number): [number, number];

  /**
   * Convert UTM bounding box to WGS84 corner coordinates.
   *
   * @param bounds - UTM bounds using easting/northing conventions.
   * @returns Four `[lng, lat]` pairs: `[TL, TR, BR, BL]`.
   */
  chunkCornersToLngLat(
    bounds: UtmBounds,
  ): [[number, number], [number, number], [number, number], [number, number]];
}
```

### zarr-reader.ts — Low-Level Store Access

```typescript
/**
 * Opened Zarr v3 store with discovered arrays and metadata.
 *
 * @remarks
 * Returned by {@link openStore}. Contains zarrita array handles
 * ready for slicing/fetching.
 *
 * @internal — Consumers should use {@link TesseraSource} rather than
 * accessing this directly.
 */
export interface ZarrStore {
  /** Parsed store metadata. */
  metadata: StoreMetadata;

  /** The main embeddings array (int8, shape `[H, W, nBands]`). */
  embeddings: ZarritaArray;

  /** Per-pixel dequantisation scales (float32, shape `[H, W]`). */
  scales: ZarritaArray;

  /** Pre-rendered RGB preview array, if present. */
  rgb?: ZarritaArray;

  /** PCA-projected RGB preview array, if present. */
  pcaRgb?: ZarritaArray;

  /**
   * Set of existing chunk keys (e.g. `"3_7"`), loaded from
   * `_chunk_manifest.json` if available. Used to skip 404s for
   * sparse stores.
   */
  chunkManifest?: Set<string>;
}

/**
 * Open a TESSERA Zarr v3 store over HTTP.
 *
 * @param url - Store root URL.
 * @returns Opened store with array handles and metadata.
 *
 * @remarks
 * Uses zarrita's FetchStore + CoalescingStore for efficient HTTP
 * range requests. Reads group attributes for CRS, transform, and
 * array discovery.
 */
export function openStore(url: string): Promise<ZarrStore>;

/**
 * Fetch a sliced region from a Zarr array.
 *
 * @param arr - A zarrita array handle.
 * @param slices - Per-axis slice: `[start, end]` or `null` for full axis.
 * @param onProgress - Optional progress callback (bytes loaded).
 * @returns Raw typed array and shape.
 */
export function fetchRegion(
  arr: ZarritaArray,
  slices: ([number, number] | null)[],
  onProgress?: (bytes: number) => void,
): Promise<{ data: ArrayBufferView; shape: number[] }>;
```

### index.ts — Public Exports

```typescript
// Classes
export { TesseraSource } from './tessera-source';
export { SourceManager } from './source-manager';
export { TesseraTileRenderer } from './tile-renderer';
export { UtmProjection } from './projection';
export { EventEmitter } from './event-emitter';

// Types
export type {
  TesseraOptions,
  StoreMetadata,
  ChunkRef,
  ManagedChunk,
  EmbeddingRegion,
  EmbeddingAt,
  ZoneDescriptor,
  EmbeddingProgress,
  DebugLogEntry,
  UtmBounds,
  TesseraEvents,
  TileRendererOptions,
} from './types';
```

---

## MapLibre Plugin: `@ucam-eo/maplibre-tessera`

### Dependencies

| Dependency | Purpose |
|-----------|---------|
| `@ucam-eo/tessera` | Core data access |
| `maplibre-gl` (peer) | Map framework |

### types.ts — Display-Specific Types

```typescript
/**
 * Preview rendering mode for MapLibre display.
 */
export type PreviewMode = 'rgb' | 'pca' | 'bands';

/**
 * Display options for a MapLibre TESSERA source.
 *
 * @remarks
 * These control how embeddings and preview data are rendered
 * as MapLibre layers. Data access options are on
 * {@link TesseraOptions} instead.
 */
export interface MaplibreDisplayOptions {
  /**
   * Which embedding bands to render as `[R, G, B]`.
   * @defaultValue `[0, 1, 2]`
   */
  bands?: [number, number, number];

  /**
   * Layer opacity (0–1).
   * @defaultValue 0.8
   */
  opacity?: number;

  /**
   * Preview rendering mode.
   * @defaultValue `'rgb'`
   */
  preview?: PreviewMode;

  /**
   * Maximum number of cached chunk layers.
   * @defaultValue 50
   */
  maxCached?: number;

  /**
   * Maximum chunks to load per viewport update.
   * @defaultValue 80
   */
  maxLoadPerUpdate?: number;

  /**
   * URL for the global EPSG:4326 preview store (served via zarr:// protocol).
   */
  globalPreviewUrl?: string;

  /**
   * Explicit bounds `[west, south, east, north]` in EPSG:4326 for
   * the global preview.
   */
  globalPreviewBounds?: [number, number, number, number];
}
```

### maplibre-source.ts

```typescript
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { TesseraSource, ChunkRef } from '@ucam-eo/tessera';
import type { MaplibreDisplayOptions, PreviewMode } from './types';

/**
 * MapLibre display layer wrapping a {@link TesseraSource}.
 *
 * @remarks
 * Manages all MapLibre-specific concerns for a single zone:
 * - Viewport-driven chunk loading and LRU eviction
 * - Per-chunk and region-wide raster layers
 * - RGBA rendering via Web Workers (band selection, normalisation)
 * - Similarity and classification overlay layers
 * - Loading animations (cyberpunk grid, per-tile glitch)
 *
 * Data access is delegated entirely to the wrapped
 * {@link TesseraSource} — access it via the {@link source} property.
 *
 * @example
 * ```typescript
 * import { TesseraSource } from '@ucam-eo/tessera';
 * import { MaplibreTesseraSource } from '@ucam-eo/maplibre-tessera';
 *
 * const source = new TesseraSource({ url: zarrUrl });
 * await source.open();
 *
 * const display = new MaplibreTesseraSource(source, {
 *   bands: [0, 1, 2],
 *   opacity: 0.8,
 *   preview: 'rgb',
 * });
 * display.addTo(map);
 *
 * // Data queries go through source
 * const hit = display.source.getEmbeddingAt(lng, lat);
 * ```
 */
export class MaplibreTesseraSource {
  /**
   * @param source - An opened {@link TesseraSource}.
   * @param options - Display rendering options.
   *
   * @remarks
   * The source must be opened (via {@link TesseraSource.open}) before
   * constructing the display layer, as metadata is needed for layer setup.
   */
  constructor(source: TesseraSource, options: MaplibreDisplayOptions);

  /** The underlying data source. All data queries go here. */
  readonly source: TesseraSource;

  /**
   * Attach to a MapLibre map and begin rendering.
   *
   * @remarks
   * Sets up viewport-driven chunk loading, adds preview layers,
   * and subscribes to source events for display updates.
   */
  addTo(map: MaplibreMap): void;

  /** Remove all layers and clean up. */
  remove(): void;

  // --- Display settings ---

  /** Change which embedding bands are rendered as RGB. */
  setBands(bands: [number, number, number]): void;

  /** Set layer opacity (0–1). */
  setOpacity(opacity: number): void;

  /** Switch preview mode ('rgb' | 'pca' | 'bands'). */
  setPreview(mode: PreviewMode): void;

  /** Re-render all loaded chunks with global min/max normalisation. */
  recolorAllChunks(): void;

  /** Re-order all layers to canonical z-order. */
  raiseAllLayers(): void;

  /** Remove and re-add all layers (for layer ordering recovery). */
  reAddAllLayers(): void;

  // --- Overlays ---

  /** Display a similarity heatmap canvas over the loaded region. */
  setSimilarityOverlay(canvas: HTMLCanvasElement): void;

  /** Remove the similarity overlay. */
  clearSimilarityOverlay(): void;

  /** Display the region-wide RGB overlay canvas. */
  setRgbOverlay(canvas: HTMLCanvasElement): void;

  /** Remove the RGB overlay. */
  clearRgbOverlay(): void;

  /** Add a per-tile classification canvas. */
  addClassificationOverlay(
    ci: number,
    cj: number,
    canvas: HTMLCanvasElement,
  ): void;

  /** Store per-pixel class IDs for a tile. */
  setClassificationMap(
    ci: number,
    cj: number,
    classMap: Uint8Array,
    width: number,
    height: number,
  ): void;

  /** Look up the class ID at a WGS84 coordinate. */
  getClassificationAt(lng: number, lat: number): number | null;

  /** Set opacity for classification overlay layers. */
  setClassificationOpacity(opacity: number): void;

  /** Remove all classification overlays. */
  clearClassificationOverlays(): void;

  // --- Loading animations ---

  /** Start region loading animation over a polygon. */
  startRegionAnimation(
    polygon: GeoJSON.Polygon,
    chunks: ChunkRef[],
  ): void;

  /** Update animation progress. */
  updateRegionAnimation(
    loaded: number,
    total: number,
    ci?: number,
    cj?: number,
  ): void;

  /** Stop and remove the loading animation. */
  stopRegionAnimation(): void;
}
```

### maplibre-manager.ts

```typescript
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { SourceManager, ZoneDescriptor, ChunkRef } from '@ucam-eo/tessera';
import type { MaplibreDisplayOptions, PreviewMode } from './types';
import { MaplibreTesseraSource } from './maplibre-source';

/**
 * MapLibre display manager wrapping a {@link SourceManager}.
 *
 * @remarks
 * Provides MapLibre-specific operations that broadcast across all
 * open zones (opacity, bands, preview mode, layer ordering).
 * Data queries go through the wrapped {@link manager} property.
 *
 * When the underlying `SourceManager` lazily opens a new zone via
 * {@link SourceManager.getSource}, this manager automatically creates
 * a corresponding {@link MaplibreTesseraSource} display wrapper. It
 * does this by listening for `'metadata-loaded'` events and wrapping
 * newly opened sources.
 *
 * @example
 * ```typescript
 * import { SourceManager } from '@ucam-eo/tessera';
 * import { MaplibreTesseraManager } from '@ucam-eo/maplibre-tessera';
 *
 * const manager = new SourceManager(zones, { concurrency: 4 });
 * const display = new MaplibreTesseraManager(manager, {
 *   bands: [0, 1, 2],
 *   opacity: 0.8,
 *   preview: 'rgb',
 * });
 * display.addTo(map);
 *
 * // Data: display.manager.getEmbeddingAt(lng, lat)
 * // Display: display.setOpacity(0.5)
 * ```
 */
export class MaplibreTesseraManager {
  /**
   * @param manager - The data-layer source manager.
   * @param options - Default display options applied to each zone's
   *   display source when it is created.
   */
  constructor(manager: SourceManager, options?: MaplibreDisplayOptions);

  /** The underlying data manager. All data queries go here. */
  readonly manager: SourceManager;

  /** Attach to a MapLibre map. */
  addTo(map: MaplibreMap): void;

  /** Detach and clean up all zones. */
  remove(): void;

  // --- Broadcast display settings ---
  setBands(bands: [number, number, number]): void;
  setOpacity(opacity: number): void;
  setPreview(mode: PreviewMode): void;
  setClassificationOpacity(opacity: number): void;
  raiseAllLayers(): void;
  reAddAllLayers(): void;
  recolorAllChunks(): void;

  // --- Broadcast overlay clearing ---
  clearSimilarityOverlay(): void;
  clearClassificationOverlays(): void;
  clearRgbOverlay(): void;

  // --- Per-zone animation routing ---
  startRegionAnimation(
    zoneId: string,
    polygon: GeoJSON.Polygon,
    chunks: ChunkRef[],
  ): void;
  updateRegionAnimation(
    zoneId: string,
    loaded: number,
    total: number,
    ci?: number,
    cj?: number,
  ): void;
  stopRegionAnimation(zoneId?: string): void;

  /**
   * Get the display source for a zone.
   *
   * @param zoneId - Zone identifier.
   * @returns The MapLibre display source, or `null` if the zone
   *   has not been opened.
   */
  getDisplaySource(zoneId: string): MaplibreTesseraSource | null;
}
```

### zarr-protocol.ts

```typescript
import { TesseraTileRenderer } from '@ucam-eo/tessera';

/**
 * Register the `zarr://` custom tile protocol with MapLibre GL.
 *
 * @param maplibregl - The MapLibre GL module (needed for `addProtocol`).
 *
 * @remarks
 * After registration, raster sources can use tile URLs of the form:
 * ```
 * zarr://STORE_URL/VARIABLE/{z}/{x}/{y}
 * ```
 *
 * The handler parses the URL, creates a {@link TesseraTileRenderer}
 * per unique store+variable combination, and delegates to
 * `renderTile(z, x, y)`.
 *
 * @example
 * ```typescript
 * import maplibregl from 'maplibre-gl';
 * import { registerZarrProtocol } from '@ucam-eo/maplibre-tessera';
 *
 * registerZarrProtocol(maplibregl);
 * // Now use: tiles: ['zarr://https://example.com/store.zarr/rgb/{z}/{x}/{y}']
 * ```
 */
export function registerZarrProtocol(maplibregl: typeof import('maplibre-gl')): void;

/**
 * Clear the tile renderer cache.
 *
 * @remarks
 * Call after switching preview variables to force re-fetching of
 * pyramid metadata and tile data.
 */
export function clearZarrProtocolCache(): void;
```

### index.ts — Public Exports

```typescript
export { MaplibreTesseraSource } from './maplibre-source';
export { MaplibreTesseraManager } from './maplibre-manager';
export { registerZarrProtocol, clearZarrProtocolCache } from './zarr-protocol';

// Display-specific types
export type { MaplibreDisplayOptions, PreviewMode } from './types';
```

---

## Leaflet Plugin: `@ucam-eo/leaflet-tessera`

### Dependencies

| Dependency | Purpose |
|-----------|---------|
| `@ucam-eo/tessera` | Core tile rendering |
| `leaflet` (peer) | Map framework |

### tessera-tile-layer.ts

```typescript
import * as L from 'leaflet';
import { TesseraTileRenderer } from '@ucam-eo/tessera';

/**
 * Leaflet tile layer that serves TESSERA Zarr pyramid tiles.
 *
 * @remarks
 * Extends `L.TileLayer` and overrides `createTile` to use
 * {@link TesseraTileRenderer} for on-the-fly rendering of Zarr
 * arrays as PNG tiles.
 *
 * @example
 * ```typescript
 * import { TesseraTileLayer } from '@ucam-eo/leaflet-tessera';
 *
 * const layer = new TesseraTileLayer(
 *   'https://dl2.geotessera.org/zarr/v1/2025.zarr/global_rgb',
 *   { variable: 'rgb', maxZoom: 12 },
 * );
 * layer.addTo(map);
 * ```
 */
export class TesseraTileLayer extends L.TileLayer {
  /**
   * @param url - Base URL of the Zarr store containing the pyramid.
   * @param options - Leaflet tile layer options plus tessera-specific
   *   options.
   */
  constructor(
    url: string,
    options?: L.TileLayerOptions & {
      /**
       * Zarr array variable to render.
       * @defaultValue `'rgb'`
       */
      variable?: string;
    },
  );

  /**
   * Override: create a tile image by rendering from the Zarr pyramid.
   *
   * @param coords - Tile coordinates `{ x, y, z }`.
   * @param done - Callback to signal tile load completion.
   * @returns An `HTMLImageElement` whose `src` will be set
   *   asynchronously from the rendered PNG.
   *
   * @remarks
   * Calls `renderer.renderTile(z, x, y)`, converts the PNG
   * `ArrayBuffer` to a blob URL, and sets it as the image source.
   * Calls `done(null, img)` on success or `done(err)` on failure.
   */
  createTile(
    coords: L.Coords,
    done: L.DoneCallback,
  ): HTMLImageElement;

  /**
   * Switch the rendered variable (e.g. `'rgb'` → `'pca_rgb'`).
   *
   * @param variable - New array name.
   *
   * @remarks
   * Clears the tile cache and redraws all visible tiles.
   */
  setVariable(variable: string): void;
}
```

---

## OpenLayers Plugin: `@ucam-eo/openlayers-tessera`

### Dependencies

| Dependency | Purpose |
|-----------|---------|
| `@ucam-eo/tessera` | Core tile rendering |
| `ol` (peer) | Map framework |

### tessera-tile-source.ts

```typescript
import TileSource from 'ol/source/Tile';
import type { Options as TileSourceOptions } from 'ol/source/Tile';
import { TesseraTileRenderer } from '@ucam-eo/tessera';

/**
 * OpenLayers tile source that serves TESSERA Zarr pyramid tiles.
 *
 * @remarks
 * Extends `ol/source/Tile` and provides a custom tile URL function
 * and loader backed by {@link TesseraTileRenderer}.
 *
 * @example
 * ```typescript
 * import { TesseraTileSource } from '@ucam-eo/openlayers-tessera';
 * import TileLayer from 'ol/layer/Tile';
 *
 * const source = new TesseraTileSource({
 *   url: 'https://dl2.geotessera.org/zarr/v1/2025.zarr/global_rgb',
 *   variable: 'rgb',
 * });
 * const layer = new TileLayer({ source });
 * map.addLayer(layer);
 * ```
 */
export class TesseraTileSource extends TileSource {
  /**
   * @param options - Standard OpenLayers tile source options plus
   *   tessera-specific options.
   */
  constructor(
    options: TileSourceOptions & {
      /** HTTP URL of the Zarr pyramid store. */
      url: string;

      /**
       * Zarr array variable to render.
       * @defaultValue `'rgb'`
       */
      variable?: string;
    },
  );

  /**
   * Switch the rendered variable (e.g. `'rgb'` → `'pca_rgb'`).
   *
   * @param variable - New array name.
   *
   * @remarks
   * Clears the tile cache and triggers a refresh of all visible tiles.
   */
  setVariable(variable: string): void;
}
```

---

## TypeDoc Integration

### Installation

```bash
pnpm add -D typedoc typedoc-plugin-markdown   # root workspace
```

### Per-Package Config — `packages/tessera/typedoc.json`

```json
{
  "entryPoints": ["src/index.ts"],
  "out": "../../docs/api/tessera",
  "tsconfig": "./tsconfig.json",
  "excludePrivate": true,
  "excludeInternal": true,
  "readme": "none",
  "sort": ["source-order"]
}
```

Similar files for each plugin package, with `out` pointing to
`../../docs/api/<package-name>`.

### Package Scripts — `packages/tessera/package.json`

```json
{
  "scripts": {
    "build": "vite build",
    "docs": "typedoc --plugin typedoc-plugin-markdown",
    "docs:html": "typedoc --plugin none"
  }
}
```

- `pnpm docs` — Markdown output (for GitHub / review)
- `pnpm docs:html` — Browsable HTML site

### Root Workspace Scripts — `tze/package.json`

```json
{
  "scripts": {
    "docs": "pnpm -r --filter './packages/*' run docs",
    "docs:html": "pnpm -r --filter './packages/*' run docs:html"
  }
}
```

### Vite Build Hook — `packages/tessera/vite.config.ts`

```typescript
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { exec } from 'child_process';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: ['proj4', 'zarrita', '@zarrita/storage'],
    },
  },
  plugins: [
    dts(),
    {
      name: 'typedoc-on-build',
      closeBundle() {
        exec('typedoc', (err) => {
          if (err) console.warn('[typedoc]', err.message);
        });
      },
    },
  ],
});
```

### Usage Summary

| Command | Effect |
|---------|--------|
| `pnpm --filter @ucam-eo/tessera docs` | Markdown API docs for core |
| `pnpm --filter @ucam-eo/tessera docs:html` | HTML API docs for core |
| `pnpm docs` | Docs for all packages |
| `pnpm docs:html` | HTML docs for all packages |
| `pnpm build` | Build all + regenerate docs |
| `open docs/api/tessera/index.html` | Browse core docs |

---

## Migration Guide

### Overview of API Renames

| Current | New | Package |
|---------|-----|---------|
| `ZarrTesseraSource` | `TesseraSource` (data) + `MaplibreTesseraSource` (display) | `tessera` + `maplibre-tessera` |
| `ZarrSourceManager` | `SourceManager` (data) + `MaplibreTesseraManager` (display) | `tessera` + `maplibre-tessera` |
| `ZarrTesseraOptions` | `TesseraOptions` (data) + `MaplibreDisplayOptions` (display) | `tessera` + `maplibre-tessera` |
| `ZarrTesseraEvents` | `TesseraEvents` | `tessera` |
| `loadChunkBatch(chunks, onProgress)` → `number` | `loadChunks(chunks, opts)` → `EmbeddingRegion` | `tessera` |
| `src.embeddingRegion = null` (direct mutation) | `src.clearRegion()` | `tessera` |
| `region.loaded[t] = 0` (direct mutation) | `src.evictTile(ci, cj)` | `tessera` |
| `isSouth` | `isSouth` (unchanged) | `tessera` |

### Method Routing: Data vs Display

After the split, the viewer accesses per-zone sources from two places.
Use this table to determine which object to call:

| Operation | Object | Access pattern |
|-----------|--------|---------------|
| `getEmbeddingAt(lng, lat)` | `manager` (data) | `display.manager.getEmbeddingAt(...)` |
| `getEmbeddingsInKernel(...)` | `manager` (data) | `display.manager.getEmbeddingsInKernel(...)` |
| `getChunksInRegion(polygon)` | `manager` (data) | `await display.manager.getChunksInRegion(...)` |
| `getEmbeddingRegions()` | `manager` (data) | `display.manager.getEmbeddingRegions()` |
| `loadChunks(chunks)` | `source` (data) | `source.loadChunks(chunks)` |
| `embeddingRegion` | `source` (data) | `source.embeddingRegion` |
| `evictTile(ci, cj)` | `source` (data) | `source.evictTile(ci, cj)` |
| `setSimilarityOverlay(canvas)` | `displaySource` (display) | `display.getDisplaySource(zoneId)?.setSimilarityOverlay(...)` |
| `addClassificationOverlay(...)` | `displaySource` (display) | `display.getDisplaySource(zoneId)?.addClassificationOverlay(...)` |
| `startRegionAnimation(...)` | `displayManager` (display) | `display.startRegionAnimation(zoneId, ...)` |
| `setOpacity(n)` | `displayManager` (display) | `display.setOpacity(n)` |
| `recolorAllChunks()` | `displayManager` (display) | `display.recolorAllChunks()` |

### Concrete Migration: Region Loading (drawing.ts)

This is the most complex consumer, interleaving data and display:

```typescript
// ─── BEFORE ───
const managedChunks = await manager.getChunksInRegion(geometry);
for (const [zoneId, chunks] of groupByZone(managedChunks)) {
  const src = manager.getOpenSource(zoneId);
  src?.startRegionAnimation(polygon, chunks);
  const openedSrc = await manager.getSource(zoneId);
  await openedSrc.loadChunkBatch(chunks, (p) => {
    manager.updateRegionAnimation(zoneId, p.loaded, p.total, p.ci, p.cj);
  });
  manager.stopRegionAnimation(zoneId);
}
manager.recolorAllChunks();

// ─── AFTER ───
const managedChunks = await display.manager.getChunksInRegion(geometry);
for (const [zoneId, chunks] of groupByZone(managedChunks)) {
  // Display: start animation
  display.startRegionAnimation(zoneId, polygon, chunks);

  // Data: load embeddings
  const source = await display.manager.getSource(zoneId);
  await source.loadChunks(chunks, {
    onProgress: (p) => {
      display.updateRegionAnimation(zoneId, p.chunksCompleted ?? 0, p.chunksTotal ?? 0, p.ci, p.cj);
    },
  });

  // Display: stop animation
  display.stopRegionAnimation(zoneId);
}
display.recolorAllChunks();
```

### Concrete Migration: Similarity Search

```typescript
// ─── BEFORE ───
const emb = manager.getEmbeddingAt(lng, lat);
const regions = manager.getEmbeddingRegions();
// ... compute similarity ...
const src = manager.getOpenSource(zoneId);
src?.setSimilarityOverlay(canvas);

// ─── AFTER ───
const emb = display.manager.getEmbeddingAt(lng, lat);
const regions = display.manager.getEmbeddingRegions();
// ... compute similarity ...
const displaySrc = display.getDisplaySource(zoneId);
displaySrc?.setSimilarityOverlay(canvas);
```

### Concrete Migration: Tile Eviction (drawing.ts)

```typescript
// ─── BEFORE ───
const region = src.embeddingRegion;
if (region) {
  const t = (ci - region.ciMin) * region.gridCols + (cj - region.cjMin);
  region.emb.fill(0, t * tileSize, (t + 1) * tileSize);
  region.loaded[t] = 0;
}
src.embeddingRegion = null;  // clear entirely

// ─── AFTER ───
source.evictTile(ci, cj);   // evict one tile
source.clearRegion();        // clear entirely
```

### tze viewer (`apps/viewer/`)

```typescript
// Before
import { ZarrSourceManager } from '@ucam-eo/maplibre-zarr-tessera';
import type { StoreMetadata, EmbeddingRegion, EmbeddingAt } from '@ucam-eo/maplibre-zarr-tessera';

// After — types come from core
import { SourceManager } from '@ucam-eo/tessera';
import type { StoreMetadata, EmbeddingRegion, EmbeddingAt } from '@ucam-eo/tessera';
import { MaplibreTesseraManager, registerZarrProtocol } from '@ucam-eo/maplibre-tessera';

const manager = new SourceManager(zones, { concurrency: 4 });
const display = new MaplibreTesseraManager(manager, {
  bands: [0, 1, 2],
  opacity: 0.8,
  preview: 'rgb',
  globalPreviewUrl: '...',
});
display.addTo(map);
```

### geotessera.org

```typescript
// Before
import { registerZarrProtocol } from '@ucam-eo/maplibre-zarr-tessera';

// After
import { registerZarrProtocol } from '@ucam-eo/maplibre-tessera';
```

geotessera.org only uses `registerZarrProtocol`, so the migration is a
one-line import path change. It still depends on the MapLibre plugin
(not just core) because it needs the `addProtocol` wrapper.

### Dependency updates

```jsonc
// tze/apps/viewer/package.json
{
  "dependencies": {
    "@ucam-eo/tessera": "workspace:*",
    "@ucam-eo/maplibre-tessera": "workspace:*"
  }
}

// geotessera.org/package.json
{
  "dependencies": {
    // Before:
    "@ucam-eo/maplibre-zarr-tessera": "link:../tze/packages/maplibre-zarr-tessera",
    // After:
    "@ucam-eo/maplibre-tessera": "link:../tze/packages/maplibre-tessera"
  }
}
```

### tessera-tasks dependency

The `@ucam-eo/tessera-tasks` package (if it exists as a separate package)
imports `EmbeddingRegion` and `EmbeddingAt` types. After the split, these
types come from `@ucam-eo/tessera` instead of `@ucam-eo/maplibre-zarr-tessera`.
Update its peer dependency accordingly.

---

## What Moves Where

| Current file | Destination | Notes |
|-------------|-------------|-------|
| `zarr-reader.ts` | `tessera/` | Unchanged |
| `projection.ts` | `tessera/` | Unchanged (`isSouth` name preserved) |
| `types.ts` | Split | Data types → `tessera/types.ts`; display types (`PreviewMode`, `CachedChunk`, `MaplibreDisplayOptions`) → `maplibre-tessera/types.ts` |
| `zarr-source.ts` | Split | Data access → `tessera/tessera-source.ts`; layers/overlays/animations → `maplibre-tessera/maplibre-source.ts` |
| `source-manager.ts` | Split | Geographic routing → `tessera/source-manager.ts`; MapLibre broadcasts → `maplibre-tessera/maplibre-manager.ts` |
| `zarr-tile-protocol.ts` | Split | Rendering logic → `tessera/tile-renderer.ts`; `addProtocol` wrapper → `maplibre-tessera/zarr-protocol.ts` |
| `worker-pool.ts` | `maplibre-tessera/` | Display concern |
| `render-worker.ts` | `maplibre-tessera/` | Display concern |
| `region-loading-animation.ts` | `maplibre-tessera/` | Display concern |

---

## Design Decisions

1. **No re-export of data methods on display classes.** Consumers
   access `.source` or `.manager` explicitly. Avoids API duplication
   and makes the data/display boundary visible in calling code.

2. **Composition, not inheritance.** The MapLibre plugin wraps the
   core via composition. This keeps the core testable without a DOM.

3. **Inline dequantisation in core.** The int8 × scale → float32
   multiplication runs synchronously during `loadChunks`. No workers
   needed — the math is fast. Workers are only for the RGBA canvas
   rendering (display concern).

4. **`TesseraTileRenderer.renderTile()` returns `ArrayBuffer` (PNG).**
   Universal interchange format. Every map framework can consume PNG
   bytes. Browser-only due to canvas dependency (documented).

5. **Leaflet and OpenLayers plugins are tile-only for now.** They
   validate the `TesseraTileRenderer` abstraction. Full embedding
   display for these frameworks would be separate future work.

6. **Payload-record event style.** Events use `{ 'name': PayloadType }`
   matching the current codebase pattern. The `EventEmitter` is a
   minimal hand-rolled implementation (no external dependency).

7. **`SourceManager.getChunksInRegion` is async.** Matches current
   behaviour: it lazily opens zones via `getSource()`. Synchronous-only
   queries use `getActiveSources()` manually.

8. **`MaplibreTesseraManager` auto-wraps new sources.** When
   `SourceManager.getSource()` opens a zone and emits
   `'metadata-loaded'`, the display manager intercepts this and creates
   a `MaplibreTesseraSource` wrapper with the base display options.

9. **`evictTile()` and `clearRegion()` replace direct mutation.**
   The viewer currently mutates `embeddingRegion` directly. These
   methods provide a controlled API for the same operations.
