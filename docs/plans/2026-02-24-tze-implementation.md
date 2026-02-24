# TZE Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a standalone Zarr embedding viewer as a pnpm monorepo with an npm-publishable MapLibre plugin and a Svelte 5 static site.

**Architecture:** Monorepo with `packages/maplibre-zarr-tessera` (library: zarr reading, UTM projection, Web Worker rendering, MapLibre integration) and `apps/viewer` (Svelte 5 app consuming the plugin). Built with Vite, styled with Tailwind CSS 4.

**Tech Stack:** TypeScript, Svelte 5, MapLibre GL JS, zarrita.js, proj4, Vite, pnpm workspaces, vitest

**Reference:** The existing viewer is at `~/src/git/ucam-eo/geotessera/geotessera/viewer/index.html` (~1300 lines of inline JS). Port logic from there, restructured into typed modules.

---

### Task 1: Scaffold monorepo

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `tsconfig.base.json`

**Step 1: Create root package.json**

```json
{
  "name": "tze",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "pnpm -F viewer dev",
    "build": "pnpm -F @ucam-eo/maplibre-zarr-tessera build && pnpm -F viewer build",
    "test": "pnpm -r test",
    "check": "pnpm -r check"
  },
  "engines": {
    "node": ">=20"
  }
}
```

**Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

**Step 3: Create .gitignore**

```
node_modules/
dist/
.vite/
*.tsbuildinfo
.svelte-kit/
```

**Step 4: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

**Step 5: Install pnpm and initialize**

Run: `cd ~/src/git/ucam-eo/tze && pnpm install`
Expected: lockfile created, no errors

**Step 6: Commit**

```bash
git add -A && git commit -m "scaffold: monorepo root with pnpm workspaces"
```

---

### Task 2: Scaffold plugin package

**Files:**
- Create: `packages/maplibre-zarr-tessera/package.json`
- Create: `packages/maplibre-zarr-tessera/tsconfig.json`
- Create: `packages/maplibre-zarr-tessera/vite.config.ts`
- Create: `packages/maplibre-zarr-tessera/src/index.ts`
- Create: `packages/maplibre-zarr-tessera/src/types.ts`

**Step 1: Create plugin package.json**

```json
{
  "name": "@ucam-eo/maplibre-zarr-tessera",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "vite build && tsc --emitDeclarationOnly",
    "test": "vitest run",
    "check": "tsc --noEmit"
  },
  "peerDependencies": {
    "maplibre-gl": ">=4.0.0"
  },
  "dependencies": {
    "zarrita": "^0.6.1",
    "proj4": "^2.12.1"
  },
  "devDependencies": {
    "maplibre-gl": "^4.7.1",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0",
    "@types/proj4": "^2.5.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"]
  },
  "include": ["src"]
}
```

**Step 3: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: './src/index.ts',
      name: 'MaplibreZarrTessera',
      formats: ['es', 'cjs'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['maplibre-gl'],
    },
  },
});
```

**Step 4: Create src/types.ts**

This file defines all shared types used across the plugin. Port the store state shape from the existing viewer's `store` object.

```typescript
import type { Map as MaplibreMap } from 'maplibre-gl';

export interface ZarrTesseraOptions {
  url: string;
  bands?: [number, number, number];
  opacity?: number;
  preview?: 'rgb' | 'pca' | 'bands';
  maxCached?: number;
  maxLoadPerUpdate?: number;
  concurrency?: number;
  gridVisible?: boolean;
  utmBoundaryVisible?: boolean;
}

export interface StoreMetadata {
  url: string;
  utmZone: number;
  epsg: number;
  transform: [number, number, number, number, number, number];
  shape: [number, number, number];
  chunkShape: [number, number, number];
  nBands: number;
  hasRgb: boolean;
  hasPca: boolean;
  pcaExplainedVariance?: number[];
}

