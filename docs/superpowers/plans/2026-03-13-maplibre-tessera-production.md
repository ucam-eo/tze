# maplibre-tessera Production Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace legacy `ZarrTesseraSource` and `ZarrSourceManager` with clean composition-based `MaplibreTesseraSource` and `MaplibreTesseraManager`, fix tessera-tasks dependency direction, and update the viewer.

**Architecture:** Data operations live in `@ucam-eo/tessera` (`TesseraSource`, `SourceManager`). Analysis lives in `@ucam-eo/tessera-tasks`. Display-only logic (MapLibre layers, canvas rendering, animations, overlays) lives in `@ucam-eo/maplibre-tessera`. The viewer holds separate references to the data manager and display manager.

**Tech Stack:** TypeScript, MapLibre GL, Svelte 5, pnpm workspaces, Vite, TypeDoc

---

## File Structure

### New files
- `packages/tessera-tasks/src/classification-store.ts` — Per-tile classification map storage + lookup
- `packages/maplibre-tessera/src/chunk-renderer.ts` — WorkerPool + canvas rendering (extracted from zarr-source.ts)

### Rewritten files
- `packages/maplibre-tessera/src/maplibre-source.ts` — Full display implementation (~500 lines)
- `packages/maplibre-tessera/src/maplibre-manager.ts` — Full routing implementation (~200 lines)
- `packages/maplibre-tessera/src/index.ts` — Clean exports (no backward-compat re-exports)
- `packages/maplibre-tessera/src/types.ts` — Display-only types
- `apps/viewer/src/stores/zarr.ts` — Two stores: data manager + display manager

### Deleted files
- `packages/maplibre-tessera/src/zarr-source.ts` — Legacy monolith (1769 lines)
- `packages/maplibre-tessera/src/source-manager.ts` — Legacy manager (393 lines)

### Modified files
- `packages/tessera/src/tessera-source.ts` — Enhance `LoadChunksOptions.onProgress` to include `ChunkRef`
- `packages/tessera-tasks/package.json` — Dep: maplibre-tessera → tessera
- `packages/tessera-tasks/src/similarity.ts` — Import from tessera
- `packages/tessera-tasks/src/classify.ts` — Import from tessera
- `packages/tessera-tasks/src/segment.ts` — `ZarrTesseraSource` → `TesseraSource`
- `packages/tessera-tasks/src/index.ts` — Export `ClassificationStore`
- `apps/viewer/src/stores/drawing.ts` — Use new API
- `apps/viewer/src/stores/stac.ts` — Use new API
- `apps/viewer/src/stores/classifier.ts` — Import from tessera
- `apps/viewer/src/stores/similarity.ts` — Import from tessera
- `apps/viewer/src/lib/osm-sampler.ts` — `ZarrTesseraSource` → `TesseraSource`
- `apps/viewer/src/lib/tutorial.ts` — Update types
- `apps/viewer/src/lib/umap-subsample.ts` — Import from tessera
- `apps/viewer/src/App.svelte` — Use new API
- `apps/viewer/src/components/SimilaritySearch.svelte` — Use new API
- `apps/viewer/src/components/LabelPanel.svelte` — Use ClassificationStore
- `apps/viewer/src/components/SegmentPanel.svelte` — Use new API
- `apps/viewer/src/components/LayerSwitcher.svelte` — Use new API
- `apps/viewer/src/components/BandMapper.svelte` — Use new API
- `apps/viewer/src/components/ControlPanel.svelte` — Use new API
- `apps/viewer/src/components/OsmImport.svelte` — Use new API
- `apps/viewer/src/lib/tutorials/classify-with-osm.ts` — Use new API
- `apps/viewer/src/lib/tutorials/segmentation.ts` — Use new API

---

## Chunk 1: Foundation (non-breaking changes)

### Task 1: Enhance TesseraSource.loadChunks progress callback

The display layer needs to know WHICH chunk just finished loading so it can update per-tile animations. Add the `ChunkRef` to the progress callback.

**Files:**
- Modify: `packages/tessera/src/tessera-source.ts:21-27` (LoadChunksOptions)
- Modify: `packages/tessera/src/tessera-source.ts:188-201` (progress invocations)
- Modify: `packages/tessera/src/__tests__/tessera-source.test.ts`

- [ ] **Step 1: Update LoadChunksOptions type**

In `packages/tessera/src/tessera-source.ts`, change the `onProgress` signature:

```typescript
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
}
```

- [ ] **Step 2: Pass chunk ref in progress calls**

In the `next()` function inside `loadChunks`, update both progress invocations:

