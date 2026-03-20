# Tessera Library Split Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `@ucam-eo/tessera` core library from `@ucam-eo/maplibre-zarr-tessera`, rename the MapLibre plugin to `@ucam-eo/maplibre-tessera`, create Leaflet and OpenLayers validation plugins, and migrate all consumers.

**Architecture:** The monolithic `maplibre-zarr-tessera` package is split into a framework-agnostic core (`tessera`) handling Zarr data access, dequantisation, projection, events, and tile rendering, plus thin map-framework plugins. Composition over inheritance: display wrappers hold a reference to their core counterpart via `.source` / `.manager`.

**Tech Stack:** TypeScript 5.7, Vite 6, vitest 3, pnpm workspaces, zarrita (custom coalesce fork), proj4, TypeDoc

**Spec:** `docs/superpowers/specs/2026-03-13-tessera-library-split-design.md`

---

## Chunk 1: Core Package Scaffolding and Data Types

### Task 1: Create `packages/tessera/` package scaffold

**Files:**
- Create: `packages/tessera/package.json`
- Create: `packages/tessera/tsconfig.json`
- Create: `packages/tessera/vite.config.ts`
- Create: `packages/tessera/typedoc.json`
- Create: `packages/tessera/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@ucam-eo/tessera",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "scripts": {
    "build": "vite build && tsc --emitDeclarationOnly",
    "test": "vitest run",
    "check": "tsc --noEmit",
    "docs": "typedoc --plugin typedoc-plugin-markdown",
    "docs:html": "typedoc --plugin none"
  },
  "dependencies": {
    "proj4": "^2.20.3",
    "zarrita": "^0.6.1"
  },
  "devDependencies": {
    "@types/proj4": "^2.19.0",
    "typedoc": "^0.28.0",
    "typedoc-plugin-markdown": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vite-plugin-dts": "^4.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { exec } from 'child_process';

export default defineConfig({
  build: {
    lib: {
      entry: './src/index.ts',
      name: 'Tessera',
      formats: ['es', 'cjs'],
      fileName: 'index',
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

- [ ] **Step 4: Create typedoc.json**

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

- [ ] **Step 5: Create empty index.ts**

```typescript
// @ucam-eo/tessera — core TESSERA embedding access library
// Exports will be added as modules are implemented.
```

- [ ] **Step 6: Install dependencies**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm install`
Expected: Successful install with `@ucam-eo/tessera` linked in workspace.

- [ ] **Step 7: Verify build**

Run: `pnpm --filter @ucam-eo/tessera build`
Expected: Build succeeds (empty library).

- [ ] **Step 8: Commit**

```bash
git add packages/tessera/
git commit -m "feat: scaffold @ucam-eo/tessera core package"
```

---

### Task 2: Move types.ts to core package

**Files:**
- Create: `packages/tessera/src/types.ts`
- Create: `packages/tessera/src/__tests__/types.test.ts`
- Modify: `packages/tessera/src/index.ts`

The types are copied from `packages/maplibre-zarr-tessera/src/types.ts` with display-specific types (`CachedChunk`, `PreviewMode`) left behind. All types get full TSDoc comments as defined in the spec.

- [ ] **Step 1: Write type sanity test**

Create `packages/tessera/src/__tests__/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type {
  TesseraOptions, StoreMetadata, ChunkRef, ManagedChunk,
  EmbeddingRegion, EmbeddingAt, ZoneDescriptor, EmbeddingProgress,
  DebugLogEntry, UtmBounds, ChunkBounds, TesseraEvents,
  TileRendererOptions,
} from '../types.js';

describe('types', () => {
  it('StoreMetadata has correct tuple types', () => {
    const meta: StoreMetadata = {
      url: 'https://example.com/store.zarr',
      utmZone: 30,
      epsg: 32630,
      transform: [500000, 10, 0, 6000000, 0, -10],
      shape: [600, 600, 128],
      chunkShape: [4, 4, 128],
      nBands: 128,
      hasRgb: true,
      hasPca: false,
    };
    expect(meta.transform).toHaveLength(6);
    expect(meta.shape).toHaveLength(3);
    expect(meta.chunkShape).toHaveLength(3);
  });

  it('EmbeddingRegion layout is consistent', () => {
    const region: EmbeddingRegion = {
      ciMin: 0, ciMax: 1, cjMin: 0, cjMax: 1,
      gridRows: 2, gridCols: 2,
      tileW: 4, tileH: 4, nBands: 128,
      emb: new Float32Array(2 * 2 * 4 * 4 * 128),
      loaded: new Uint8Array(4),
    };
    expect(region.emb.length).toBe(
      region.gridRows * region.gridCols * region.tileH * region.tileW * region.nBands,
    );
    expect(region.loaded.length).toBe(region.gridRows * region.gridCols);
  });

  it('TesseraEvents keys match expected event names', () => {
    // Type-level check: this object must satisfy TesseraEvents shape
    const events: TesseraEvents = {
      'metadata-loaded': {} as StoreMetadata,
      'chunk-loaded': { ci: 0, cj: 0 },
      'embeddings-loaded': { ci: 0, cj: 0 },
      'embedding-progress': { ci: 0, cj: 0, stage: 'fetching' },
      'error': new Error('test'),
      'loading': { total: 10, done: 5 },
      'debug': { time: 0, type: 'info', msg: 'test' },
    };
    expect(Object.keys(events)).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ucam-eo/tessera test`
Expected: FAIL — `../types.js` not found.

- [ ] **Step 3: Create types.ts**

Create `packages/tessera/src/types.ts` with the full typed definitions from the spec. Copy the data-only types from `packages/maplibre-zarr-tessera/src/types.ts` (lines 1-104) and add TSDoc. Specifically include:

- `TesseraOptions` (new, replaces data fields of `ZarrTesseraOptions`)
- `StoreMetadata` (from current, with `url` field, tuple types preserved)
- `ChunkRef` (new, extracted from inline `{ ci, cj }`)
- `ManagedChunk` (from current `source-manager.ts:26-30`)
- `EmbeddingRegion` (from current `types.ts:82-96`)
- `EmbeddingAt` (from current `types.ts:98-104`)
- `ZoneDescriptor` (from current `ZoneInfo` in `source-manager.ts:18-22`)
- `EmbeddingProgress` (from current `types.ts:59-67`)
- `DebugLogEntry` (from current `types.ts:53-57`)
- `UtmBounds` (from current `types.ts:35-40`)
- `ChunkBounds` (from current `types.ts:28-33`, marked `@internal`)
- `TesseraEvents` (from current `ZarrTesseraEvents` in `types.ts:69-77`, payload-record style)
- `TileRendererOptions` (new)

See the spec for exact field definitions and TSDoc comments.

- [ ] **Step 4: Export types from index.ts**

Update `packages/tessera/src/index.ts`:

```typescript
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
} from './types.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ucam-eo/tessera test`
Expected: PASS — 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/tessera/src/types.ts packages/tessera/src/__tests__/types.test.ts packages/tessera/src/index.ts
git commit -m "feat(tessera): add core type definitions with TSDoc"
```

---

### Task 3: Move EventEmitter to core package

**Files:**
- Create: `packages/tessera/src/event-emitter.ts`
- Create: `packages/tessera/src/__tests__/event-emitter.test.ts`
- Modify: `packages/tessera/src/index.ts`

The current event system is inlined in both `zarr-source.ts` (lines 986-1007) and `source-manager.ts` (lines 374-393) as a hand-rolled `on/off/emit` pattern. Extract into a reusable generic class.

- [ ] **Step 1: Write failing test**

Create `packages/tessera/src/__tests__/event-emitter.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../event-emitter.js';