export interface ChunkBounds {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export interface UtmBounds {
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
}

export interface CachedChunk {
  ci: number;
  cj: number;
  embRaw: Uint8Array | null;
  scalesRaw: Uint8Array | null;
  canvas: HTMLCanvasElement | null;
  sourceId: string | null;
  layerId: string | null;
  isPreview: boolean;
}

export type PreviewMode = 'rgb' | 'pca' | 'bands';

export interface ZarrTesseraEvents {
  'metadata-loaded': StoreMetadata;
  'chunk-loaded': { ci: number; cj: number };
  'error': Error;
  'loading': { total: number; done: number };
}
```

**Step 5: Create src/index.ts (stub)**

```typescript
export { ZarrTesseraSource } from './zarr-source.js';
export type {
  ZarrTesseraOptions,
  StoreMetadata,
  PreviewMode,
  ZarrTesseraEvents,
} from './types.js';
```

**Step 6: Install deps and verify**

Run: `cd ~/src/git/ucam-eo/tze && pnpm install`
Run: `cd packages/maplibre-zarr-tessera && pnpm check` (will fail — zarr-source.ts doesn't exist yet, expected)

**Step 7: Commit**

```bash
git add -A && git commit -m "scaffold: plugin package with types and build config"
```

---

### Task 3: Implement projection module

Port UTM projection logic from the existing viewer's `setupProjection`, `utmToLngLat`, `projForward` functions.

**Files:**
- Create: `packages/maplibre-zarr-tessera/src/projection.ts`
- Create: `packages/maplibre-zarr-tessera/src/__tests__/projection.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { UtmProjection } from '../projection.js';

describe('UtmProjection', () => {
  it('creates projection for northern hemisphere UTM zone', () => {
    const proj = new UtmProjection(32630); // Zone 30N
    expect(proj.zone).toBe(30);
    expect(proj.isSouth).toBe(false);
  });

  it('creates projection for southern hemisphere UTM zone', () => {
    const proj = new UtmProjection(32730); // Zone 30S
    expect(proj.zone).toBe(30);
    expect(proj.isSouth).toBe(true);
  });

  it('converts WGS84 to UTM and back (round-trip)', () => {
    const proj = new UtmProjection(32630);
    const [e, n] = proj.forward(-0.5, 51.5); // London area
    const [lng, lat] = proj.inverse(e, n);
    expect(lng).toBeCloseTo(-0.5, 4);
    expect(lat).toBeCloseTo(51.5, 4);
  });

  it('computes chunk LngLat corners from pixel bounds', () => {
    const proj = new UtmProjection(32630);
    // Origin at (500000, 6000000), pixel size 10m, chunk at (0,0) size 1024x1024
    const transform: [number, number, number, number, number, number] = [10, 0, 500000, 0, -10, 6000000];
    const corners = proj.chunkCornersToLngLat(
      { minE: 500000, maxE: 510240, minN: 5989760, maxN: 6000000 }
    );
    // Should return [TL, TR, BR, BL] as [lng, lat] pairs
    expect(corners).toHaveLength(4);
    for (const [lng, lat] of corners) {
      expect(lng).toBeGreaterThan(-10);
      expect(lng).toBeLessThan(10);
      expect(lat).toBeGreaterThan(50);
      expect(lat).toBeLessThan(60);
    }
  });

  it('caches transformer per EPSG', () => {
    const proj1 = new UtmProjection(32630);
    const proj2 = new UtmProjection(32630);
    // Both should produce identical results
    const [e1, n1] = proj1.forward(0, 51);
    const [e2, n2] = proj2.forward(0, 51);
    expect(e1).toBe(e2);
    expect(n1).toBe(n2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/src/git/ucam-eo/tze/packages/maplibre-zarr-tessera && pnpm test`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
import proj4 from 'proj4';
import type { UtmBounds } from './types.js';

export class UtmProjection {
  readonly zone: number;
  readonly epsg: number;
  readonly isSouth: boolean;
  private proj: proj4.Converter;

  constructor(epsg: number) {
    this.epsg = epsg;
    this.isSouth = epsg >= 32700 && epsg <= 32760;
    this.zone = this.isSouth ? epsg - 32700 : epsg - 32600;

    const def = `+proj=utm +zone=${this.zone}${this.isSouth ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
    this.proj = proj4('EPSG:4326', def);
  }

  /** WGS84 (lng, lat) -> UTM (easting, northing) */
  forward(lng: number, lat: number): [number, number] {
    const [e, n] = this.proj.forward([lng, lat]);
    return [e, n];
  }

  /** UTM (easting, northing) -> WGS84 (lng, lat) */
  inverse(easting: number, northing: number): [number, number] {
    const [lng, lat] = this.proj.inverse([easting, northing]);
    return [lng, lat];
  }

  /** Convert UTM bounds to [TL, TR, BR, BL] as [lng, lat] for MapLibre image source */
  chunkCornersToLngLat(b: UtmBounds): [[number, number], [number, number], [number, number], [number, number]] {
    const tl = this.inverse(b.minE, b.maxN);
    const tr = this.inverse(b.maxE, b.maxN);
    const br = this.inverse(b.maxE, b.minN);
    const bl = this.inverse(b.minE, b.minN);
    return [tl, tr, br, bl];
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(plugin): add UTM projection module with tests"
```

---

### Task 4: Implement render worker

Port the Web Worker rendering logic from the existing viewer's `workerCode` string. The worker handles two message types: `render-emb` (band selection from raw embeddings) and `render-rgb` (pass-through RGBA from preview arrays).

**Files:**
- Create: `packages/maplibre-zarr-tessera/src/render-worker.ts`
- Create: `packages/maplibre-zarr-tessera/src/worker-pool.ts`

**Step 1: Create render-worker.ts**

This is the worker code that will be inlined as a blob URL. Port from the existing `workerCode` template string, but as proper TypeScript.

```typescript
/** Inline Web Worker code for rendering band data to RGBA.
 *  Bundled as a blob URL at runtime — keep self-contained with no imports.
 */

export const WORKER_CODE = `
self.onmessage = function(e) {
  const msg = e.data;

  if (msg.type === 'render-rgb') {
    const { rgbData, width, height, id } = msg;
    const src = new Uint8Array(rgbData);
    const rgba = new Uint8Array(width * height * 4);
    let nValid = 0;
    for (let i = 0; i < width * height; i++) {
      const si = i * 4;
      rgba[si]     = src[si];
      rgba[si + 1] = src[si + 1];
      rgba[si + 2] = src[si + 2];
      rgba[si + 3] = src[si + 3];
      if (src[si + 3] > 0) nValid++;
    }
    self.postMessage(
      { type: 'rgb-result', id, rgba: rgba.buffer, width, height, nValid },
      [rgba.buffer]
    );
    return;
  }

  if (msg.type === 'render-emb') {
    const { embRaw, scalesRaw, width, height, nBands, bands, id } = msg;
    const embInt8 = new Int8Array(embRaw);
    const scalesBuf = new ArrayBuffer(new Uint8Array(scalesRaw).byteLength);
    new Uint8Array(scalesBuf).set(new Uint8Array(scalesRaw));
    const scalesF32 = new Float32Array(scalesBuf);

    const [bR, bG, bB] = bands;
    let minR = 127, maxR = -128, minG = 127, maxG = -128, minB = 127, maxB = -128;
    let nValid = 0;

    for (let i = 0; i < width * height; i++) {
      if (isNaN(scalesF32[i]) || scalesF32[i] === 0) continue;
      const base = i * nBands;
      const vr = embInt8[base + bR];
      const vg = embInt8[base + bG];
      const vb = embInt8[base + bB];
      if (vr < minR) minR = vr; if (vr > maxR) maxR = vr;
      if (vg < minG) minG = vg; if (vg > maxG) maxG = vg;
      if (vb < minB) minB = vb; if (vb > maxB) maxB = vb;
      nValid++;
    }

    const rgba = new Uint8Array(width * height * 4);
    if (nValid === 0 || (maxR === minR && maxG === minG && maxB === minB)) {
      self.postMessage(
        { type: 'emb-result', id, rgba: rgba.buffer, width, height, nValid: 0,
          embRaw: embRaw, scalesRaw: scalesRaw },
        [rgba.buffer]
      );
      return;
    }

    const rangeR = maxR - minR || 1;
    const rangeG = maxG - minG || 1;
    const rangeB = maxB - minB || 1;

    for (let i = 0; i < width * height; i++) {
      const pi = i * 4;
      const scale = scalesF32[i];
      if (isNaN(scale) || scale === 0) { rgba[pi + 3] = 0; continue; }
      const base = i * nBands;
      rgba[pi]     = Math.max(0, Math.min(255, ((embInt8[base + bR] - minR) / rangeR) * 255));
      rgba[pi + 1] = Math.max(0, Math.min(255, ((embInt8[base + bG] - minG) / rangeG) * 255));
      rgba[pi + 2] = Math.max(0, Math.min(255, ((embInt8[base + bB] - minB) / rangeB) * 255));
      rgba[pi + 3] = 255;
    }
    self.postMessage(
      { type: 'emb-result', id, rgba: rgba.buffer, width, height, nValid,
        embRaw: embRaw, scalesRaw: scalesRaw },
      [rgba.buffer]
    );
  }
};
`;
```

**Step 2: Create worker-pool.ts**

Port the `WorkerPool` class from the existing viewer.

```typescript
import { WORKER_CODE } from './render-worker.js';

export interface WorkerMessage {
  type: string;
  id?: number;
  [key: string]: unknown;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: number[] = [];
  private queue: Array<{
    msg: WorkerMessage;
    transfers: Transferable[];
    resolve: (value: WorkerMessage) => void;
  }> = [];
  private resolvers = new Map<number, { resolve: (value: WorkerMessage) => void }>();
  private nextId = 0;

  constructor(size: number) {
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    for (let i = 0; i < size; i++) {
      const w = new Worker(url);
      w.onmessage = (e) => this.onMessage(i, e);
      this.workers.push(w);
      this.idle.push(i);
    }
  }

  private onMessage(workerIdx: number, e: MessageEvent): void {
    const msg = e.data as WorkerMessage;
    const resolver = this.resolvers.get(msg.id!);
    if (resolver) {
      this.resolvers.delete(msg.id!);
      resolver.resolve(msg);
    }
    this.idle.push(workerIdx);
    this.drain();
  }

  private drain(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const workerIdx = this.idle.shift()!;
      const { msg, transfers, resolve } = this.queue.shift()!;
      const id = this.nextId++;
      msg.id = id;
      this.resolvers.set(id, { resolve });
      this.workers[workerIdx].postMessage(msg, transfers);
    }
  }

  dispatch(msg: WorkerMessage, transfers: Transferable[] = []): Promise<WorkerMessage> {
    return new Promise((resolve) => {
      if (this.idle.length > 0) {
        const workerIdx = this.idle.shift()!;
        const id = this.nextId++;
        msg.id = id;
        this.resolvers.set(id, { resolve });
        this.workers[workerIdx].postMessage(msg, transfers);
      } else {
        this.queue.push({ msg, transfers, resolve });
      }
    });
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.resolvers.clear();
  }
}
```

**Step 3: Commit**

```bash
git add -A && git commit -m "feat(plugin): add render worker and worker pool"
```

---

### Task 5: Implement Zarr reader

Port store-loading logic from the existing viewer's `doLoadStore` function. Wraps zarrita.js for opening stores and reading chunk regions.

**Files:**
- Create: `packages/maplibre-zarr-tessera/src/zarr-reader.ts`

**Step 1: Implement zarr-reader.ts**

```typescript
import * as zarr from 'zarrita';
import type { StoreMetadata } from './types.js';

export interface ZarrStore {
  meta: StoreMetadata;
  embArr: zarr.Array<zarr.DataType>;
  scalesArr: zarr.Array<zarr.DataType>;
  rgbArr: zarr.Array<zarr.DataType> | null;
  pcaArr: zarr.Array<zarr.DataType> | null;
  chunkManifest: Set<string> | null;
}

/**
 * Open a Zarr v3 Tessera embedding store over HTTP.
 * Reads group metadata and opens embeddings, scales, and optional preview arrays.
 */
export async function openStore(url: string): Promise<ZarrStore> {
  const fetchStore = new zarr.FetchStore(url);
  const rootLoc = zarr.root(fetchStore);
  const group = await zarr.open(rootLoc, { kind: 'group' });
  const attrs = group.attrs as Record<string, unknown>;

  const embArr = await zarr.open(rootLoc.resolve('embeddings'), { kind: 'array' });
  const scalesArr = await zarr.open(rootLoc.resolve('scales'), { kind: 'array' });

  const utmZone = attrs.utm_zone as number;
  const epsg = attrs.crs_epsg as number;
  const transform = attrs.transform as [number, number, number, number, number, number];

  if (!utmZone || !transform || !embArr.shape) {
    throw new Error('Missing required store metadata (utm_zone, transform, shape)');
  }

  // Try optional preview arrays
  let rgbArr: zarr.Array<zarr.DataType> | null = null;
  let pcaArr: zarr.Array<zarr.DataType> | null = null;
  let hasRgb = false;
  let hasPca = false;

  try {
    rgbArr = await zarr.open(rootLoc.resolve('rgb'), { kind: 'array' });
    hasRgb = true;
  } catch { /* no rgb preview */ }

  try {
    pcaArr = await zarr.open(rootLoc.resolve('pca_rgb'), { kind: 'array' });
    hasPca = true;
  } catch { /* no pca preview */ }

  // Try chunk manifest
  let chunkManifest: Set<string> | null = null;
  try {
    const resp = await fetch(`${url}/_chunk_manifest.json`);
    if (resp.ok) {
      const data = await resp.json();
      if (data?.chunks) {
        chunkManifest = new Set(
          (data.chunks as [number, number][]).map(([ci, cj]) => `${ci}_${cj}`)
        );
      }
      if (data?.has_rgb !== undefined) hasRgb = data.has_rgb;
      if (data?.has_pca_rgb !== undefined) hasPca = data.has_pca_rgb;

      // Re-open arrays if manifest says they exist but we didn't find them
      if (hasRgb && !rgbArr) {
        try { rgbArr = await zarr.open(rootLoc.resolve('rgb'), { kind: 'array' }); } catch { hasRgb = false; }
      }
      if (hasPca && !pcaArr) {
        try { pcaArr = await zarr.open(rootLoc.resolve('pca_rgb'), { kind: 'array' }); } catch { hasPca = false; }
      }
    }
  } catch { /* no manifest */ }

  const meta: StoreMetadata = {
    url,
    utmZone,
    epsg,
    transform,
    shape: embArr.shape as [number, number, number],
    chunkShape: embArr.chunks as [number, number, number],
    nBands: (embArr.shape[2] as number) || 128,
    hasRgb,
    hasPca,
    pcaExplainedVariance: attrs.pca_explained_variance as number[] | undefined,
  };

  return { meta, embArr, scalesArr, rgbArr, pcaArr, chunkManifest };
}

/** Fetch a typed-array region from a zarr array using zarrita slicing. */
export async function fetchRegion(
  arr: zarr.Array<zarr.DataType>,
  slices: (null | [number, number])[],
): Promise<{ data: ArrayBufferView; shape: number[] }> {
  const sel = slices.map(s =>
    s === null ? null : zarr.slice(s[0], s[1])
  );
  return await zarr.get(arr, sel);
}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat(plugin): add Zarr store reader"
```

---

### Task 6: Implement ZarrTesseraSource (main plugin class)

This is the core MapLibre integration. Port chunk loading, viewport tracking, cache management, and overlay rendering from the existing viewer.

**Files:**
- Create: `packages/maplibre-zarr-tessera/src/zarr-source.ts`

**Step 1: Implement zarr-source.ts**

This is the largest file. It combines the existing viewer's store loading, chunk geometry, visible chunk computation, chunk loading/rendering, overlay management, and map integration into a single class with a clean public API.

Key methods to port from existing viewer:
- `getChunkPixelBounds` -> `private chunkPixelBounds(ci, cj)`
- `getChunkUtmBounds` -> `private chunkUtmBounds(ci, cj)`
- `getVisibleChunkIndices` -> `private visibleChunkIndices()`
- `addChunkToMap` / `removeChunkFromMap` -> private methods
- `loadChunk` / `loadPreviewChunk` / `loadFullChunk` -> `private loadChunk(ci, cj, signal)`
- `updateVisibleChunks` -> `private updateVisibleChunks()`
- `reRenderAllChunks` -> `private reRenderChunks()`
- `addOverlays` / `removeOverlays` -> `private addOverlays()` / `private removeOverlays()`
- `doLoadStore` -> split into `openStore()` (zarr-reader) + `addTo(map)` init

```typescript
import type { Map as MaplibreMap, LngLatBoundsLike } from 'maplibre-gl';
import type {
  ZarrTesseraOptions, StoreMetadata, CachedChunk,
  ChunkBounds, UtmBounds, PreviewMode, ZarrTesseraEvents,
} from './types.js';
import { UtmProjection } from './projection.js';
import { openStore, fetchRegion, type ZarrStore } from './zarr-reader.js';
import { WorkerPool } from './worker-pool.js';

type EventCallback<T> = (data: T) => void;

export class ZarrTesseraSource {
  private opts: Required<ZarrTesseraOptions>;
  private map: MaplibreMap | null = null;
  private store: ZarrStore | null = null;
  private proj: UtmProjection | null = null;
  private workerPool: WorkerPool | null = null;
  private chunkCache = new Map<string, CachedChunk>();
  private currentAbort: AbortController | null = null;
  private autoZoomNext = true;
  private totalLoaded = 0;
  private clickedChunks = new Set<string>();
  private moveHandler: (() => void) | null = null;
  private listeners = new Map<string, Set<EventCallback<unknown>>>();

  constructor(options: ZarrTesseraOptions) {
    this.opts = {
      url: options.url,
      bands: options.bands ?? [0, 1, 2],
      opacity: options.opacity ?? 0.8,
      preview: options.preview ?? 'rgb',
      maxCached: options.maxCached ?? 50,
      maxLoadPerUpdate: options.maxLoadPerUpdate ?? 80,
      concurrency: options.concurrency ?? 4,
      gridVisible: options.gridVisible ?? true,
      utmBoundaryVisible: options.utmBoundaryVisible ?? true,
    };
  }

  // --- Public API ---

  async addTo(map: MaplibreMap): Promise<void> {
    this.map = map;
    this.workerPool = new WorkerPool(
      Math.min(navigator.hardwareConcurrency || 4, 8)
    );

    try {
      this.store = await openStore(this.opts.url);
      this.proj = new UtmProjection(this.store.meta.epsg);
      this.emit('metadata-loaded', this.store.meta);

      // Add overlays
      this.addOverlays();

      // Fly to store bounds
      this.flyToStoreBounds();

      // Listen for viewport changes
      this.moveHandler = () => this.updateVisibleChunks();
      map.on('moveend', this.moveHandler);

      // Start initial load after fly animation
      setTimeout(() => this.updateVisibleChunks(), 1800);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  remove(): void {
    if (this.moveHandler && this.map) {
      this.map.off('moveend', this.moveHandler);
    }
    this.currentAbort?.abort();
    for (const [key] of this.chunkCache) this.removeChunkFromMap(key);
    this.chunkCache.clear();
    this.removeOverlays();
    this.workerPool?.terminate();
    this.store = null;
    this.proj = null;
    this.map = null;
  }

  getMetadata(): StoreMetadata | null {
    return this.store?.meta ?? null;
  }

  setBands(bands: [number, number, number]): void {
    this.opts.bands = bands;
    this.reRenderChunks();
  }

  setOpacity(opacity: number): void {
    this.opts.opacity = opacity;
    for (const [, entry] of this.chunkCache) {
      if (entry.layerId && this.map?.getLayer(entry.layerId)) {
        this.map.setPaintProperty(entry.layerId, 'raster-opacity', opacity);
      }
    }
  }

  setPreview(mode: PreviewMode): void {
    this.opts.preview = mode;
    // Clear cache and reload with new preview mode
    for (const [key] of this.chunkCache) this.removeChunkFromMap(key);
    this.chunkCache.clear();
    this.updateVisibleChunks();
  }

  setGridVisible(visible: boolean): void {
    this.opts.gridVisible = visible;
    const vis = visible ? 'visible' : 'none';
    for (const id of ['chunk-grid-nodata', 'chunk-grid-data', 'chunk-grid-lines']) {
      if (this.map?.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', vis);
    }
  }

  setUtmBoundaryVisible(visible: boolean): void {
    this.opts.utmBoundaryVisible = visible;
    const vis = visible ? 'visible' : 'none';
    for (const id of ['utm-zone-fill', 'utm-zone-line']) {
      if (this.map?.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', vis);
    }
  }

  /** Load full embedding data for a specific chunk (for band exploration). */
  async loadFullChunk(ci: number, cj: number): Promise<void> {
    // Implementation: fetch embeddings + scales, render with current bands,
    // replace preview in cache. Mark chunk in clickedChunks set.
    // (Full implementation follows the pattern from the existing viewer's loadFullChunk)
  }

  on<K extends keyof ZarrTesseraEvents>(
    event: K,
    callback: EventCallback<ZarrTesseraEvents[K]>,
  ): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback as EventCallback<unknown>);
  }

  off<K extends keyof ZarrTesseraEvents>(
    event: K,
    callback: EventCallback<ZarrTesseraEvents[K]>,
  ): void {
    this.listeners.get(event)?.delete(callback as EventCallback<unknown>);
  }

  // --- Private implementation ---
  // Port all chunk geometry, loading, rendering, overlay methods from
  // the existing viewer. Each maps directly:
  //
  // getChunkPixelBounds -> chunkPixelBounds(ci, cj): ChunkBounds
  // getChunkUtmBounds -> chunkUtmBounds(ci, cj): UtmBounds
  // getChunkLngLatCorners -> chunkCorners(ci, cj): [lng,lat][]
  // getVisibleChunkIndices -> visibleChunkIndices(): [number,number][]
  // addChunkToMap -> addChunkToMap(ci, cj, canvas): {sourceId, layerId}
  // removeChunkFromMap -> removeChunkFromMap(key): void
  // updateVisibleChunks -> updateVisibleChunks(): Promise<void>
  // loadChunk/loadPreviewChunk -> loadChunk(ci, cj, signal): Promise<void>
  // reRenderAllChunks -> reRenderChunks(): Promise<void>
  // addOverlays -> addOverlays(): void
  // removeOverlays -> removeOverlays(): void
  // rgbaToCanvas -> rgbaToCanvas(rgba, w, h): HTMLCanvasElement

  private emit<K extends keyof ZarrTesseraEvents>(
    event: K, data: ZarrTesseraEvents[K],
  ): void {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }

  private chunkKey(ci: number, cj: number): string { return `${ci}_${cj}`; }

  private chunkPixelBounds(ci: number, cj: number): ChunkBounds {
    const s = this.store!.meta.shape;
    const cs = this.store!.meta.chunkShape;
    return {
      r0: ci * cs[0],
      r1: Math.min(ci * cs[0] + cs[0], s[0]),
      c0: cj * cs[1],
      c1: Math.min(cj * cs[1] + cs[1], s[1]),
    };
  }

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

  private chunkCorners(ci: number, cj: number) {
    return this.proj!.chunkCornersToLngLat(this.chunkUtmBounds(ci, cj));
  }

  private visibleChunkIndices(): [number, number][] {
    if (!this.store || !this.map || !this.proj) return [];
    const bounds = this.map.getBounds();
    const sw = this.proj.forward(bounds.getWest(), bounds.getSouth());
    const ne = this.proj.forward(bounds.getEast(), bounds.getNorth());
    const nw = this.proj.forward(bounds.getWest(), bounds.getNorth());
    const se = this.proj.forward(bounds.getEast(), bounds.getSouth());

    const minE = Math.min(sw[0], nw[0]) - 1000;
    const maxE = Math.max(ne[0], se[0]) + 1000;
    const minN = Math.min(sw[1], se[1]) - 1000;
    const maxN = Math.max(ne[1], nw[1]) + 1000;

    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;
    const t = this.store.meta.transform;
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
        if (this.store.chunkManifest && !this.store.chunkManifest.has(`${ci}_${cj}`)) continue;
        result.push([ci, cj]);
      }
    }
    return result;
  }

  private rgbaToCanvas(rgbaBuffer: ArrayBuffer, w: number, h: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    img.data.set(new Uint8Array(rgbaBuffer));
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

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

    // Keep overlays on top
    if (this.map!.getLayer('chunk-grid-lines')) this.map!.moveLayer('chunk-grid-lines');
    if (this.map!.getLayer('utm-zone-line')) this.map!.moveLayer('utm-zone-line');

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

  private async updateVisibleChunks(): Promise<void> {
    if (!this.store || !this.map) return;
    this.currentAbort?.abort();
    const abort = this.currentAbort = new AbortController();
    const signal = abort.signal;

    const visible = this.visibleChunkIndices();
    const visibleKeys = new Set(visible.map(([ci, cj]) => this.chunkKey(ci, cj)));

    // Remove off-screen chunks from map (keep in cache)
    for (const [key, entry] of this.chunkCache) {
      if (!visibleKeys.has(key) && entry.sourceId) this.removeChunkFromMap(key);
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
      const [cE, cN] = this.proj!.forward(center.lng, center.lat);
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
    const usePreview =
      (this.opts.preview === 'pca' && this.store.meta.hasPca) ||
      (this.opts.preview === 'rgb' && this.store.meta.hasRgb);

    this.emit('loading', { total: toLoad.length, done: 0 });
    let done = 0;

    for (let i = 0; i < toLoad.length; i += this.opts.concurrency) {
      if (signal.aborted) break;
      const batch = toLoad.slice(i, i + this.opts.concurrency);
      await Promise.all(batch.map(([ci, cj]) =>
        this.loadChunk(ci, cj, signal, usePreview).then(() => {
          done++;
          this.emit('loading', { total: toLoad.length, done });
        })
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

  private async loadChunk(
    ci: number, cj: number, signal: AbortSignal, usePreview: boolean,
  ): Promise<void> {
    const key = this.chunkKey(ci, cj);
    if (this.chunkCache.has(key)) return;

    try {
      const { r0, r1, c0, c1 } = this.chunkPixelBounds(ci, cj);
      const h = r1 - r0;
      const w = c1 - c0;

      let result: Record<string, unknown>;

      if (usePreview && !this.clickedChunks.has(key)) {
        const previewArr = this.opts.preview === 'pca'
          ? this.store!.pcaArr! : this.store!.rgbArr!;
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
          fetchRegion(this.store!.embArr, [[r0, r1], [c0, c1], null]),
          fetchRegion(this.store!.scalesArr, [[r0, r1], [c0, c1]]),
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
          width: w, height: h, nBands: this.store!.meta.nBands, bands: this.opts.bands,
        }, [embBuf, scalesBuf]);
      }

      let canvas: HTMLCanvasElement | null = null;
      let sourceId: string | null = null;
      let layerId: string | null = null;

      if ((result.nValid as number) > 0) {
        canvas = this.rgbaToCanvas(result.rgba as ArrayBuffer, w, h);
        ({ sourceId, layerId } = this.addChunkToMap(ci, cj, canvas));

        if (this.autoZoomNext) {
          this.autoZoomNext = false;
          const corners = this.chunkCorners(ci, cj);
          const lngs = corners.map(c => c[0]);
          const lats = corners.map(c => c[1]);
          this.map!.fitBounds([
            [Math.min(...lngs), Math.min(...lats)],
            [Math.max(...lngs), Math.max(...lats)],
          ] as LngLatBoundsLike, { padding: 40, duration: 1000 });
        }
      }

      this.chunkCache.set(key, {
        ci, cj,
        embRaw: (result.embRaw as ArrayBuffer) ? new Uint8Array(result.embRaw as ArrayBuffer) : null,
        scalesRaw: (result.scalesRaw as ArrayBuffer) ? new Uint8Array(result.scalesRaw as ArrayBuffer) : null,
        canvas, sourceId, layerId, isPreview: usePreview,
      });
      this.totalLoaded++;
      this.emit('chunk-loaded', { ci, cj });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.warn(`Failed to load chunk (${ci},${cj}):`, err);
      this.chunkCache.set(key, {
        ci, cj, embRaw: null, scalesRaw: null,
        canvas: null, sourceId: null, layerId: null, isPreview: false,
      });
    }
  }

  private async reRenderChunks(): Promise<void> {
    if (!this.workerPool || !this.store) return;
    const tasks: Promise<void>[] = [];

    for (const [key, entry] of this.chunkCache) {
      if (!entry.embRaw) continue;
      const wasOnMap = !!entry.sourceId;
      if (wasOnMap) this.removeChunkFromMap(key);

      const { r0, r1, c0, c1 } = this.chunkPixelBounds(entry.ci, entry.cj);
      const h = r1 - r0;
      const w = c1 - c0;
      const embCopy = entry.embRaw.slice().buffer;
      const scalesCopy = entry.scalesRaw!.slice().buffer;

      const task = this.workerPool.dispatch({
        type: 'render-emb', embRaw: embCopy, scalesRaw: scalesCopy,
        width: w, height: h, nBands: this.store.meta.nBands, bands: this.opts.bands,
      }, [embCopy, scalesCopy]).then((result) => {
        entry.embRaw = new Uint8Array(result.embRaw as ArrayBuffer);
        entry.scalesRaw = new Uint8Array(result.scalesRaw as ArrayBuffer);
        if ((result.nValid as number) > 0) {
          entry.canvas = this.rgbaToCanvas(result.rgba as ArrayBuffer, w, h);
          if (wasOnMap) {
            const ids = this.addChunkToMap(entry.ci, entry.cj, entry.canvas);
            entry.sourceId = ids.sourceId;
            entry.layerId = ids.layerId;
          }
        } else {
          entry.canvas = null;
        }
      });
      tasks.push(task);
    }
    await Promise.all(tasks);
  }

  private flyToStoreBounds(): void {
    if (!this.store || !this.map || !this.proj) return;
    const t = this.store.meta.transform;
    const px = t[0], originE = t[2], originN = t[5];
    const w = this.store.meta.shape[1], h = this.store.meta.shape[0];

    const corners = [
      this.proj.inverse(originE, originN),
      this.proj.inverse(originE + w * px, originN),
      this.proj.inverse(originE + w * px, originN - h * px),
      this.proj.inverse(originE, originN - h * px),
    ];
    const lngs = corners.map(c => c[0]);
    const lats = corners.map(c => c[1]);
    this.map.fitBounds([
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ] as LngLatBoundsLike, { padding: 40, duration: 1500 });
  }

  private addOverlays(): void {
    if (!this.store || !this.map || !this.proj) return;
    this.removeOverlays();

    // UTM zone boundary
    const zone = this.store.meta.utmZone;
    const isSouth = this.proj.isSouth;
    const lonMin = (zone - 1) * 6 - 180;
    const lonMax = zone * 6 - 180;
    const latMin = isSouth ? -80 : 0;
    const latMax = isSouth ? 0 : 84;

    this.map.addSource('utm-zone', {
      type: 'geojson',
      data: {
        type: 'Feature', properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[lonMin, latMin], [lonMax, latMin], [lonMax, latMax], [lonMin, latMax], [lonMin, latMin]]],
        },
      },
    });

    this.map.addLayer({
      id: 'utm-zone-fill', type: 'fill', source: 'utm-zone',
      paint: { 'fill-color': '#39ff14', 'fill-opacity': 0.03 },
      layout: { visibility: this.opts.utmBoundaryVisible ? 'visible' : 'none' },
    });

    // Chunk grid
    const cs = this.store.meta.chunkShape;
    const s = this.store.meta.shape;
    const nRows = Math.ceil(s[0] / cs[0]);
    const nCols = Math.ceil(s[1] / cs[1]);
    const features: GeoJSON.Feature[] = [];

    for (let ci = 0; ci < nRows; ci++) {
      for (let cj = 0; cj < nCols; cj++) {
        const hasData = this.store.chunkManifest
          ? this.store.chunkManifest.has(`${ci}_${cj}`) : true;
        const corners = this.chunkCorners(ci, cj);
        features.push({
          type: 'Feature',
          properties: { ci, cj, hasData },
          geometry: {
            type: 'Polygon',
            coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
          },
        });
      }
    }

    this.map.addSource('chunk-grid', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    });

    const gridVis = this.opts.gridVisible ? 'visible' : 'none';

    this.map.addLayer({
      id: 'chunk-grid-nodata', type: 'fill', source: 'chunk-grid',
      filter: ['==', ['get', 'hasData'], false],
      paint: { 'fill-color': '#374151', 'fill-opacity': 0.15 },
      layout: { visibility: gridVis },
    });
    this.map.addLayer({
      id: 'chunk-grid-data', type: 'fill', source: 'chunk-grid',
      filter: ['==', ['get', 'hasData'], true],
      paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.04 },
      layout: { visibility: gridVis },
    });
    this.map.addLayer({
      id: 'chunk-grid-lines', type: 'line', source: 'chunk-grid',
      paint: {
        'line-color': ['case', ['get', 'hasData'], '#00e5ff', '#374151'],
        'line-width': ['case', ['get', 'hasData'], 1, 0.5],
        'line-opacity': ['case', ['get', 'hasData'], 0.4, 0.2],
      },
      layout: { visibility: gridVis },
    });
    this.map.addLayer({
      id: 'utm-zone-line', type: 'line', source: 'utm-zone',
      paint: { 'line-color': '#39ff14', 'line-width': 2, 'line-opacity': 0.5, 'line-dasharray': [6, 4] },
      layout: { visibility: this.opts.utmBoundaryVisible ? 'visible' : 'none' },
    });
  }

  private removeOverlays(): void {
    const layers = ['chunk-grid-nodata', 'chunk-grid-data', 'chunk-grid-lines', 'utm-zone-fill', 'utm-zone-line'];
    for (const id of layers) {
      if (this.map?.getLayer(id)) this.map.removeLayer(id);
    }
    if (this.map?.getSource('utm-zone')) this.map.removeSource('utm-zone');
    if (this.map?.getSource('chunk-grid')) this.map.removeSource('chunk-grid');
  }
}
```

This is the complete class — no stub methods. Every private method has a full implementation ported from the existing viewer.

**Step 2: Verify plugin type-checks**

Run: `cd ~/src/git/ucam-eo/tze/packages/maplibre-zarr-tessera && pnpm check`
Expected: No type errors (fix any that arise)

**Step 3: Build the plugin**

Run: `pnpm build`
Expected: `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts` created

**Step 4: Commit**

```bash
git add -A && git commit -m "feat(plugin): implement ZarrTesseraSource with full chunk loading"
```

---

### Task 7: Scaffold Svelte viewer app

**Files:**
- Create: `apps/viewer/package.json`
- Create: `apps/viewer/vite.config.ts`
- Create: `apps/viewer/tsconfig.json`
- Create: `apps/viewer/index.html`
- Create: `apps/viewer/src/main.ts`
- Create: `apps/viewer/src/app.css`
- Create: `apps/viewer/src/App.svelte`
- Create: `apps/viewer/svelte.config.js`

**Step 1: Create package.json**

```json
{
  "name": "viewer",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-check --tsconfig ./tsconfig.json"
  },
  "dependencies": {
    "@ucam-eo/maplibre-zarr-tessera": "workspace:*",
    "maplibre-gl": "^4.7.1"
  },
  "devDependencies": {
    "@sveltejs/vite-plugin-svelte": "^5.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "svelte": "^5.0.0",
    "svelte-check": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

**Step 2: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
});
```

**Step 3: Create svelte.config.js**

```javascript
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
};
```

**Step 4: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["svelte"]
  },
  "include": ["src/**/*.ts", "src/**/*.svelte"]
}
```

**Step 5: Create index.html**

```html
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TZE — Tessera Zarr Explorer</title>
  <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

**Step 6: Create src/app.css**

Port the dark terminal styling from existing viewer. Tailwind CSS 4 uses `@import "tailwindcss"` instead of `@tailwind` directives.

```css
@import "tailwindcss";

@theme {
  --font-mono: "JetBrains Mono", "Fira Code", monospace;
  --color-term-green: #39ff14;
  --color-term-cyan: #00e5ff;
  --color-term-dim: #6b7280;
}

body { margin: 0; padding: 0; overflow: hidden; background: #000; }
#map { position: absolute; inset: 0; }

::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }

@keyframes pulse-glow { 0%,100%{opacity:.4} 50%{opacity:1} }
.loading-glow { animation: pulse-glow 1.5s ease-in-out infinite; }
```

**Step 7: Create src/main.ts**

```typescript
import './app.css';
import App from './App.svelte';
import { mount } from 'svelte';

const app = mount(App, { target: document.getElementById('app')! });
export default app;
```

**Step 8: Create initial App.svelte (minimal)**

```svelte
<script lang="ts">
  import 'maplibre-gl/dist/maplibre-gl.css';
  import maplibregl from 'maplibre-gl';
  import { onMount } from 'svelte';

  let mapContainer: HTMLDivElement;
  let map: maplibregl.Map;

  onMount(() => {
    map = new maplibregl.Map({
      container: mapContainer,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; OpenStreetMap contributors',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [0, 20],
      zoom: 3,
    });

    return () => map.remove();
  });
</script>

<div bind:this={mapContainer} id="map"></div>
<p class="absolute top-4 left-4 text-term-cyan font-mono text-sm z-10">TZE</p>
```

**Step 9: Install deps and test dev server**

Run: `cd ~/src/git/ucam-eo/tze && pnpm install`
Run: `pnpm dev`
Expected: Vite dev server starts, browser shows map with OSM tiles

**Step 10: Commit**

```bash
git add -A && git commit -m "scaffold: Svelte viewer app with MapLibre and Tailwind"
```

---

### Task 8: Build Svelte stores and StoreSelector

**Files:**
- Create: `apps/viewer/src/stores/map.ts`
- Create: `apps/viewer/src/stores/zarr.ts`
- Create: `apps/viewer/src/components/StoreSelector.svelte`

**Step 1: Create stores/map.ts**

```typescript
import { writable } from 'svelte/store';
import type { Map as MaplibreMap } from 'maplibre-gl';

export const mapInstance = writable<MaplibreMap | null>(null);
```

**Step 2: Create stores/zarr.ts**

```typescript
import { writable, derived } from 'svelte/store';
import type { ZarrTesseraSource, StoreMetadata } from '@ucam-eo/maplibre-zarr-tessera';

export const zarrSource = writable<ZarrTesseraSource | null>(null);
export const metadata = writable<StoreMetadata | null>(null);
export const bands = writable<[number, number, number]>([0, 1, 2]);
export const opacity = writable(0.8);
export const preview = writable<'rgb' | 'pca' | 'bands'>('rgb');
export const loading = writable({ total: 0, done: 0 });
export const status = writable('Ready');
export const gridVisible = writable(true);
export const utmBoundaryVisible = writable(true);

// Recent stores (persisted to localStorage)
const STORAGE_KEY = 'tze-recent-stores';
const MAX_RECENT = 10;

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}

export const recentStores = writable<string[]>(loadRecent());

export function addRecentStore(url: string): void {
  recentStores.update(stores => {
    const filtered = stores.filter(s => s !== url);
    const updated = [url, ...filtered].slice(0, MAX_RECENT);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    return updated;
  });
}
```

**Step 3: Create components/StoreSelector.svelte**

```svelte
<script lang="ts">
  import { ZarrTesseraSource } from '@ucam-eo/maplibre-zarr-tessera';
  import { mapInstance } from '../stores/map';
  import {
    zarrSource, metadata, status, loading, bands, opacity, preview,
    recentStores, addRecentStore,
  } from '../stores/zarr';

  let urlInput = $state('');
  let isLoading = $state(false);

  async function loadStore() {
    const url = urlInput.trim().replace(/\/+$/, '');
    if (!url || !$mapInstance) return;

    isLoading = true;
    $status = 'Connecting...';

    // Remove previous source
    $zarrSource?.remove();
    $zarrSource = null;
    $metadata = null;

    try {
      const source = new ZarrTesseraSource({
        url,
        bands: $bands,
        opacity: $opacity,
        preview: $preview,
      });

      source.on('metadata-loaded', (meta) => {
        $metadata = meta;
        $status = `Loaded: zone ${meta.utmZone}`;
      });
      source.on('loading', (progress) => { $loading = progress; });
      source.on('error', (err) => { $status = `Error: ${err.message}`; });

      await source.addTo($mapInstance);
      $zarrSource = source;
      addRecentStore(url);
    } catch (err) {
      $status = `Error: ${(err as Error).message}`;
    } finally {
      isLoading = false;
    }
  }

  function selectRecent(url: string) {
    urlInput = url;
    loadStore();
  }
</script>

<div class="px-4 py-3 border-b border-gray-800/60">
  <label class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Store URL</label>
  <div class="flex gap-1.5 mt-1.5">
    <input
      type="text"
      bind:value={urlInput}
      placeholder="https://host/utm30_2025.zarr"
      onkeydown={(e) => e.key === 'Enter' && loadStore()}
      class="flex-1 bg-gray-950 border border-gray-700/60 rounded px-2 py-1.5
             text-gray-300 text-[11px] focus:border-term-cyan/60 focus:outline-none
             focus:shadow-[0_0_8px_rgba(0,229,255,0.15)] transition-all
             placeholder-gray-700"
    />
    <button
      onclick={loadStore}
      disabled={isLoading}
      class="bg-term-cyan/90 hover:bg-term-cyan text-black font-bold text-[10px]
             px-3 py-1.5 rounded tracking-wider transition-all
             hover:shadow-[0_0_12px_rgba(0,229,255,0.4)] active:scale-95
             disabled:opacity-50"
    >
      {isLoading ? '...' : 'LOAD'}
    </button>
  </div>

  {#if $recentStores.length > 0}
    <details class="mt-1.5">
      <summary class="text-[10px] text-gray-600 cursor-pointer hover:text-gray-400 transition-colors">
        Recent ({$recentStores.length})
      </summary>
      <div class="mt-1 space-y-0.5 max-h-24 overflow-y-auto">
        {#each $recentStores as url}
          <button
            onclick={() => selectRecent(url)}
            class="block w-full text-left text-[10px] text-gray-500 hover:text-term-cyan
                   truncate px-1 py-0.5 rounded hover:bg-gray-900/50 transition-colors"
          >
            {url}
          </button>
        {/each}
      </div>
    </details>
  {/if}

  <div class="mt-1.5 text-[10px] text-gray-600 truncate">{$status}</div>
</div>
```

**Step 4: Commit**

```bash
git add -A && git commit -m "feat(viewer): add Svelte stores and StoreSelector component"
```

---

### Task 9: Build remaining viewer components

**Files:**
- Create: `apps/viewer/src/components/LayerSwitcher.svelte`
- Create: `apps/viewer/src/components/BandMapper.svelte`
- Create: `apps/viewer/src/components/ControlPanel.svelte`
- Create: `apps/viewer/src/components/InfoPanel.svelte`
- Modify: `apps/viewer/src/App.svelte`

**Step 1: Create LayerSwitcher.svelte**

```svelte
<script lang="ts">
  import { mapInstance } from '../stores/map';

  const BASEMAPS = [
    { id: 'osm', label: 'Streets', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '&copy; OpenStreetMap' },
    { id: 'satellite', label: 'Satellite', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Esri, Maxar' },
    { id: 'terrain', label: 'Terrain', tiles: ['https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}.png'], attribution: 'Stadia Maps, Stamen' },
    { id: 'dark', label: 'Dark', tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'], attribution: 'CartoDB, OSM' },
  ] as const;

  let selected = $state('dark');

  function switchBasemap(id: string) {
    if (!$mapInstance || selected === id) return;
    selected = id;
    const bm = BASEMAPS.find(b => b.id === id)!;

    const source = $mapInstance.getSource('basemap') as maplibregl.RasterTileSource;
    if (source) {
      // Update tiles by re-setting the style
      $mapInstance.setStyle({
        version: 8,
        sources: {
          basemap: {
            type: 'raster', tiles: [...bm.tiles], tileSize: 256, attribution: bm.attribution,
          },
        },
        layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
      });
    }
  }
</script>

<div class="px-4 py-3 border-b border-gray-800/60">
  <label class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Basemap</label>
  <div class="mt-2 flex gap-1">
    {#each BASEMAPS as bm}
      <button
        onclick={() => switchBasemap(bm.id)}
        class="flex-1 text-[10px] font-bold tracking-wider py-1 rounded border transition-all
               {selected === bm.id
                 ? 'bg-term-cyan/20 text-term-cyan border-term-cyan/40'
                 : 'bg-gray-950 text-gray-500 border-gray-700/60 hover:text-gray-300'}"
      >
        {bm.label}
      </button>
    {/each}
  </div>
</div>
```

**Step 2: Create BandMapper.svelte**

Port band sliders from existing viewer's band-panel.

```svelte
<script lang="ts">
  import { bands } from '../stores/zarr';
  import { zarrSource, metadata } from '../stores/zarr';

  let r = $state($bands[0]);
  let g = $state($bands[1]);
  let b = $state($bands[2]);

  function updateBands() {
    $bands = [r, g, b];
    $zarrSource?.setBands([r, g, b]);
  }

  const enabled = $derived(!!$metadata);
</script>

<div class="px-4 py-3 border-b border-gray-800/60 transition-opacity"
     class:opacity-40={!enabled} class:pointer-events-none={!enabled}>
  <label class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Band Mapping</label>
  <div class="mt-2 space-y-2">
    {#each [
      { label: 'R', color: 'red', value: () => r, set: (v: number) => { r = v; updateBands(); } },
      { label: 'G', color: 'green', value: () => g, set: (v: number) => { g = v; updateBands(); } },
      { label: 'B', color: 'blue', value: () => b, set: (v: number) => { b = v; updateBands(); } },
    ] as item}
      <div class="flex items-center gap-2">
        <span class="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold
                     bg-{item.color}-500/20 text-{item.color}-400 border border-{item.color}-500/30">
          {item.label}
        </span>
        <input type="range" min="0" max="127" value={item.value()}
               oninput={(e) => item.set(parseInt((e.target as HTMLInputElement).value))}
               class="flex-1 h-1" />
        <span class="w-6 text-right text-{item.color}-400 tabular-nums text-[11px]">{item.value()}</span>
      </div>
    {/each}
  </div>
</div>
```

**Step 3: Create ControlPanel.svelte**

Container for opacity slider, overlay toggles, preview mode toggle.

```svelte
<script lang="ts">
  import { zarrSource, metadata, opacity, preview, gridVisible, utmBoundaryVisible } from '../stores/zarr';

  const enabled = $derived(!!$metadata);

  function updateOpacity(val: number) {
    $opacity = val;
    $zarrSource?.setOpacity(val);
  }

  function toggleGrid() {
    $gridVisible = !$gridVisible;
    $zarrSource?.setGridVisible($gridVisible);
  }

  function toggleUtm() {
    $utmBoundaryVisible = !$utmBoundaryVisible;
    $zarrSource?.setUtmBoundaryVisible($utmBoundaryVisible);
  }

  function setPreview(mode: 'rgb' | 'pca' | 'bands') {
    $preview = mode;
    $zarrSource?.setPreview(mode);
  }
</script>

<!-- Opacity -->
<div class="px-4 py-3 border-b border-gray-800/60 transition-opacity"
     class:opacity-40={!enabled} class:pointer-events-none={!enabled}>
  <div class="flex items-center justify-between">
    <label class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Opacity</label>
    <span class="text-term-cyan/70 tabular-nums text-[11px]">{$opacity.toFixed(2)}</span>
  </div>
  <input type="range" min="0" max="100" value={Math.round($opacity * 100)}
         oninput={(e) => updateOpacity(parseInt((e.target as HTMLInputElement).value) / 100)}
         class="w-full h-1 mt-1.5" />
</div>

<!-- Preview mode -->
{#if $metadata?.hasRgb || $metadata?.hasPca}
  <div class="px-4 py-3 border-b border-gray-800/60">
    <label class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Preview</label>
    <div class="mt-2 flex gap-1.5">
      {#if $metadata?.hasRgb}
        <button onclick={() => setPreview('rgb')}
                class="flex-1 text-[10px] font-bold tracking-wider py-1.5 rounded border transition-all
                       {$preview === 'rgb' ? 'bg-term-cyan/20 text-term-cyan border-term-cyan/40' : 'bg-gray-950 text-gray-500 border-gray-700/60'}">
          RGB
        </button>
      {/if}
      {#if $metadata?.hasPca}
        <button onclick={() => setPreview('pca')}
                class="flex-1 text-[10px] font-bold tracking-wider py-1.5 rounded border transition-all
                       {$preview === 'pca' ? 'bg-term-cyan/20 text-term-cyan border-term-cyan/40' : 'bg-gray-950 text-gray-500 border-gray-700/60'}">
          PCA
        </button>
      {/if}
    </div>
  </div>
{/if}

<!-- Overlays -->
<div class="px-4 py-3 border-b border-gray-800/60 transition-opacity"
     class:opacity-40={!enabled} class:pointer-events-none={!enabled}>
  <label class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Overlays</label>
  <div class="mt-2 space-y-1.5">
    <label class="flex items-center gap-2 cursor-pointer group">
      <input type="checkbox" checked={$gridVisible} onchange={toggleGrid}
             class="w-3 h-3 rounded accent-[#00e5ff]" />
      <span class="text-[11px] group-hover:text-term-cyan transition-colors">Chunk grid</span>
    </label>
    <label class="flex items-center gap-2 cursor-pointer group">
      <input type="checkbox" checked={$utmBoundaryVisible} onchange={toggleUtm}
             class="w-3 h-3 rounded accent-[#39ff14]" />
      <span class="text-[11px] group-hover:text-term-green transition-colors">UTM zone</span>
    </label>
  </div>
</div>
```

**Step 4: Create InfoPanel.svelte**

```svelte
<script lang="ts">
  import { metadata, loading } from '../stores/zarr';
</script>

{#if $metadata}
  <div class="px-4 py-3 text-[10px] space-y-1">
    <div class="flex justify-between"><span class="text-gray-600">Zone</span><span class="text-gray-400">{$metadata.utmZone}</span></div>
    <div class="flex justify-between"><span class="text-gray-600">EPSG</span><span class="text-gray-400">EPSG:{$metadata.epsg}</span></div>
    <div class="flex justify-between">
      <span class="text-gray-600">Grid</span>
      <span class="text-gray-400">
        {$metadata.shape[1]}x{$metadata.shape[0]}px
        ({($metadata.shape[1] * $metadata.transform[0] / 1000).toFixed(0)}x{($metadata.shape[0] * $metadata.transform[0] / 1000).toFixed(0)}km)
      </span>
    </div>
    <div class="flex justify-between"><span class="text-gray-600">Bands</span><span class="text-term-cyan/60 tabular-nums">{$metadata.nBands}</span></div>
    {#if $loading.total > 0}
      <div class="flex justify-between"><span class="text-gray-600">Loading</span><span class="text-term-cyan tabular-nums">{$loading.done}/{$loading.total}</span></div>
    {/if}
  </div>
{/if}
```

**Step 5: Update App.svelte with all components**

```svelte
<script lang="ts">
  import maplibregl from 'maplibre-gl';
  import { onMount } from 'svelte';
  import { mapInstance } from './stores/map';
  import StoreSelector from './components/StoreSelector.svelte';
  import LayerSwitcher from './components/LayerSwitcher.svelte';
  import BandMapper from './components/BandMapper.svelte';
  import ControlPanel from './components/ControlPanel.svelte';
  import InfoPanel from './components/InfoPanel.svelte';

  let mapContainer: HTMLDivElement;

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
    });

    return () => { map.remove(); $mapInstance = null; };
  });
</script>

<div bind:this={mapContainer} id="map"></div>

<!-- Control panel -->
<div class="absolute top-4 right-4 w-[280px] bg-black/85 backdrop-blur-xl
            border border-gray-800/80 rounded-lg shadow-2xl shadow-cyan-900/20
            overflow-hidden select-none z-10 font-mono text-gray-300 text-xs">
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
  <BandMapper />
  <ControlPanel />
  <InfoPanel />
</div>

<!-- Coordinates -->
<div class="absolute bottom-2 left-2 bg-black/70 backdrop-blur-sm
            text-[10px] text-gray-500 font-mono px-2.5 py-1 rounded
            border border-gray-800/40 z-10 tabular-nums">
  <span id="coord-text">--</span>
</div>
```

**Step 6: Verify dev server works**

Run: `cd ~/src/git/ucam-eo/tze && pnpm dev`
Expected: Full UI renders — map + control panel + all components

**Step 7: Commit**

```bash
git add -A && git commit -m "feat(viewer): complete UI with all components"
```

---

### Task 10: Build and verify static site

**Step 1: Build the plugin**

Run: `cd ~/src/git/ucam-eo/tze && pnpm -F @ucam-eo/maplibre-zarr-tessera build`
Expected: `packages/maplibre-zarr-tessera/dist/` created with `index.js`, `index.cjs`

**Step 2: Build the viewer**

Run: `pnpm -F viewer build`
Expected: `apps/viewer/dist/` created with `index.html` and assets

**Step 3: Preview the static site**

Run: `pnpm -F viewer preview`
Expected: Opens on port 4173, all UI elements render, basemap loads

**Step 4: Commit**

```bash
git add -A && git commit -m "chore: verify builds succeed"
```

---

### Task 11: Integration test with a live Zarr store

This task requires a running `geotessera-registry serve` or an HTTP-accessible Zarr store.

**Step 1: Start geotessera serve on a built store**

(On a machine with zarr output)
Run: `geotessera-registry serve --store utm29_2025 /root/z1`

**Step 2: Open TZE viewer in browser**

Enter the store URL (e.g. `http://server:8765/utm29_2025.zarr`) and click Load.

**Step 3: Verify:**
- Store metadata appears in info panel
- Chunks load and render on the map
- Band sliders change rendering
- Basemap switcher works
- Opacity slider works
- Grid and UTM overlays toggle
- Preview mode toggle works (if RGB/PCA available)
- URL saved to recent stores

**Step 4: Fix any issues found**

**Step 5: Final commit**

```bash
git add -A && git commit -m "fix: integration test fixes"
```