```typescript
// For already-loaded chunks (skip path):
opts?.onProgress?.(loaded, total, chunks[idx]);

// For newly-loaded chunks (after loadSingleChunk):
opts?.onProgress?.(loaded, total, chunks[idx]);
```

- [ ] **Step 3: Add test for chunk ref in progress**

In `packages/tessera/src/__tests__/tessera-source.test.ts`, add a test that verifies the chunk ref is passed. (Verify the existing mock setup allows this.)

- [ ] **Step 4: Run tests**

Run: `pnpm -F @ucam-eo/tessera test`
Expected: All 54 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/tessera/src/tessera-source.ts packages/tessera/src/__tests__/tessera-source.test.ts
git commit -m "feat(tessera): pass ChunkRef in loadChunks progress callback"
```

---

### Task 2: Fix tessera-tasks dependency direction

Change `@ucam-eo/tessera-tasks` to depend on `@ucam-eo/tessera` instead of `@ucam-eo/maplibre-tessera`.

**Files:**
- Modify: `packages/tessera-tasks/package.json:35`
- Modify: `packages/tessera-tasks/src/similarity.ts:1`
- Modify: `packages/tessera-tasks/src/classify.ts:3`
- Modify: `packages/tessera-tasks/src/segment.ts:2,66`

- [ ] **Step 1: Update package.json dependency**

In `packages/tessera-tasks/package.json`, replace `"@ucam-eo/maplibre-tessera": "workspace:*"` with:
```json
"dependencies": {
  "@ucam-eo/tessera": "workspace:*"
}
```

- [ ] **Step 2: Update similarity.ts import**

```typescript
import type { EmbeddingRegion } from '@ucam-eo/tessera';
```

- [ ] **Step 3: Update classify.ts import**

```typescript
import type { EmbeddingRegion } from '@ucam-eo/tessera';
```

- [ ] **Step 4: Update segment.ts imports and type**

```typescript
import type { EmbeddingRegion, TesseraSource } from '@ucam-eo/tessera';
```

Change the `run()` parameter type (line 66):
```typescript
source: TesseraSource,
```

- [ ] **Step 5: Run pnpm install and type-check**

```bash
pnpm install
pnpm -F @ucam-eo/tessera-tasks check
```
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add packages/tessera-tasks/
git commit -m "refactor(tessera-tasks): depend on @ucam-eo/tessera instead of maplibre-tessera"
```

---

### Task 3: Add ClassificationStore to tessera-tasks

Move classification map storage and lookup out of the display layer into tessera-tasks.

**Files:**
- Create: `packages/tessera-tasks/src/classification-store.ts`
- Modify: `packages/tessera-tasks/src/index.ts`

- [ ] **Step 1: Create ClassificationStore**

Create `packages/tessera-tasks/src/classification-store.ts`:

```typescript
import type { SourceManager, TesseraSource } from '@ucam-eo/tessera';

/**
 * Stores per-tile classification results and provides
 * geographic lookup across zones.
 *
 * @remarks
 * This is the analysis-side counterpart to the k-NN classifier.
 * Display overlays are managed separately by the map plugin.
 */
export class ClassificationStore {
  private maps = new Map<string, { width: number; height: number; classMap: Int16Array }>();

  /**
   * Store a per-pixel class ID map for a classified chunk.
   *
   * @param zoneId - Zone identifier (keys are zone-scoped to avoid collisions).
   * @param ci - Chunk row index.
   * @param cj - Chunk column index.
   * @param classMap - Per-pixel class IDs (-2 nodata, -1 uncertain, ≥0 class).
   * @param width - Tile width in pixels.
   * @param height - Tile height in pixels.
   */
  set(zoneId: string, ci: number, cj: number, classMap: Int16Array, width: number, height: number): void {
    this.maps.set(`${zoneId}:${ci}_${cj}`, { width, height, classMap });
  }

  /**
   * Look up the class ID at a pixel position within a chunk.
   *
   * @returns Class ID (≥0), -1 for uncertain, -2 for nodata, or `null` if
   *   no classification exists for that chunk.
   */
  getAtPixel(zoneId: string, ci: number, cj: number, row: number, col: number): number | null {
    const entry = this.maps.get(`${zoneId}:${ci}_${cj}`);
    if (!entry) return null;
    if (row < 0 || row >= entry.height || col < 0 || col >= entry.width) return null;
    return entry.classMap[row * entry.width + col];
  }

  /**
   * Look up the class ID at a WGS84 coordinate.
   *
   * @remarks
   * Searches all open zones in the manager for a classification result
   * at the given coordinate. Uses the zone's projection and metadata
   * for coordinate conversion.
   *
   * @param lng - Longitude in degrees.
   * @param lat - Latitude in degrees.
   * @param manager - The data manager (for coordinate conversion).
   * @returns Class ID (≥0), -1 for uncertain, -2 for nodata, or `null`.
   */
  getAt(lng: number, lat: number, manager: SourceManager): number | null {
    for (const [zoneId, source] of manager.getActiveSources()) {
      const result = this.getAtSource(zoneId, lng, lat, source);
      if (result !== null) return result;
    }
    return null;
  }

  /** Look up using a single source's coordinate system. */
  private getAtSource(zoneId: string, lng: number, lat: number, source: TesseraSource): number | null {
    const meta = source.metadata;
    const proj = source.projection;
    if (!meta || !proj) return null;

    const [e, n] = proj.forward(lng, lat);
    const t = meta.transform;
    const cs = meta.chunkShape;
    const s = meta.shape;

    const globalCol = Math.floor((e - t[2]) / t[0]);
    const globalRow = Math.floor((t[5] - n) / t[0]);
    if (globalCol < 0 || globalCol >= s[1] || globalRow < 0 || globalRow >= s[0]) return null;

    const ci = Math.floor(globalRow / cs[0]);
    const cj = Math.floor(globalCol / cs[1]);
    const row = globalRow - ci * cs[0];
    const col = globalCol - cj * cs[1];

    return this.getAtPixel(zoneId, ci, cj, row, col);
  }

  /** Clear all stored classification maps. */
  clear(): void {
    this.maps.clear();
  }

  /** Number of classified chunks stored. */
  get size(): number {
    return this.maps.size;
  }
}
```