interface TestEvents {
  ping: string;
  count: number;
  empty: undefined;
}

describe('EventEmitter', () => {
  it('calls listener with correct payload', () => {
    const emitter = new EventEmitter<TestEvents>();
    const cb = vi.fn();
    emitter.on('ping', cb);
    emitter['emit']('ping', 'hello');
    expect(cb).toHaveBeenCalledWith('hello');
  });

  it('supports multiple listeners', () => {
    const emitter = new EventEmitter<TestEvents>();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    emitter.on('count', cb1);
    emitter.on('count', cb2);
    emitter['emit']('count', 42);
    expect(cb1).toHaveBeenCalledWith(42);
    expect(cb2).toHaveBeenCalledWith(42);
  });

  it('removes listener with off()', () => {
    const emitter = new EventEmitter<TestEvents>();
    const cb = vi.fn();
    emitter.on('ping', cb);
    emitter.off('ping', cb);
    emitter['emit']('ping', 'ignored');
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not throw when emitting with no listeners', () => {
    const emitter = new EventEmitter<TestEvents>();
    expect(() => emitter['emit']('ping', 'test')).not.toThrow();
  });

  it('isolates events by name', () => {
    const emitter = new EventEmitter<TestEvents>();
    const pingCb = vi.fn();
    const countCb = vi.fn();
    emitter.on('ping', pingCb);
    emitter.on('count', countCb);
    emitter['emit']('ping', 'hello');
    expect(pingCb).toHaveBeenCalledOnce();
    expect(countCb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ucam-eo/tessera test`
Expected: FAIL — `../event-emitter.js` not found.

- [ ] **Step 3: Implement EventEmitter**

Create `packages/tessera/src/event-emitter.ts`:

```typescript
type EventCallback<T> = (data: T) => void;

/**
 * Minimal typed event emitter.
 *
 * @remarks
 * Events use a payload-record style: each event name maps to a
 * payload type. Listeners receive the payload as their single argument.
 *
 * @typeParam T - Event map: `{ eventName: PayloadType }`.
 */
export class EventEmitter<T extends Record<string, unknown>> {
  private listeners = new Map<string, Set<EventCallback<unknown>>>();

  /** Subscribe to an event. */
  on<K extends keyof T & string>(
    event: K,
    callback: EventCallback<T[K]>,
  ): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback as EventCallback<unknown>);
  }

  /** Unsubscribe from an event. */
  off<K extends keyof T & string>(
    event: K,
    callback: EventCallback<T[K]>,
  ): void {
    this.listeners.get(event)?.delete(callback as EventCallback<unknown>);
  }

  /** Emit an event to all subscribers. */
  protected emit<K extends keyof T & string>(
    event: K,
    data: T[K],
  ): void {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }
}
```

- [ ] **Step 4: Export from index.ts**

Add to `packages/tessera/src/index.ts`:

```typescript
export { EventEmitter } from './event-emitter.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ucam-eo/tessera test`
Expected: PASS — all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/tessera/src/event-emitter.ts packages/tessera/src/__tests__/event-emitter.test.ts packages/tessera/src/index.ts
git commit -m "feat(tessera): add typed EventEmitter"
```

---

### Task 4: Move projection.ts to core package

**Files:**
- Move: `packages/maplibre-zarr-tessera/src/projection.ts` → `packages/tessera/src/projection.ts`
- Move: `packages/maplibre-zarr-tessera/src/__tests__/projection.test.ts` → `packages/tessera/src/__tests__/projection.test.ts`
- Modify: `packages/tessera/src/index.ts`

- [ ] **Step 1: Copy projection.ts to tessera package**

Copy `packages/maplibre-zarr-tessera/src/projection.ts` to `packages/tessera/src/projection.ts`. Update the import to use the new types path:

Change line 2:
```typescript
// Before:
import type { UtmBounds } from './types.js';
// After (same, since types.ts is now in tessera):
import type { UtmBounds } from './types.js';
```

Add TSDoc comments as defined in the spec (see `projection.ts` section in spec).

- [ ] **Step 2: Copy the existing projection test**

Copy `packages/maplibre-zarr-tessera/src/__tests__/projection.test.ts` to `packages/tessera/src/__tests__/projection.test.ts`. The import path stays the same (`'../projection.js'`).

- [ ] **Step 3: Export from index.ts**

Add to `packages/tessera/src/index.ts`:

```typescript
export { UtmProjection } from './projection.js';
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ucam-eo/tessera test`
Expected: PASS — all tests including 5 projection tests.

- [ ] **Step 5: Commit**

```bash
git add packages/tessera/src/projection.ts packages/tessera/src/__tests__/projection.test.ts packages/tessera/src/index.ts
git commit -m "feat(tessera): move UtmProjection to core package"
```

---

### Task 5: Move zarr-reader.ts to core package

**Files:**
- Copy: `packages/maplibre-zarr-tessera/src/zarr-reader.ts` → `packages/tessera/src/zarr-reader.ts`
- Modify: `packages/tessera/src/index.ts`

- [ ] **Step 1: Copy zarr-reader.ts**

Copy `packages/maplibre-zarr-tessera/src/zarr-reader.ts` to `packages/tessera/src/zarr-reader.ts`. Update the `StoreMetadata` import to use local types:

```typescript
import type { StoreMetadata } from './types.js';
```

Add TSDoc comments to `openStore` and `fetchRegion` as defined in the spec.

- [ ] **Step 2: Rename ZarrStore fields to match spec**

The current code uses abbreviated names (`meta`, `embArr`, `scalesArr`, `rgbArr`, `pcaArr`). Rename to spec names (`metadata`, `embeddings`, `scales`, `rgb`, `pcaRgb`) for consistency. Update all internal references.

- [ ] **Step 3: Export openStore and fetchRegion from index.ts**

These are marked `@internal` in TSDoc but exported for use by sibling packages (`maplibre-tessera` needs `openStore` internally). Add to `packages/tessera/src/index.ts`:

```typescript
// @internal — used by map plugins, not intended for public consumption
export { openStore, fetchRegion } from './zarr-reader.js';
```

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @ucam-eo/tessera build`
Expected: Build succeeds. zarr-reader compiles against zarrita.

- [ ] **Step 5: Commit**

```bash
git add packages/tessera/src/zarr-reader.ts packages/tessera/src/index.ts
git commit -m "feat(tessera): move zarr-reader to core package"
```

---

## Chunk 2: Core TesseraSource and SourceManager

### Task 6: Implement TesseraSource (data-only extraction from zarr-source.ts)

**Files:**
- Create: `packages/tessera/src/tessera-source.ts`
- Create: `packages/tessera/src/__tests__/tessera-source.test.ts`
- Modify: `packages/tessera/src/index.ts`

This is the largest task. Extract the data-access methods from `zarr-source.ts` (1764 lines) into a ~300-line class with no MapLibre dependency.

**Methods to extract from `packages/maplibre-zarr-tessera/src/zarr-source.ts`:**
- Store opening logic (currently in `addTo()`, lines ~100-140)
- Dequantization (lines 262-285)
- `loadChunkBatch` (line 522) → renamed `loadChunks`, returns `EmbeddingRegion`
- `getEmbeddingAt` (line 712)
- `getEmbeddingsInKernel` (line 744)
- `getChunksInRegion` (line 333)
- `getChunkAtLngLat` (line 309)
- `getChunkBoundsLngLat` (line 327)
- `getPixelBoundsLngLat` (line 784)
- `embeddingBoundsLngLat` (line 799)
- `regionHasTile` (line 633)
- `regionTileCount` (line 642)
- Event system (`on`/`off`/`emit`, lines 986-1007) → from `EventEmitter`
- New: `evictTile(ci, cj)` (extracted from viewer's `drawing.ts` lines 140-149)
- New: `clearRegion()` (extracted from viewer's `drawing.ts` line 153)

**Methods that stay in maplibre-tessera:**
- All layer management (`addTo`, `remove`, `updateVisibleChunks`, etc.)
- All overlay methods (`setSimilarityOverlay`, `addClassificationOverlay`, etc.)
- All animation methods (`startRegionAnimation`, etc.)
- Worker pool usage (`renderEmb`, `renderRgb`)
- `recolorAllChunks`, `raiseAllLayers`, `reAddAllLayers`
- `setBands`, `setOpacity`, `setPreview`

- [ ] **Step 1: Write failing unit test**

Create `packages/tessera/src/__tests__/tessera-source.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { TesseraSource } from '../tessera-source.js';
import type { TesseraOptions, EmbeddingRegion, ChunkRef } from '../types.js';

describe('TesseraSource', () => {
  it('constructs with options', () => {
    const source = new TesseraSource({
      url: 'https://example.com/store.zarr',
      concurrency: 2,
    });
    expect(source.metadata).toBeNull();
    expect(source.embeddingRegion).toBeNull();
    expect(source.tileCount).toBe(0);
  });

  it('regionHasTile returns false when no region loaded', () => {
    const source = new TesseraSource({ url: 'https://example.com/store.zarr' });
    expect(source.regionHasTile(0, 0)).toBe(false);
  });

  it('clearRegion sets embeddingRegion to null', () => {
    const source = new TesseraSource({ url: 'https://example.com/store.zarr' });
    source.clearRegion();
    expect(source.embeddingRegion).toBeNull();
  });

  it('emits events via EventEmitter', () => {
    const source = new TesseraSource({ url: 'https://example.com/store.zarr' });
    const cb = vi.fn();
    source.on('error', cb);
    // Trigger an error internally is hard to test without mocking zarr,
    // but we can verify the event system is wired up
    expect(() => source.off('error', cb)).not.toThrow();
  });
});
```

Note: Full integration tests (opening a real store, loading chunks) require a Zarr test fixture. For now, we test the constructor, property defaults, and synchronous methods. Integration tests can be added later with a mock HTTP server.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ucam-eo/tessera test`
Expected: FAIL — `../tessera-source.js` not found.

- [ ] **Step 3: Implement TesseraSource**

Create `packages/tessera/src/tessera-source.ts`. This extracts data-only logic from `packages/maplibre-zarr-tessera/src/zarr-source.ts`.

Key implementation notes:
- Extends `EventEmitter<TesseraEvents>`
- `open()` calls `openStore(url)` from `zarr-reader.ts`, stores metadata and creates `UtmProjection`
- `loadChunks()` adapts the current `loadChunkBatch()` (line 522 of zarr-source.ts):
  - Creates/grows `EmbeddingRegion`
  - Fetches embeddings and scales via `fetchRegion()`
  - Dequantizes inline (lines 262-285 of zarr-source.ts): `int8 * scale → float32`
  - Returns the `EmbeddingRegion`
- `getEmbeddingAt()`, `getEmbeddingsInKernel()`, `getChunksInRegion()`, `getChunkAtLngLat()` — copy logic directly from zarr-source.ts (lines 712-782, 309-370)
- `getChunkBoundsLngLat()`, `getPixelBoundsLngLat()`, `embeddingBoundsLngLat()` — copy from zarr-source.ts (lines 327, 784, 799)
- `evictTile(ci, cj)` — new method: zeros the tile's embedding data and sets `loaded[t] = 0`
- `clearRegion()` — new method: sets `embeddingRegion` to `null`
- `regionHasTile()`, `tileCount` — copy from zarr-source.ts (lines 633, 642)
- `close()` — sets an abort flag, nulls out store/region

See the spec's `tessera-source.ts` section for the complete class API with TSDoc.

- [ ] **Step 4: Export from index.ts**

Add to `packages/tessera/src/index.ts`:

```typescript
export { TesseraSource } from './tessera-source.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ucam-eo/tessera test`
Expected: PASS.

- [ ] **Step 6: Verify build**

Run: `pnpm --filter @ucam-eo/tessera build`
Expected: Build succeeds with no MapLibre imports.

- [ ] **Step 7: Commit**

```bash
git add packages/tessera/src/tessera-source.ts packages/tessera/src/__tests__/tessera-source.test.ts packages/tessera/src/index.ts
git commit -m "feat(tessera): add TesseraSource with data access and dequantisation"
```

---

### Task 7: Implement SourceManager in core

**Files:**
- Create: `packages/tessera/src/source-manager.ts`
- Create: `packages/tessera/src/__tests__/source-manager.test.ts`
- Modify: `packages/tessera/src/index.ts`

Extract geographic routing and multi-zone management from `packages/maplibre-zarr-tessera/src/source-manager.ts` (395 lines). Remove all MapLibre-specific code (addTo with map, broadcast display operations, animation routing).

**Methods to extract:**
- Constructor with `ZoneDescriptor[]` and `Omit<TesseraOptions, 'url'>`
- `getSource()` (line 103) — lazy opening, deduplication
- `getOpenSource()` (line 125)
- `getActiveSources()` (line 130)
- `zonesAtPoint()` (line 92), `zonesForPolygon()` (line 97) — with helper functions (lines 34-55)
- `getChunksInRegion()` (line 166) — **async**, opens zones lazily
- `getEmbeddingAt()` (line 181) — with `{ zoneId }` augmented return
- `getEmbeddingsInKernel()` (line 193)
- `getPixelBoundsLngLat()` (line 208)
- `getChunkAtLngLat()` (line 218)
- `getChunkBoundsLngLat()` (line 230)
- `getEmbeddingRegions()` (line 251)
- `regionHasTile()` (line 260)
- `totalTileCount()` (line 266)
- `embeddingBoundsLngLat()` (line 273) — preserving `[south, west, north, east]` order
- `getMetadata()` (line 359)
- `getZones()` (line 368)
- `close()` — closes all sources
- Event forwarding from child sources

**Methods that move to MaplibreTesseraManager:**
- `addTo(map)` (line 77)
- `setOpacity()`, `setBands()`, `setPreview()` (lines 290-303)
- `setClassificationOpacity()`, `raiseAllLayers()`, `reAddAllLayers()`, `recolorAllChunks()` (lines 306-319)
- `clearSimilarityOverlay()`, `clearClassificationOverlays()`, `clearRgbOverlay()` (lines 324-334)
- `startRegionAnimation()`, `updateRegionAnimation()`, `stopRegionAnimation()` (lines 338-354)
- `getClassificationAt()` (line 237) — display concern (uses per-tile classification maps)

- [ ] **Step 1: Write failing test**

Create `packages/tessera/src/__tests__/source-manager.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SourceManager } from '../source-manager.js';
import type { ZoneDescriptor } from '../types.js';

const testZones: ZoneDescriptor[] = [
  { id: '30N', bbox: [-6, 48, 0, 56], zarrUrl: 'https://example.com/30N.zarr' },
  { id: '31N', bbox: [0, 48, 6, 56], zarrUrl: 'https://example.com/31N.zarr' },
];

describe('SourceManager', () => {
  it('constructs with zones', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.getZones()).toHaveLength(2);
    expect(mgr.getActiveSources().size).toBe(0);
  });

  it('zonesAtPoint finds correct zone', () => {
    const mgr = new SourceManager(testZones);
    const zones = mgr.zonesAtPoint(-3, 52);
    expect(zones).toHaveLength(1);
    expect(zones[0].id).toBe('30N');
  });

  it('zonesAtPoint returns empty for point outside all zones', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.zonesAtPoint(20, 52)).toHaveLength(0);
  });

  it('zonesForPolygon finds overlapping zones', () => {
    const mgr = new SourceManager(testZones);
    const polygon: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[[-1, 50], [1, 50], [1, 52], [-1, 52], [-1, 50]]],
    };
    const zones = mgr.zonesForPolygon(polygon);
    expect(zones).toHaveLength(2); // Overlaps both zones
  });

  it('getOpenSource returns null for unopened zone', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.getOpenSource('30N')).toBeNull();
  });

  it('totalTileCount is 0 with no sources open', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.totalTileCount()).toBe(0);
  });

  it('embeddingBoundsLngLat returns null with no tiles', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.embeddingBoundsLngLat()).toBeNull();
  });

  it('getMetadata returns null with no sources open', () => {
    const mgr = new SourceManager(testZones);
    expect(mgr.getMetadata()).toBeNull();
  });

  it('close is safe to call with no sources', () => {
    const mgr = new SourceManager(testZones);
    expect(() => mgr.close()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ucam-eo/tessera test`
Expected: FAIL — `../source-manager.js` not found.

- [ ] **Step 3: Implement SourceManager**

Create `packages/tessera/src/source-manager.ts`. Port the data-only methods from `packages/maplibre-zarr-tessera/src/source-manager.ts`. Key differences:

- Extends `EventEmitter<TesseraEvents>` (not hand-rolled)
- No `map` field, no `addTo(map)` method
- `_openSource()` creates a `TesseraSource` and calls `source.open()` (not `source.addTo(map)`)
- Constructor takes `Omit<TesseraOptions, 'url'>` (no display options)
- `getClassificationAt` does NOT move here (it's display-specific)
- `close()` calls `source.close()` on all open sources

See the spec's `source-manager.ts` section for the complete API.

- [ ] **Step 4: Export from index.ts**

Add to `packages/tessera/src/index.ts`:

```typescript
export { SourceManager } from './source-manager.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ucam-eo/tessera test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/tessera/src/source-manager.ts packages/tessera/src/__tests__/source-manager.test.ts packages/tessera/src/index.ts
git commit -m "feat(tessera): add SourceManager with multi-zone routing"
```

---

### Task 8: Implement TesseraTileRenderer in core

**Files:**
- Create: `packages/tessera/src/tile-renderer.ts`
- Modify: `packages/tessera/src/index.ts`

Extract the rendering logic from `packages/maplibre-zarr-tessera/src/zarr-tile-protocol.ts` (200 lines). Everything except the `maplibregl.addProtocol()` call moves here.

**Logic to extract from zarr-tile-protocol.ts:**
- `openPyramid()` (lines 24-47) — pyramid level discovery
- `getOrOpenPyramid()` (lines 49-57) — caching
- `tileBounds()` (lines 59-69) — Web Mercator tile → WGS84 bounds
- `selectLevel()` (lines 71-83) — resolution selection
- Tile rendering loop (lines 143-188) — canvas creation, Mercator correction, pixel sampling
- PNG encoding via `canvas.toDataURL()` (line 183)

- [ ] **Step 1: Write tests for pure helper functions**

Create `packages/tessera/src/__tests__/tile-renderer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
// These helpers will be exported for testing
import { tileBounds, selectLevel } from '../tile-renderer.js';

describe('tileBounds', () => {
  it('computes correct bounds for tile 0/0/0', () => {
    const b = tileBounds(0, 0, 0);
    expect(b.west).toBeCloseTo(-180, 0);
    expect(b.south).toBeCloseTo(-85.05, 0);
    expect(b.east).toBeCloseTo(180, 0);
    expect(b.north).toBeCloseTo(85.05, 0);
  });

  it('computes correct bounds for tile 1/0/0', () => {
    const b = tileBounds(1, 0, 0);
    expect(b.west).toBeCloseTo(-180, 0);
    expect(b.east).toBeCloseTo(0, 0);
    expect(b.north).toBeCloseTo(85.05, 0);
  });
});

describe('selectLevel', () => {
  it('selects coarsest level with sufficient resolution', () => {
    const levels = [
      { path: '0', shape: [3, 100, 200] },   // coarsest
      { path: '1', shape: [3, 1000, 2000] },  // finer
    ];
    // At low zoom, the coarse level should suffice
    const idx = selectLevel(levels, 0);
    expect(idx).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ucam-eo/tessera test`
Expected: FAIL — `../tile-renderer.js` not found.

- [ ] **Step 3: Create tile-renderer.ts**

Create `packages/tessera/src/tile-renderer.ts`. Wrap the extracted logic into a `TesseraTileRenderer` class with the API from the spec:

```typescript
constructor(url: string, options?: TileRendererOptions)
renderTile(z: number, x: number, y: number): Promise<ArrayBuffer>
setVariable(variable: string): void
clearCache(): void
destroy(): void
```

Key implementation: `renderTile` is the body of the current protocol handler (lines 120-190 of zarr-tile-protocol.ts), refactored to return `ArrayBuffer` instead of calling a MapLibre callback.

Export `tileBounds` and `selectLevel` as named exports (not re-exported from index.ts) for testability.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @ucam-eo/tessera test`
Expected: PASS — tile-renderer helper tests pass.

- [ ] **Step 5: Export from index.ts**

Add to `packages/tessera/src/index.ts`:

```typescript
export { TesseraTileRenderer } from './tile-renderer.js';
```

- [ ] **Step 6: Verify build**

Run: `pnpm --filter @ucam-eo/tessera build`
Expected: Build succeeds. No MapLibre imports.

- [ ] **Step 7: Commit**

```bash
git add packages/tessera/src/tile-renderer.ts packages/tessera/src/__tests__/tile-renderer.test.ts packages/tessera/src/index.ts
git commit -m "feat(tessera): add TesseraTileRenderer for framework-agnostic tile rendering"
```

---

## Chunk 3: MapLibre Plugin Restructure

### Task 9: Rename and restructure maplibre-zarr-tessera → maplibre-tessera

**Files:**
- Rename: `packages/maplibre-zarr-tessera/` → `packages/maplibre-tessera/`
- Modify: `packages/maplibre-tessera/package.json` (name, deps)
- Create: `packages/maplibre-tessera/src/types.ts` (display-specific types)

- [ ] **Step 1: Rename the directory**

```bash
cd /Users/avsm/src/git/ucam-eo/tze
mv packages/maplibre-zarr-tessera packages/maplibre-tessera
```

- [ ] **Step 2: Update package.json**

In `packages/maplibre-tessera/package.json`:
- Change `"name"` from `"@ucam-eo/maplibre-zarr-tessera"` to `"@ucam-eo/maplibre-tessera"`
- Add `"@ucam-eo/tessera": "workspace:*"` to `dependencies`
- Remove `"proj4"` and `"zarrita"` from `dependencies` (they come via tessera)
- Remove `"@types/proj4"` from `devDependencies`

- [ ] **Step 3: Create display-specific types**

Create `packages/maplibre-tessera/src/types.ts` with `PreviewMode` and `MaplibreDisplayOptions` (moved from `types.ts` and `ZarrTesseraOptions`):

```typescript
export type PreviewMode = 'rgb' | 'pca' | 'bands';

export interface MaplibreDisplayOptions {
  bands?: [number, number, number];
  opacity?: number;
  preview?: PreviewMode;
  maxCached?: number;
  maxLoadPerUpdate?: number;
  globalPreviewUrl?: string;
  globalPreviewBounds?: [number, number, number, number];
}
```

- [ ] **Step 4: Update the existing types.ts**

In `packages/maplibre-tessera/src/types.ts`, remove all types that moved to `@ucam-eo/tessera`. Keep only:
- `CachedChunk` (MapLibre-specific, references `HTMLCanvasElement`)
- `PreviewMode`
- `MaplibreDisplayOptions` (new)

Add re-imports from `@ucam-eo/tessera` where needed internally.

- [ ] **Step 5: Install dependencies**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm install`
Expected: Workspace resolves `@ucam-eo/tessera` for maplibre-tessera.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: rename maplibre-zarr-tessera to maplibre-tessera, add tessera dependency"
```

---

### Task 10: Update maplibre-tessera source files to use core imports

**Files:**
- Modify: `packages/maplibre-tessera/src/zarr-source.ts`
- Modify: `packages/maplibre-tessera/src/source-manager.ts`
- Modify: `packages/maplibre-tessera/src/zarr-tile-protocol.ts`
- Modify: `packages/maplibre-tessera/src/projection.ts` (delete — now in tessera)
- Modify: `packages/maplibre-tessera/src/zarr-reader.ts` (delete — now in tessera)
- Modify: `packages/maplibre-tessera/src/index.ts`

This is a transitional step. The MapLibre files still contain the full logic but now import types and utilities from `@ucam-eo/tessera`.

- [ ] **Step 1: Delete files that moved to tessera**

```bash
rm packages/maplibre-tessera/src/projection.ts
rm packages/maplibre-tessera/src/zarr-reader.ts
rm -rf packages/maplibre-tessera/src/__tests__/projection.test.ts
```

- [ ] **Step 2: Update zarr-source.ts imports**

Replace internal imports with `@ucam-eo/tessera` imports:

```typescript
// Before:
import type { StoreMetadata, EmbeddingRegion, EmbeddingAt, ... } from './types.js';
import { UtmProjection } from './projection.js';
import { openStore, fetchRegion } from './zarr-reader.js';

// After:
import {
  UtmProjection, openStore, fetchRegion,
  type StoreMetadata, type EmbeddingRegion, type EmbeddingAt,
  type ChunkRef, type EmbeddingProgress, type DebugLogEntry,
  type TesseraEvents, type UtmBounds,
} from '@ucam-eo/tessera';
import type { PreviewMode, CachedChunk, MaplibreDisplayOptions } from './types.js';
```

Note: `openStore` and `fetchRegion` are exported from `@ucam-eo/tessera` index.ts (marked `@internal` in TSDoc, added in Task 5 Step 3).

- [ ] **Step 3: Update source-manager.ts imports**

```typescript
// Before:
import type { ZarrTesseraOptions, StoreMetadata, PreviewMode, ... } from './types.js';

// After:
import {
  type StoreMetadata, type EmbeddingRegion, type EmbeddingAt,
  type TesseraEvents, type DebugLogEntry,
} from '@ucam-eo/tessera';
import type { PreviewMode } from './types.js';
```

- [ ] **Step 4: Update zarr-tile-protocol.ts**

Replace the inline pyramid/rendering code with a call to `TesseraTileRenderer`:

```typescript
import { TesseraTileRenderer } from '@ucam-eo/tessera';

const renderers = new Map<string, TesseraTileRenderer>();

export function registerZarrProtocol(maplibregl: typeof import('maplibre-gl')): void {
  maplibregl.addProtocol('zarr', async (params, abortController) => {
    // Parse URL: zarr://STORE_URL/VARIABLE/{z}/{x}/{y}
    const url = params.url.replace('zarr://', '');
    const parts = url.split('/');
    const y = parseInt(parts.pop()!);
    const x = parseInt(parts.pop()!);
    const z = parseInt(parts.pop()!);
    const variable = parts.pop()!;
    const storeUrl = parts.join('/');

    const key = `${storeUrl}/${variable}`;
    if (!renderers.has(key)) {
      renderers.set(key, new TesseraTileRenderer(storeUrl, { variable }));
    }

    const data = await renderers.get(key)!.renderTile(z, x, y);
    return { data };
  });
}

export function clearZarrProtocolCache(): void {
  for (const renderer of renderers.values()) renderer.clearCache();
  renderers.clear();
}
```

- [ ] **Step 5: Update index.ts exports**

Update `packages/maplibre-tessera/src/index.ts`:

```typescript
export { ZarrTesseraSource } from './zarr-source.js';
export { ZarrSourceManager } from './source-manager.js';
export type { ZoneInfo, ManagedChunk } from './source-manager.js';
export { registerZarrProtocol, clearZarrProtocolCache } from './zarr-tile-protocol.js';
export type { PreviewMode, MaplibreDisplayOptions } from './types.js';

// Re-export core types for convenience during migration
export type {
  StoreMetadata, EmbeddingRegion, EmbeddingAt,
  EmbeddingProgress, DebugLogEntry, TesseraEvents,
} from '@ucam-eo/tessera';
```

Note: We keep the old class names (`ZarrTesseraSource`, `ZarrSourceManager`) for now. The rename to `MaplibreTesseraSource`/`MaplibreTesseraManager` happens in a later task after the viewer is migrated.

- [ ] **Step 6: Verify build**

Run: `pnpm --filter @ucam-eo/maplibre-tessera build`
Expected: Build succeeds.

- [ ] **Step 7: Run existing tests**

Run: `pnpm --filter @ucam-eo/maplibre-tessera test`
Expected: Tests pass (projection tests are now in tessera, so `--passWithNoTests` may be needed temporarily).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(maplibre-tessera): use @ucam-eo/tessera for types, projection, zarr-reader"
```

---

## Chunk 4: Consumer Migration

### Task 11: Update root workspace build order

**Files:**
- Modify: `package.json` (root)

This must happen before migrating consumers, as consumer builds depend on the root build script.

- [ ] **Step 1: Update build script**

In root `package.json`, update the build order:

```json
{
  "scripts": {
    "dev": "pnpm -F viewer dev",
    "build": "pnpm -F @ucam-eo/tessera build && pnpm -F @ucam-eo/maplibre-tessera build && pnpm -F @ucam-eo/tessera-tasks build && pnpm -F viewer build",
    "test": "pnpm -r test",
    "check": "pnpm -r check",
    "docs": "pnpm -r --filter './packages/*' run docs",
    "docs:html": "pnpm -r --filter './packages/*' run docs:html"
  }
}
```

- [ ] **Step 2: Verify full build**

Run: `pnpm build`
Expected: All packages build in order.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: update workspace build order for tessera split"
```

---

### Task 12: Update tessera-tasks to depend on @ucam-eo/tessera

**Files:**
- Modify: `packages/tessera-tasks/package.json`
- Modify: `packages/tessera-tasks/src/similarity.ts` (line 1)
- Modify: `packages/tessera-tasks/src/classify.ts` (line 3)
- Modify: `packages/tessera-tasks/src/segment.ts` (line 2)
- Modify: `packages/tessera-tasks/vite.config.ts` (line 16 — external)

- [ ] **Step 1: Update package.json**

In `packages/tessera-tasks/package.json`:
- Change `"@ucam-eo/maplibre-zarr-tessera": "workspace:*"` to `"@ucam-eo/tessera": "workspace:*"`

- [ ] **Step 2: Update imports**

In `similarity.ts` line 1:
```typescript
// Before:
import type { EmbeddingRegion } from '@ucam-eo/maplibre-zarr-tessera';
// After:
import type { EmbeddingRegion } from '@ucam-eo/tessera';
```

In `classify.ts` line 3:
```typescript
// Before:
import type { EmbeddingRegion } from '@ucam-eo/maplibre-zarr-tessera';
// After:
import type { EmbeddingRegion } from '@ucam-eo/tessera';
```

In `segment.ts` line 2:
```typescript
// Before:
import type { EmbeddingRegion, ZarrTesseraSource } from '@ucam-eo/maplibre-zarr-tessera';
// After:
import type { EmbeddingRegion } from '@ucam-eo/tessera';
import type { ZarrTesseraSource } from '@ucam-eo/maplibre-tessera';
```

Note: `segment.ts` imports `ZarrTesseraSource` as a type — this will eventually become `TesseraSource` from the core, but for now it stays as `ZarrTesseraSource` from the maplibre plugin to minimize churn.

- [ ] **Step 3: Update vite.config.ts external**

In `packages/tessera-tasks/vite.config.ts`, update the external list:
```typescript
// Before:
'@ucam-eo/maplibre-zarr-tessera',
// After:
'@ucam-eo/tessera',
'@ucam-eo/maplibre-tessera',
```

- [ ] **Step 4: Install and verify**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm install && pnpm --filter @ucam-eo/tessera-tasks build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/tessera-tasks/
git commit -m "refactor(tessera-tasks): depend on @ucam-eo/tessera for types"
```

---

### Task 13: Update the viewer to use new package names

**Files:**
- Modify: `apps/viewer/src/App.svelte` (line 4)
- Modify: `apps/viewer/src/stores/zarr.ts` (line 2)
- Modify: `apps/viewer/src/stores/stac.ts` (line 2)
- Modify: `apps/viewer/src/stores/classifier.ts` (line 2)
- Modify: `apps/viewer/src/lib/umap-subsample.ts` (line 1)
- Modify: `apps/viewer/src/lib/osm-sampler.ts` (lines 3, 5)
- Modify: `apps/viewer/src/lib/tutorial.ts` (lines 2, 5)
- Modify: `apps/viewer/src/components/DebugConsole.svelte` (line 3)
- Modify: `apps/viewer/src/components/OsmImport.svelte` (lines 126, 145 — inline type imports)
- Modify: `apps/viewer/vite.config.ts` (path alias)

This is an import-path-only migration. The API surface stays the same for now (the maplibre-tessera package re-exports core types). Full API migration (splitting data/display) is a separate future task.

- [ ] **Step 1: Update import paths in all viewer files**

For each file, change:
```typescript
// Before:
from '@ucam-eo/maplibre-zarr-tessera'
// After — types that exist in core:
from '@ucam-eo/tessera'       // StoreMetadata, EmbeddingRegion, EmbeddingAt, DebugLogEntry, EmbeddingProgress
// After — classes/functions from MapLibre plugin:
from '@ucam-eo/maplibre-tessera'  // ZarrSourceManager, ZarrTesseraSource, registerZarrProtocol, clearZarrProtocolCache
```

Specific changes per file:

**App.svelte (line 4):**
```typescript
import { registerZarrProtocol } from '@ucam-eo/maplibre-tessera';
```

**stores/zarr.ts (line 2):**
```typescript
import type { StoreMetadata } from '@ucam-eo/tessera';
import type { ZarrSourceManager } from '@ucam-eo/maplibre-tessera';
```

**stores/stac.ts (line 2):**
```typescript
import { ZarrSourceManager, clearZarrProtocolCache } from '@ucam-eo/maplibre-tessera';
```

**stores/classifier.ts (line 2):**
```typescript
import type { EmbeddingAt } from '@ucam-eo/tessera';
```

**lib/umap-subsample.ts (line 1):**
```typescript
import type { EmbeddingRegion } from '@ucam-eo/tessera';
```

**lib/osm-sampler.ts (lines 3, 5):**
```typescript
import type { EmbeddingAt } from '@ucam-eo/tessera';
import type { ZarrTesseraSource } from '@ucam-eo/maplibre-tessera';
```

**lib/tutorial.ts (lines 2, 5):**
```typescript
import type { StoreMetadata } from '@ucam-eo/tessera';
import type { ZarrSourceManager } from '@ucam-eo/maplibre-tessera';
```

**components/DebugConsole.svelte (line 3):**
```typescript
import type { DebugLogEntry } from '@ucam-eo/tessera';
```

**components/OsmImport.svelte (lines 126, 145):**
These use inline `import('...').EmbeddingAt` type imports. Update:
```typescript
// Before:
import('@ucam-eo/maplibre-zarr-tessera').EmbeddingAt
// After:
import('@ucam-eo/tessera').EmbeddingAt
```

- [ ] **Step 2: Update viewer vite.config.ts path alias**

The viewer's `vite.config.ts` likely has a path alias for the library. Update it:

```typescript
// Before:
'@ucam-eo/maplibre-zarr-tessera': path.resolve(__dirname, '../../packages/maplibre-zarr-tessera/src/index.ts'),
// After:
'@ucam-eo/tessera': path.resolve(__dirname, '../../packages/tessera/src/index.ts'),
'@ucam-eo/maplibre-tessera': path.resolve(__dirname, '../../packages/maplibre-tessera/src/index.ts'),
```

- [ ] **Step 3: Update viewer package.json dependencies**

```json
{
  "dependencies": {
    "@ucam-eo/tessera": "workspace:*",
    "@ucam-eo/maplibre-tessera": "workspace:*",
    "@ucam-eo/tessera-tasks": "workspace:*"
  }
}
```

Remove `"@ucam-eo/maplibre-zarr-tessera"`.

- [ ] **Step 4: Install and verify build**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm install && pnpm build`
Expected: Full build succeeds (tessera → maplibre-tessera → tessera-tasks → viewer).

- [ ] **Step 5: Run all tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(viewer): migrate imports to @ucam-eo/tessera and @ucam-eo/maplibre-tessera"
```

---

### Task 14: Update geotessera.org

**Files:**
- Modify: `/Users/avsm/src/git/ucam-eo/geotessera.org/package.json`
- Modify: `/Users/avsm/src/git/ucam-eo/geotessera.org/src/components/TileBackground.svelte` (line 3)
- Modify: `/Users/avsm/src/git/ucam-eo/geotessera.org/vite.config.ts`

- [ ] **Step 1: Update geotessera.org package.json**

```json
{
  "dependencies": {
    "@ucam-eo/tessera": "link:../tze/packages/tessera",
    "@ucam-eo/maplibre-tessera": "link:../tze/packages/maplibre-tessera"
  }
}
```

Remove `"@ucam-eo/maplibre-zarr-tessera"`. Both links are needed because geotessera.org uses file-system `link:` deps, and pnpm may not resolve transitive `workspace:*` deps from a linked package.

- [ ] **Step 2: Update TileBackground.svelte import**

Line 3:
```typescript
// Before:
import { registerZarrProtocol } from '@ucam-eo/maplibre-zarr-tessera';
// After:
import { registerZarrProtocol } from '@ucam-eo/maplibre-tessera';
```

- [ ] **Step 3: Update vite.config.ts alias**

```typescript
// Before:
'@ucam-eo/maplibre-zarr-tessera': path.resolve(__dirname, '../tze/packages/maplibre-zarr-tessera/src/index.ts'),
// After:
'@ucam-eo/maplibre-tessera': path.resolve(__dirname, '../tze/packages/maplibre-tessera/src/index.ts'),
```

- [ ] **Step 4: Install and verify**

Run: `cd /Users/avsm/src/git/ucam-eo/geotessera.org && pnpm install && pnpm build`
Expected: Build succeeds.

- [ ] **Step 5: Commit (in geotessera.org repo)**

```bash
cd /Users/avsm/src/git/ucam-eo/geotessera.org
git add -A
git commit -m "refactor: migrate to @ucam-eo/maplibre-tessera"
```

---

## Chunk 5: Composition Wrapper Classes

This chunk implements the spec's core architectural goal: `MaplibreTesseraSource` wraps `TesseraSource` via composition, and `MaplibreTesseraManager` wraps `SourceManager`. After this chunk, consumers access `.source` / `.manager` for data and the wrapper for display.

### Task 15: Implement MaplibreTesseraSource (composition wrapper)

**Files:**
- Create: `packages/maplibre-tessera/src/maplibre-source.ts`
- Modify: `packages/maplibre-tessera/src/index.ts`

This wraps `TesseraSource` and delegates all display logic (layers, overlays, animations, viewport, workers) to the existing `ZarrTesseraSource` code. The refactoring is:

1. Rename current `ZarrTesseraSource` to `MaplibreTesseraSource`
2. Change the constructor to accept an already-opened `TesseraSource`
3. Remove all data methods (they live on `.source` now)
4. Keep all display methods

- [ ] **Step 1: Create maplibre-source.ts**

Refactor `packages/maplibre-tessera/src/zarr-source.ts` into `maplibre-source.ts`:

- Constructor takes `(source: TesseraSource, options: MaplibreDisplayOptions)` instead of `(options: ZarrTesseraOptions)`
- Store `source` as `readonly source: TesseraSource`
- `addTo(map)` no longer opens the store — it uses `this.source.metadata` and `this.source.projection` directly
- Remove data methods: `getEmbeddingAt`, `getEmbeddingsInKernel`, `getChunksInRegion`, `getChunkAtLngLat`, `getChunkBoundsLngLat`, `getPixelBoundsLngLat`, `embeddingBoundsLngLat`, `regionHasTile`, `regionTileCount`, `loadChunkBatch`
- Remove `embeddingRegion` property (access via `this.source.embeddingRegion`)
- Remove the event system (`on`/`off`/`emit`) — events come from `this.source`
- Keep: all overlay methods, animation methods, layer management, worker pool, `setBands`, `setOpacity`, `setPreview`, `recolorAllChunks`, `raiseAllLayers`, `reAddAllLayers`
- For display rendering that reads embeddings (e.g. `recolorAllChunks` at line 412), access `this.source.embeddingRegion`
- Keep the old `ZarrTesseraSource` class as a deprecated re-export for backward compat during transition

- [ ] **Step 2: Update index.ts**

```typescript
export { MaplibreTesseraSource } from './maplibre-source.js';
// Deprecated — use MaplibreTesseraSource
export { ZarrTesseraSource } from './zarr-source.js';
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @ucam-eo/maplibre-tessera build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/maplibre-tessera/src/maplibre-source.ts packages/maplibre-tessera/src/index.ts
git commit -m "feat(maplibre-tessera): add MaplibreTesseraSource composition wrapper"
```

---

### Task 16: Implement MaplibreTesseraManager (composition wrapper)

**Files:**
- Create: `packages/maplibre-tessera/src/maplibre-manager.ts`
- Modify: `packages/maplibre-tessera/src/index.ts`

- [ ] **Step 1: Create maplibre-manager.ts**

Wraps `SourceManager` with display concerns:

- Constructor takes `(manager: SourceManager, options?: MaplibreDisplayOptions)`
- Store `manager` as `readonly manager: SourceManager`
- `addTo(map)` stores the map reference (needed for creating display sources)
- Listen for `'metadata-loaded'` on the manager to auto-wrap new `TesseraSource` instances into `MaplibreTesseraSource` display wrappers
- Maintains internal `Map<string, MaplibreTesseraSource>` for display sources
- `getDisplaySource(zoneId)` returns the display wrapper for a zone
- Broadcast methods (`setOpacity`, `setBands`, `setPreview`, etc.) iterate display sources
- Animation routing delegates to the correct display source
- `remove()` removes all display sources and calls `manager.close()`

See the spec's `maplibre-manager.ts` section for the full API.

- [ ] **Step 2: Update index.ts**

```typescript
export { MaplibreTesseraManager } from './maplibre-manager.js';
// Deprecated — use MaplibreTesseraManager
export { ZarrSourceManager } from './source-manager.js';
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @ucam-eo/maplibre-tessera build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/maplibre-tessera/src/maplibre-manager.ts packages/maplibre-tessera/src/index.ts
git commit -m "feat(maplibre-tessera): add MaplibreTesseraManager composition wrapper"
```

---

## Chunk 6: Validation Plugins

### Task 17: Create leaflet-tessera plugin

**Files:**
- Create: `packages/leaflet-tessera/package.json`
- Create: `packages/leaflet-tessera/tsconfig.json`
- Create: `packages/leaflet-tessera/vite.config.ts`
- Create: `packages/leaflet-tessera/src/index.ts`
- Create: `packages/leaflet-tessera/src/tessera-tile-layer.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@ucam-eo/leaflet-tessera",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "scripts": {
    "build": "vite build && tsc --emitDeclarationOnly",
    "check": "tsc --noEmit"
  },
  "dependencies": {
    "@ucam-eo/tessera": "workspace:*"
  },
  "peerDependencies": {
    "leaflet": ">=1.9.0"
  },
  "devDependencies": {
    "@types/leaflet": "^1.9.0",
    "leaflet": "^1.9.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: './src/index.ts',
      name: 'LeafletTessera',
      formats: ['es', 'cjs'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['leaflet', '@ucam-eo/tessera'],
    },
  },
});
```

- [ ] **Step 4: Create tessera-tile-layer.ts**

Implement as defined in the spec. See spec section "Leaflet Plugin: tessera-tile-layer.ts".

```typescript
import * as L from 'leaflet';
import { TesseraTileRenderer } from '@ucam-eo/tessera';

export class TesseraTileLayer extends L.TileLayer {
  private renderer: TesseraTileRenderer;

  constructor(
    url: string,
    options?: L.TileLayerOptions & { variable?: string },
  ) {
    super('', options);  // Empty URL template — we override createTile
    this.renderer = new TesseraTileRenderer(url, {
      variable: options?.variable ?? 'rgb',
    });
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLImageElement {
    const img = document.createElement('img');
    this.renderer
      .renderTile(coords.z, coords.x, coords.y)
      .then((data) => {
        const blob = new Blob([data], { type: 'image/png' });
        img.src = URL.createObjectURL(blob);
        done(undefined, img);
      })
      .catch((err) => {
        done(err, img);
      });
    return img;
  }

  setVariable(variable: string): void {
    this.renderer.setVariable(variable);
    this.redraw();
  }
}
```

- [ ] **Step 5: Create index.ts**

```typescript
export { TesseraTileLayer } from './tessera-tile-layer.js';
```

- [ ] **Step 6: Verify build**

Run: `pnpm install && pnpm --filter @ucam-eo/leaflet-tessera build`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/leaflet-tessera/
git commit -m "feat: add @ucam-eo/leaflet-tessera plugin"
```

---

### Task 18: Create openlayers-tessera plugin

**Files:**
- Create: `packages/openlayers-tessera/package.json`
- Create: `packages/openlayers-tessera/tsconfig.json`
- Create: `packages/openlayers-tessera/vite.config.ts`
- Create: `packages/openlayers-tessera/src/index.ts`
- Create: `packages/openlayers-tessera/src/tessera-tile-source.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@ucam-eo/openlayers-tessera",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "scripts": {
    "build": "vite build && tsc --emitDeclarationOnly",
    "check": "tsc --noEmit"
  },
  "dependencies": {
    "@ucam-eo/tessera": "workspace:*"
  },
  "peerDependencies": {
    "ol": ">=9.0.0"
  },
  "devDependencies": {
    "ol": "^10.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: './src/index.ts',
      name: 'OpenLayersTessera',
      formats: ['es', 'cjs'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['ol', 'ol/source/XYZ', 'ol/Tile', '@ucam-eo/tessera'],
    },
  },
});
```

- [ ] **Step 4: Create tessera-tile-source.ts**

Implement as defined in the spec. See spec section "OpenLayers Plugin: tessera-tile-source.ts".

```typescript
import XYZ from 'ol/source/XYZ';
import type { Options as XYZOptions } from 'ol/source/XYZ';
import { TesseraTileRenderer } from '@ucam-eo/tessera';

export class TesseraTileSource extends XYZ {
  private renderer: TesseraTileRenderer;

  constructor(
    options: XYZOptions & { url: string; variable?: string },
  ) {
    super({
      ...options,
      url: undefined,  // We provide tiles via tileLoadFunction
    });
    this.renderer = new TesseraTileRenderer(options.url, {
      variable: options.variable ?? 'rgb',
    });

    this.setTileLoadFunction((tile, _src) => {
      const imageTile = tile as import('ol/Tile').default & { getImage: () => HTMLImageElement };
      const img = imageTile.getImage() as HTMLImageElement;
      const coord = tile.getTileCoord();
      const [z, x, y] = coord;

      this.renderer
        .renderTile(z, x, y)
        .then((data) => {
          const blob = new Blob([data], { type: 'image/png' });
          img.src = URL.createObjectURL(blob);
        })
        .catch(() => {
          // Tile load error — OpenLayers handles this
        });
    });
  }

  setVariable(variable: string): void {
    this.renderer.setVariable(variable);
    this.refresh();
  }
}
```

- [ ] **Step 5: Create index.ts**

```typescript
export { TesseraTileSource } from './tessera-tile-source.js';
```

- [ ] **Step 6: Verify build**

Run: `pnpm install && pnpm --filter @ucam-eo/openlayers-tessera build`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/openlayers-tessera/
git commit -m "feat: add @ucam-eo/openlayers-tessera plugin"
```

---

## Chunk 7: Final Verification and Documentation

### Task 19: TypeDoc setup and generation

**Files:**
- Modify: `packages/tessera/typedoc.json` (already created)
- Create: `packages/maplibre-tessera/typedoc.json`
- Modify: root `package.json` (docs scripts already added in Task 13)

- [ ] **Step 1: Add typedoc to maplibre-tessera**

Add `typedoc` and `typedoc-plugin-markdown` to `packages/maplibre-tessera/package.json` devDependencies. Create `packages/maplibre-tessera/typedoc.json`:

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

Add scripts to `packages/maplibre-tessera/package.json`:
```json
"docs": "typedoc --plugin typedoc-plugin-markdown",
"docs:html": "typedoc --plugin none"
```

- [ ] **Step 2: Generate docs**

Run: `pnpm install && pnpm docs:html`
Expected: HTML docs generated in `docs/api/tessera/` and `docs/api/maplibre-tessera/`.

- [ ] **Step 3: Verify docs render**

Run: `open docs/api/tessera/index.html`
Expected: Browsable API documentation with TSDoc descriptions.

- [ ] **Step 4: Commit**

```bash
git add packages/maplibre-tessera/typedoc.json docs/api/
git commit -m "docs: add TypeDoc configuration and generated API docs"
```

---

### Task 20: Full integration verification

- [ ] **Step 1: Clean install**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && rm -rf node_modules packages/*/node_modules apps/*/node_modules && pnpm install`
Expected: Clean install succeeds.

- [ ] **Step 2: Full build**

Run: `pnpm build`
Expected: All packages build in order: tessera → maplibre-tessera → tessera-tasks → viewer.

- [ ] **Step 3: Type check**

Run: `pnpm check`
Expected: No TypeScript errors across any package.

- [ ] **Step 4: Tests**

Run: `pnpm test`
Expected: All tests pass (tessera unit tests + any remaining maplibre-tessera tests).

- [ ] **Step 5: Dev server**

Run: `pnpm dev`
Expected: Viewer starts, map loads, zarr:// tiles render, embedding loading works.

- [ ] **Step 6: Verify geotessera.org**

Run: `cd /Users/avsm/src/git/ucam-eo/geotessera.org && pnpm install && pnpm build`
Expected: Build succeeds.

- [ ] **Step 7: Final commit**

```bash
cd /Users/avsm/src/git/ucam-eo/tze
git add -A
git commit -m "chore: verify full integration after tessera library split"
```