- [ ] **Step 2: Export from index.ts**

Add to `packages/tessera-tasks/src/index.ts`:
```typescript
export { ClassificationStore } from './classification-store.js';
```

- [ ] **Step 3: Type-check**

```bash
pnpm -F @ucam-eo/tessera-tasks check
```

- [ ] **Step 4: Commit**

```bash
git add packages/tessera-tasks/src/classification-store.ts packages/tessera-tasks/src/index.ts
git commit -m "feat(tessera-tasks): add ClassificationStore for per-tile classification lookup"
```

---

## Chunk 2: MaplibreTesseraSource Implementation

### Task 4: Extract chunk renderer module

Extract the WorkerPool usage and canvas rendering into a focused module. This keeps `maplibre-source.ts` manageable.

**Files:**
- Create: `packages/maplibre-tessera/src/chunk-renderer.ts`

- [ ] **Step 1: Create chunk-renderer.ts**

Create `packages/maplibre-tessera/src/chunk-renderer.ts`. This module encapsulates:

1. **WorkerPool lifecycle** — create/terminate
2. **`renderChunkToCanvas()`** — dispatch render-rgb or render-emb to worker, return HTMLCanvasElement
3. **`renderRegionCanvas()`** — global min/max normalization across all loaded tiles → single canvas

Extract these from `zarr-source.ts`:
- `rgbaToCanvas()` (lines 1088-1097) — pure function, copy as-is
- The worker dispatch logic from `loadChunk()` (lines 1645-1658) — adapt to take explicit params
- The global normalization logic from `recolorAllChunks()` (lines 419-490) — adapt to pure function

The key API:

```typescript
import { WorkerPool } from './worker-pool.js';
import type { EmbeddingRegion } from '@ucam-eo/tessera';

/** Create an RGBA canvas from a raw buffer. */
export function rgbaToCanvas(rgba: ArrayBuffer, w: number, h: number): HTMLCanvasElement;

/**
 * Render embedding bands from a region tile to an RGBA canvas.
 * Uses global min/max normalization across all loaded tiles.
 *
 * @returns The rendered canvas, or null if no valid pixels.
 */
export function renderRegionCanvas(
  region: EmbeddingRegion,
  bands: [number, number, number],
): HTMLCanvasElement | null;
```

Copy the implementation from `zarr-source.ts:419-490` (recolorAllChunks normalization + canvas rendering), making it a pure function that takes an `EmbeddingRegion` and band indices instead of reading from `this`.

- [ ] **Step 2: Type-check**

```bash
pnpm -F @ucam-eo/maplibre-tessera check
```

- [ ] **Step 3: Commit**

```bash
git add packages/maplibre-tessera/src/chunk-renderer.ts
git commit -m "feat(maplibre-tessera): extract chunk-renderer module from legacy source"
```

---

### Task 5: Implement MaplibreTesseraSource

Rewrite `maplibre-source.ts` with full display logic extracted from `zarr-source.ts`.

**Files:**
- Rewrite: `packages/maplibre-tessera/src/maplibre-source.ts`

This is the largest task. The class owns:
- MapLibre map reference
- WorkerPool for parallel tile rendering
- Chunk cache (Map<string, CachedChunk>) with LRU eviction
- Per-tile loading animations
- Region-wide loading animation
- Viewport-driven loading (moveend handler)
- Overlay management (similarity, classification, RGB)
- Layer z-ordering
- Global preview layer

The class delegates data operations to its `readonly source: TesseraSource`.

- [ ] **Step 1: Write the class skeleton with private fields**

Extract the following private fields from `zarr-source.ts` lines 27-51:

```typescript
import type { Map as MaplibreMap } from 'maplibre-gl';
import {
  TesseraSource,
  type StoreMetadata,
  type EmbeddingRegion,
  type ChunkRef,
  type UtmBounds,
} from '@ucam-eo/tessera';
import type { CachedChunk, PreviewMode, MaplibreDisplayOptions } from './types.js';
import { WorkerPool } from './worker-pool.js';
import { RegionLoadingAnimation } from './region-loading-animation.js';
import { clearZarrProtocolCache } from './zarr-tile-protocol.js';
import { rgbaToCanvas, renderRegionCanvas } from './chunk-renderer.js';

/** Combined options: core + display. */
export type MaplibreTesseraOptions = MaplibreDisplayOptions;

type ResolvedDisplayOptions = Required<Omit<MaplibreDisplayOptions, 'globalPreviewBounds'>> & {
  globalPreviewBounds?: [number, number, number, number];
};

export class MaplibreTesseraSource {
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
  private loadingAnimations = new Map<string, number>();
  private tileProgress = new Map<string, number>();
  private batchLoading = false;
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
  // ... methods follow
}
```

- [ ] **Step 2: Implement lifecycle methods**

Extract from `zarr-source.ts` lines 69-150. Key changes:
- `addTo()`: does NOT open the store (source is already open). Creates WorkerPool, registers moveend, adds preview layer, does initial viewport load.
- `remove()`: tears down all display state. Calls `source.close()` only if this source owns the lifecycle (it doesn't — the SourceManager does). Just clean up display.

```typescript
async addTo(map: MaplibreMap): Promise<void> {
  this.map = map;
  const poolSize = Math.min(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4, 8);
  this.workerPool = new WorkerPool(poolSize);

  // Suppress AbortError spam from MapLibre internals
  this.abortHandler = (e) => {
    if (e.reason?.name === 'AbortError') e.preventDefault();
  };
  window.addEventListener('unhandledrejection', this.abortHandler);

  this.addPreviewLayer();
  this.moveHandler = () => this.updateVisibleChunks();
  map.on('moveend', this.moveHandler);
  this.updateVisibleChunks();
}

remove(): void {
  if (this.moveHandler && this.map) {
    this.map.off('moveend', this.moveHandler);
  }
  if (this.abortHandler) {
    window.removeEventListener('unhandledrejection', this.abortHandler);
  }
  this.currentAbort?.abort();
  this.stopRegionAnimation();

  for (const key of this.chunkCache.keys()) this.removeChunkFromMap(key);
  for (const frameId of this.loadingAnimations.values()) cancelAnimationFrame(frameId);
  this.loadingAnimations.clear();
  this.tileProgress.clear();

  this.removePreviewLayer();
  this.clearSimilarityOverlay();
  this.clearRgbOverlay();

  this.chunkCache.clear();
  this.workerPool?.terminate();
  this.workerPool = null;
  this.moveHandler = null;
  this.abortHandler = null;
  this.map = null;
}
```

- [ ] **Step 3: Implement coordinate helpers**

These are thin wrappers around the core source's methods and the UTM projection:

```typescript
private chunkKey(ci: number, cj: number): string { return `${ci}_${cj}`; }

private chunkUtmBounds(ci: number, cj: number): UtmBounds { /* same as zarr-source.ts:1033-1045 */ }

private chunkCorners(ci: number, cj: number) { /* delegates to source.getChunkBoundsLngLat */ }
```

Copy from `zarr-source.ts` lines 1020-1049, adapting `this.store` → `this.source.metadata` and `this.proj` → `this.source.projection`.

- [ ] **Step 4: Implement chunk rendering and map layer methods**

Copy these private methods from `zarr-source.ts`:
- `rgbaToCanvas` → imported from `chunk-renderer.ts` (already extracted)
- `addChunkToMap(ci, cj, canvas)` → lines 1099-1119, use `this.source.getChunkBoundsLngLat`
- `removeChunkFromMap(key)` → lines 1538-1547, same logic
- `visibleChunkIndices()` → lines 1051-1086, use `this.source.metadata`, `this.source.projection`, `this.source._store`

- [ ] **Step 5: Implement viewport loading**

Copy `updateVisibleChunks()` from `zarr-source.ts` lines 1549-1631.

Key changes:
- `this.store` → `this.source.metadata` and `this.source._store`
- `this.proj` → `this.source.projection`
- `this.loadChunk()` calls → adapt to use `this.source._store` for data fetching + `this.workerPool` for rendering
- LRU eviction stays the same

Also copy the private `loadChunk()` method (lines 1633-1699) which loads a single viewport preview tile. Adapt store access.

- [ ] **Step 6: Implement overlay methods**

Copy these from `zarr-source.ts`, using the LEGACY signatures (not the stub signatures which are wrong):

- `setSimilarityOverlay(canvas: HTMLCanvasElement)` → lines 828-866 (stub had `Float32Array` — wrong, viewer passes canvas)
- `clearSimilarityOverlay()` → lines 869-875
- `clearRgbOverlay()` → lines 878-884
- `addClassificationOverlay(ci: number, cj: number, canvas: HTMLCanvasElement)` → lines 889-891 (stub had `Uint8Array, string[]` — wrong, viewer passes ci/cj/canvas)
- `addClassificationOverlayBatch(tiles: {ci, cj, canvas}[])` → lines 895-922
- `clearClassificationOverlays()` → lines 958-974 (but remove `classificationMaps.clear()` — that state is now in tessera-tasks ClassificationStore)
- `setClassificationOpacity(opacity)` → lines 977-986

Key change: `clearClassificationOverlays()` no longer clears classification data — it only removes MapLibre layers. The `classificationMaps` field is removed from this class entirely.

- [ ] **Step 7: Implement region rendering**

Copy `recolorAllChunks()` from `zarr-source.ts` lines 419-524. Two options:
1. Use the extracted `renderRegionCanvas()` from chunk-renderer.ts
2. Or keep the method inline since it touches MapLibre layers

Keep inline (it creates the canvas AND adds the MapLibre layer). Adapt:
- `this.embeddingRegion` → `this.source.embeddingRegion`
- `this.store` → `this.source.metadata`
- `this.proj` → `this.source.projection`

- [ ] **Step 8: Implement layer ordering**

Copy `raiseOverlayLayers()` from `zarr-source.ts` lines 1491-1536 and `raiseAllLayers()` wrapper. Same logic, just a method on the new class. Also copy `reAddAllLayers()` from lines 200-229.

- [ ] **Step 9: Implement preview layer**

Copy `addPreviewLayer()` (lines 1717-1768) and `removePreviewLayer()` (lines 1707-1715).
Change: `this.opts.preview === 'pca' ? 'pca_rgb' : 'rgb'` is already simplified to just `'rgb'` (PCA was removed).

- [ ] **Step 10: Implement animation methods**

Copy from `zarr-source.ts`:
- `startRegionAnimation()` → lines 585-620
- `updateRegionAnimation()` → lines 623-629
- `stopRegionAnimation()` → lines 632-637
- `startLoadingAnimation()` → lines 1122-1466 (the big cyberpunk glitch animation)
- `stopLoadingAnimation()` → lines 1469-1482

Adapt `this.chunkCorners` usage.

- [ ] **Step 11: Implement configuration methods**

Copy from `zarr-source.ts`:
- `setBands()` → lines 156-159
- `setOpacity()` → lines 161-180
- `setPreview()` → lines 182-195

- [ ] **Step 12: Implement loadChunkBatch**

This is the display-side batch loader. Wraps `source.loadChunks()` with animations and triggers rendering.

The legacy `loadChunkBatch` (zarr-source.ts:529-582) calls `loadFullChunk()` per tile, which both loads data AND starts/stops per-tile loading animations. In the new architecture:

1. Data loading is delegated to `source.loadChunks()` (which dequantizes into EmbeddingRegion)
2. Per-tile loading animations are started before and stopped after each chunk via the enhanced progress callback
3. After all data is loaded, `recolorAllChunks()` renders the entire region to a single canvas and adds it as a MapLibre layer

```typescript
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
      // Stop the loading animation for the just-finished chunk
      this.stopLoadingAnimation(chunk.ci, chunk.cj);
      onProgress?.(loaded, total, chunk.ci, chunk.cj);
    },
  });

  this.batchLoading = false;
  return chunks.length;
}
```

Note: The caller (`drawing.ts`) calls `recolorAllChunks()` after `loadChunkBatch()` returns, so the tiles are rendered into a visible MapLibre layer at that point. This matches the existing pattern where `drawing.ts` calls `manager.recolorAllChunks()` after all zones are loaded.
```

- [ ] **Step 13: Add convenience accessors**

```typescript
getMetadata(): StoreMetadata | null { return this.source.metadata; }
regionHasTile(ci: number, cj: number): boolean { return this.source.regionHasTile(ci, cj); }
regionTileCount(): number { return this.source.tileCount; }
```

- [ ] **Step 14: Type-check**

```bash
pnpm -F @ucam-eo/maplibre-tessera check
```

Fix any type errors. Both old and new files coexist at this point.

- [ ] **Step 15: Commit**

```bash
git add packages/maplibre-tessera/src/maplibre-source.ts packages/maplibre-tessera/src/chunk-renderer.ts
git commit -m "feat(maplibre-tessera): implement MaplibreTesseraSource with full display logic"
```

---

### Task 6: Implement MaplibreTesseraManager

Rewrite `maplibre-manager.ts` to route display operations across per-zone `MaplibreTesseraSource` instances.

**Files:**
- Rewrite: `packages/maplibre-tessera/src/maplibre-manager.ts`

- [ ] **Step 1: Rewrite the manager**

The manager:
- Wraps `SourceManager` for zone routing
- Lazily creates `MaplibreTesseraSource` per zone
- Broadcasts display operations to all open display sources
- Routes zone-specific operations (animation) to the correct source

The existing stub at `maplibre-manager.ts` already has the correct shape. Fill in the real implementations:

Key change: `getDisplaySource()` now opens the core source AND creates the display source with `addTo(map)`.

- [ ] **Step 2: Type-check**

```bash
pnpm -F @ucam-eo/maplibre-tessera check
```

- [ ] **Step 3: Commit**

```bash
git add packages/maplibre-tessera/src/maplibre-manager.ts
git commit -m "feat(maplibre-tessera): implement MaplibreTesseraManager display routing"
```

---

## Chunk 3: Clean Exports and Delete Legacy

### Task 7: Clean up maplibre-tessera index.ts and types

**Files:**
- Rewrite: `packages/maplibre-tessera/src/index.ts`
- Modify: `packages/maplibre-tessera/src/types.ts`

- [ ] **Step 1: Rewrite index.ts**

```typescript
// @ucam-eo/maplibre-tessera — MapLibre display plugin for TESSERA embeddings

export { MaplibreTesseraSource } from './maplibre-source.js';
export type { MaplibreTesseraOptions } from './maplibre-source.js';
export { MaplibreTesseraManager } from './maplibre-manager.js';
export { registerZarrProtocol, clearZarrProtocolCache } from './zarr-tile-protocol.js';

// Display-only types
export type { PreviewMode, MaplibreDisplayOptions, CachedChunk } from './types.js';
```

No backward-compat type re-exports. Consumers import data types from `@ucam-eo/tessera` directly.

- [ ] **Step 2: Commit**

```bash
git add packages/maplibre-tessera/src/index.ts packages/maplibre-tessera/src/types.ts
git commit -m "refactor(maplibre-tessera): clean public exports, remove backward-compat re-exports"
```

---

### Task 8: Delete legacy classes

**Files:**
- Delete: `packages/maplibre-tessera/src/zarr-source.ts`
- Delete: `packages/maplibre-tessera/src/source-manager.ts`

- [ ] **Step 1: Delete the files**

```bash
rm packages/maplibre-tessera/src/zarr-source.ts
rm packages/maplibre-tessera/src/source-manager.ts
```

- [ ] **Step 2: Type-check maplibre-tessera**

```bash
pnpm -F @ucam-eo/maplibre-tessera check
```

Fix any remaining references.

- [ ] **Step 3: Commit**

```bash
git add -u packages/maplibre-tessera/src/
git commit -m "refactor(maplibre-tessera): delete legacy ZarrTesseraSource and ZarrSourceManager"
```

---

## Chunk 4: Viewer Migration

### Task 9: Update viewer stores

**Files:**
- Modify: `apps/viewer/src/stores/zarr.ts`
- Modify: `apps/viewer/src/stores/stac.ts`
- Modify: `apps/viewer/src/stores/classifier.ts`
- Modify: `apps/viewer/src/stores/drawing.ts`

- [ ] **Step 1: Add dual stores to zarr.ts**

```typescript
import { writable } from 'svelte/store';
import type { SourceManager, StoreMetadata } from '@ucam-eo/tessera';
import type { MaplibreTesseraManager } from '@ucam-eo/maplibre-tessera';

/** Core data manager — embedding queries, zone routing, events. */
export const sourceManager = writable<SourceManager | null>(null);

/** MapLibre display manager — layers, overlays, animations. */
export const displayManager = writable<MaplibreTesseraManager | null>(null);

export const metadata = writable<StoreMetadata | null>(null);
export const bands = writable<[number, number, number]>([0, 1, 2]);
export const opacity = writable(0.6);
export const preview = writable<'rgb' | 'bands'>('rgb');
export const loading = writable({ total: 0, done: 0 });
export const status = writable('Ready');
export const globalPreviewUrl = writable<string>('');
export const globalPreviewBounds = writable<[number, number, number, number] | null>(null);
```

- [ ] **Step 2: Update stac.ts initialization**

Change from `new ZarrSourceManager(...)` to:

```typescript
import { SourceManager } from '@ucam-eo/tessera';
import { MaplibreTesseraManager, registerZarrProtocol, clearZarrProtocolCache } from '@ucam-eo/maplibre-tessera';

// In connectToStac():
const manager = new SourceManager(
  filteredZones.map(z => ({ id: z.id, bbox: z.bbox, zarrUrl: z.zarrUrl })),
  { concurrency: 4 },
);
const display = new MaplibreTesseraManager(manager, {
  bands: get(bands),
  opacity: get(opacity),
  preview: get(preview),
  globalPreviewUrl: get(globalPreviewUrl),
  globalPreviewBounds: get(globalPreviewBounds) ?? undefined,
  maxCached: mobile ? 4 : undefined,
});

manager.on('metadata-loaded', (meta) => { metadata.set(meta); });
manager.on('loading', (p) => loading.set(p));
manager.on('error', (err) => status.set(`Error: ${err.message}`));

await display.addTo(map);
sourceManager.set(manager);
displayManager.set(display);

// Open initial zone
await display.getDisplaySource(zone.id);
```

- [ ] **Step 3: Update classifier.ts imports**

Change `import type { EmbeddingAt } from '@ucam-eo/maplibre-tessera'` to:
```typescript
import type { EmbeddingAt } from '@ucam-eo/tessera';
```

Add classification store:
```typescript
import { ClassificationStore } from '@ucam-eo/tessera-tasks';
export const classificationStore = writable(new ClassificationStore());
```

- [ ] **Step 4: Update drawing.ts**

This is the most complex migration. Key changes:

- `manager.getChunksInRegion()` → `get(sourceManager)!.getChunksInRegion()`
- `manager.getOpenSource(zoneId)` → `get(displayManager)!.getOpenDisplaySource(zoneId)` for display ops
- `src.startRegionAnimation()` stays on display source
- `src.loadChunkBatch()` stays on display source
- `src.updateRegionAnimation()` stays on display source
- `manager.stopRegionAnimation()` → `get(displayManager)!.stopRegionAnimation()`
- `manager.recolorAllChunks()` → `get(displayManager)!.recolorAllChunks()`
- `manager.regionHasTile()` → `get(sourceManager)!.regionHasTile()`
- `manager.totalTileCount()` → `get(sourceManager)!.totalTileCount()`
- `src.embeddingRegion` reads → `src.source.embeddingRegion`
- `src.embeddingRegion = null` → `src.source.clearRegion()`
- Direct tile eviction (NaN writes) → `src.source.evictTile(ci, cj)`
- `manager.getActiveSources()` → `get(sourceManager)!.getActiveSources()` for data ops
- `manager.clearClassificationOverlays()` → `get(displayManager)!.clearClassificationOverlays()`

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/stores/
git commit -m "refactor(viewer): update stores for data/display manager split"
```

---

### Task 10: Update viewer components

**Files:**
- Modify: `apps/viewer/src/App.svelte`
- Modify: `apps/viewer/src/components/SimilaritySearch.svelte`
- Modify: `apps/viewer/src/components/LabelPanel.svelte`
- Modify: `apps/viewer/src/components/SegmentPanel.svelte`
- Modify: `apps/viewer/src/components/LayerSwitcher.svelte`
- Modify: `apps/viewer/src/components/BandMapper.svelte`
- Modify: `apps/viewer/src/components/ControlPanel.svelte`
- Modify: `apps/viewer/src/components/OsmImport.svelte`

- [ ] **Step 1: Update App.svelte**

Key changes:
- Import `displayManager` and `sourceManager` from stores
- `registerZarrProtocol` stays the same (imported from maplibre-tessera)
- Data queries (`getChunkAtLngLat`, `getEmbeddingAt`, `getEmbeddingsInKernel`, `getChunkBoundsLngLat`) → `$sourceManager`
- `getClassificationAt` → `get(classificationStore).getAt(lng, lat, $sourceManager!)` (from tessera-tasks ClassificationStore)
- Lazy zone opening in moveend → `$displayManager?.getDisplaySource(zone.id)`

- [ ] **Step 2: Update SimilaritySearch.svelte**

- Data queries → `$sourceManager`
- Event subscriptions → `$sourceManager.on(...)`
- Display operations (setSimilarityOverlay, clearSimilarityOverlay) → `$displayManager`
- `mgr.getOpenSource(zoneId)` → `$displayManager!.getOpenDisplaySource(zoneId)`
- `src?.setSimilarityOverlay(canvas)` stays (it's a display method)

- [ ] **Step 3: Update LabelPanel.svelte**

- `mgr.clearClassificationOverlays()` → `$displayManager!.clearClassificationOverlays()`
- `mgr.getEmbeddingRegions()` → `$sourceManager!.getEmbeddingRegions()`
- `mgr.getOpenSource(zoneId)` → `$displayManager!.getOpenDisplaySource(zoneId)`
- `source.addClassificationOverlay(ci, cj, canvas)` stays (display method)
- `source.setClassificationOpacity(opacity)` stays (display method)
- `source.setClassificationMap(ci, cj, classMap, w, h)` → `get(classificationStore).set(zoneId, ci, cj, classMap, w, h)`

- [ ] **Step 4: Update remaining components**

For each component, the pattern is:
- Display operations (`setOpacity`, `setBands`, `setPreview`, `raiseAllLayers`, `setClassificationOpacity`) → `$displayManager`
- Data queries (`totalTileCount`, `getEmbeddingRegions`, `embeddingBoundsLngLat`) → `$sourceManager`
- Event subscriptions → `$sourceManager`
- Getting zone sources for display → `$displayManager.getOpenDisplaySource(zoneId)`
- Getting zone sources for data → `$sourceManager.getOpenSource(zoneId)`

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/App.svelte apps/viewer/src/components/
git commit -m "refactor(viewer): update components for data/display manager split"
```

---

### Task 11: Update viewer library files

**Files:**
- Modify: `apps/viewer/src/lib/osm-sampler.ts`
- Modify: `apps/viewer/src/lib/tutorial.ts`
- Modify: `apps/viewer/src/lib/umap-subsample.ts`
- Modify: `apps/viewer/src/lib/tutorials/classify-with-osm.ts`
- Modify: `apps/viewer/src/lib/tutorials/segmentation.ts`

- [ ] **Step 1: Update osm-sampler.ts**

```typescript
import type { TesseraSource } from '@ucam-eo/tessera';
import type { EmbeddingAt } from '@ucam-eo/tessera';
// Change parameter type:
source: TesseraSource,
```

- [ ] **Step 2: Update tutorial.ts**

```typescript
import type { SourceManager } from '@ucam-eo/tessera';
import type { MaplibreTesseraManager } from '@ucam-eo/maplibre-tessera';
// TutorialContext gets both:
manager: SourceManager;
display: MaplibreTesseraManager;
```

- [ ] **Step 3: Update umap-subsample.ts**

```typescript
import type { EmbeddingRegion } from '@ucam-eo/tessera';
```

- [ ] **Step 4: Update tutorial implementations**

Both `classify-with-osm.ts` and `segmentation.ts` use `ctx.manager.*`:
- Data queries → `ctx.manager.*`
- Display operations → `ctx.display.*`
- Classification maps → use ClassificationStore

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/lib/
git commit -m "refactor(viewer): update library files for data/display split"
```

---

## Chunk 5: Polish

### Task 12: Build and type-check everything

- [ ] **Step 1: Full build**

```bash
pnpm build
```

- [ ] **Step 2: Run all tests**

```bash
pnpm test
```

- [ ] **Step 3: Fix any issues found**

### Task 13: Update TypeDoc

**Files:**
- Modify: `packages/maplibre-tessera/typedoc.json`

- [ ] **Step 1: Update typedoc config**

The config should now point at the clean index.ts. Remove `excludeReferences` (no more re-exports to exclude).

```json
{
  "entryPoints": ["src/index.ts"],
  "out": "../../docs/api/maplibre-tessera",
  "tsconfig": "./tsconfig.json",
  "excludePrivate": true,
  "excludeInternal": true,
  "readme": "none",
  "sort": ["source-order"]
}
```

- [ ] **Step 2: Regenerate docs**

```bash
pnpm -F @ucam-eo/tessera build && pnpm -F @ucam-eo/tessera docs:html
pnpm -F @ucam-eo/maplibre-tessera build && pnpm -F @ucam-eo/maplibre-tessera docs:html
```

Expected: Zero warnings for both packages.

- [ ] **Step 3: Commit**

```bash
git add docs/api/ packages/maplibre-tessera/typedoc.json
git commit -m "docs: regenerate TypeDoc for clean maplibre-tessera API"
```

### Task 14: Update CLAUDE.md

- [ ] **Step 1: Update monorepo layout section**

Reflect the new package structure: the `maplibre-tessera` package now has `maplibre-source.ts` and `maplibre-manager.ts` instead of `zarr-source.ts` and `source-manager.ts`.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for maplibre-tessera refactor"
```
