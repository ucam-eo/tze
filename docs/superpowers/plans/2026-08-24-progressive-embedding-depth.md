# Progressive Embedding Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load regions at a chosen matryoshka depth (default d16) with a one-click upgrade to full depth that reruns the active analysis.

**Architecture:** Depth is a per-load option, not store state. `loadChunks({ depth })` groups the requested tiles into whole chunks of the depth array being read — mandatory, since a 32×32 read from `embeddings_d16` decodes a 64×64 chunk and wastes ¾ of it — then scatters results into the region, which keeps its canonical 32×32 tile grid. `EmbeddingRegion.nBands` becomes the loaded depth; a load whose depth differs from the live region clears and reallocates it, which is the whole upgrade mechanism.

**Tech Stack:** TypeScript 5.7, zarrita 0.7, vitest, Svelte 5 runes, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-24-progressive-embedding-depth-design.md`

## Global Constraints

- Grouping applies to NCHW (`meta.version === 'v2'`) stores only. v1 HWB stores keep the existing per-tile path untouched.
- At full depth a group must be exactly one tile, so the request pattern is byte-for-byte what it is today.
- `EmbeddingRegion` layout, tile grid, `ci/cj` keys and NaN convention do not change. Only `nBands` varies.
- Segmentation requires `nBands === 128` (`solar_unet_stats.json` declares `in_channels: 128`).
- Default load depth is 16 when the store offers it, full depth otherwise.
- Every task ends green: `pnpm check` 0 errors, `pnpm test` passing.

---

### Task 1: Group tiles into depth-array chunks

**Files:**
- Modify: `packages/tessera/src/depths.ts`
- Modify: `packages/tessera/src/index.ts`
- Test: `packages/tessera/src/__tests__/depths.test.ts`

**Interfaces:**
- Consumes: `DepthWindow`, `ChunkRef` (existing).
- Produces: `TileGroup { r0, c0, height, width, tiles: ChunkRef[] }` and
  `groupTilesByChunk(tiles, tileH, tileW, chunkH, chunkW, imageH, imageW): TileGroup[]`.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('groupTilesByChunk', () => {
  it('reads each tile on its own when the chunk is one tile', () => {
    // Full depth: the store's chunk IS the region's tile.
    const groups = groupTilesByChunk(
      [{ ci: 0, cj: 0 }, { ci: 0, cj: 1 }], 32, 32, 32, 32, 4096, 4096,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ r0: 0, c0: 0, height: 32, width: 32, tiles: [{ ci: 0, cj: 0 }] });
    expect(groups[1]).toEqual({ r0: 0, c0: 32, height: 32, width: 32, tiles: [{ ci: 0, cj: 1 }] });
  });

  it('reads tiles sharing a chunk in one go', () => {
    // d16: a 64x64 chunk covers a 2x2 block of 32x32 tiles.
    const tiles = [{ ci: 0, cj: 0 }, { ci: 0, cj: 1 }, { ci: 1, cj: 0 }, { ci: 1, cj: 1 }];
    const groups = groupTilesByChunk(tiles, 32, 32, 64, 64, 4096, 4096);
    expect(groups).toHaveLength(1);
    expect(groups[0].r0).toBe(0);
    expect(groups[0].c0).toBe(0);
    expect(groups[0].height).toBe(64);
    expect(groups[0].tiles).toHaveLength(4);
  });

  it('splits tiles that fall in different chunks', () => {
    const groups = groupTilesByChunk(
      [{ ci: 0, cj: 0 }, { ci: 2, cj: 0 }], 32, 32, 64, 64, 4096, 4096,
    );
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.r0)).toEqual([0, 64]);
  });

  it('carries only the tiles that were asked for', () => {
    // One tile of a 2x2 chunk: the read still covers the chunk, but the
    // group must not claim neighbours the caller never requested.
    const groups = groupTilesByChunk([{ ci: 1, cj: 1 }], 32, 32, 64, 64, 4096, 4096);
    expect(groups[0].tiles).toEqual([{ ci: 1, cj: 1 }]);
    expect(groups[0]).toMatchObject({ r0: 0, c0: 0, height: 64, width: 64 });
  });

  it('clips the read at the array edge', () => {
    const groups = groupTilesByChunk([{ ci: 1, cj: 1 }], 32, 32, 64, 64, 100, 80);
    expect(groups[0]).toMatchObject({ r0: 0, c0: 0, height: 64, width: 64 });
    const edge = groupTilesByChunk([{ ci: 2, cj: 2 }], 32, 32, 64, 64, 100, 80);
    expect(edge[0]).toMatchObject({ r0: 64, c0: 64, height: 36, width: 16 });
  });

  it('returns nothing for no tiles', () => {
    expect(groupTilesByChunk([], 32, 32, 64, 64, 4096, 4096)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd packages/tessera && pnpm vitest run src/__tests__/depths.test.ts`
Expected: FAIL — `groupTilesByChunk is not a function`.

- [ ] **Step 3: Implement**

```typescript
/** A single read covering one chunk, and the tiles it satisfies. */
export interface TileGroup extends DepthWindow {
  tiles: ChunkRef[];
}

/**
 * Batch tile requests into whole chunks of the array being read.
 *
 * @remarks
 * The depth arrays trade bands for spatial extent, so a shallow array's chunk
 * covers several of the region's tiles. Reading tile by tile would decode a
 * whole chunk per tile and discard most of it, cutting the saving from 8x to
 * 2x at d16. Grouping first means each chunk is decoded once.
 */
export function groupTilesByChunk(
  tiles: readonly ChunkRef[],
  tileH: number,
  tileW: number,
  chunkH: number,
  chunkW: number,
  imageH: number,
  imageW: number,
): TileGroup[] {
  const groups = new Map<string, TileGroup>();

  for (const tile of tiles) {
    const r0 = Math.floor((tile.ci * tileH) / chunkH) * chunkH;
    const c0 = Math.floor((tile.cj * tileW) / chunkW) * chunkW;
    const key = `${r0}_${c0}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        r0, c0,
        height: Math.min(chunkH, imageH - r0),
        width: Math.min(chunkW, imageW - c0),
        tiles: [],
      };
      groups.set(key, group);
    }
    group.tiles.push(tile);
  }

  return [...groups.values()];
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/tessera && pnpm vitest run src/__tests__/depths.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Export it**

In `packages/tessera/src/index.ts`, extend the existing depths export line:

```typescript
export { parseDepths, alignDepthWindow, depthWindowCost, groupTilesByChunk } from './depths.js';
export type { DepthDescriptor, DepthWindow, DepthWindowResult, TileGroup } from './depths.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/tessera/src/depths.ts packages/tessera/src/index.ts packages/tessera/src/__tests__/depths.test.ts
git commit -m "feat(tessera): group tile reads by the chunk grid of the depth being read"
```

---

### Task 2: Full depth needs no declared descriptor

**Files:**
- Modify: `packages/tessera/src/tessera-source.ts` (`fetchDepthWindow`)
- Test: `packages/tessera/src/__tests__/tessera-source.test.ts`

**Interfaces:**
- Consumes: `fetchDepthWindow` (existing).
- Produces: same signature; now accepts `depth === meta.nBands` on any NCHW store, whether or not `geoemb:depths` is declared. This is what lets Task 3 use one code path for every depth.

- [ ] **Step 1: Write the failing test**

```typescript
it('fetchDepthWindow rejects a depth the store does not offer', async () => {
  const source = new TesseraSource({ url: 'https://example.com/zarr' });
  // Store not open: still null, but the guard under test is the descriptor
  // lookup, exercised against a live store in Task 3's verification script.
  const window = await source.fetchDepthWindow({
    depth: 7, r0: 0, c0: 0, height: 8, width: 8,
  });
  expect(window).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it pass for the wrong reason**

Run: `cd packages/tessera && pnpm vitest run src/__tests__/tessera-source.test.ts`
Expected: PASS (store is null). Note it in the commit message: this test pins the guard, and the descriptor-fallback behaviour is verified live in Task 3.

- [ ] **Step 3: Implement the fallback**

In `fetchDepthWindow`, replace the descriptor lookup:

```typescript
    const declared = (this.store.meta.geoemb_depths ?? [])
      .find(d => d.dimensions === depth);
    // Full depth is always readable from the array the store opened with,
    // even when it declares no depths at all.
    const arrayName = declared?.array
      ?? (depth === this.store.meta.nBands ? 'embeddings' : null);
    if (!arrayName) return null;

    const arr = await this.getDepthArray(arrayName);
```

- [ ] **Step 4: Run the full package tests**

Run: `cd packages/tessera && pnpm vitest run`
Expected: PASS, 110 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/tessera/src
git commit -m "feat(tessera): read full depth via fetchDepthWindow without a declared descriptor"
```

---

### Task 3: Depth-aware region loading

**Files:**
- Modify: `packages/tessera/src/tessera-source.ts` (`ensureRegion`, `loadChunks`, new `loadTileGroup`)
- Test: `packages/tessera/src/__tests__/tessera-source.test.ts`
- Create: `scripts/verify-depth-load.mjs`

**Interfaces:**
- Consumes: `groupTilesByChunk` (Task 1), `fetchDepthWindow` (Task 2).
- Produces: `LoadChunksOptions.depth?: number`; `EmbeddingRegion.nBands` equals the loaded depth; `TesseraSource.regionDepth: number | null`.

- [ ] **Step 1: Write the failing tests**

```typescript
it('regionDepth is null before anything is loaded', () => {
  const source = new TesseraSource({ url: 'https://example.com/zarr' });
  expect(source.regionDepth).toBeNull();
});

it('loadChunks with no store leaves the region untouched at any depth', async () => {
  const source = new TesseraSource({ url: 'https://example.com/zarr' });
  await source.loadChunks([{ ci: 0, cj: 0 }], { depth: 16 });
  expect(source.embeddingRegion).toBeNull();
  expect(source.regionDepth).toBeNull();
});
```

- [ ] **Step 2: Run and watch fail**

Run: `cd packages/tessera && pnpm vitest run src/__tests__/tessera-source.test.ts`
Expected: FAIL — `regionDepth` is not a property.

- [ ] **Step 3: Add the depth option and the reallocation rule**

Extend `LoadChunksOptions`:

```typescript
export interface LoadChunksOptions {
  onProgress?: (loaded: number, total: number, chunk: ChunkRef) => void;
  signal?: AbortSignal;
  /**
   * Embedding dimensions to load, from {@link TesseraSource.depths}.
   * Defaults to the store's full depth. A value differing from the live
   * region's width discards that region and reloads at the new depth.
   */
  depth?: number;
}
```

Add the accessor next to `embeddingRegion`:

```typescript
  /** Dimensions the live region was loaded at, or null if none is loaded. */
  get regionDepth(): number | null {
    return this._embeddingRegion?.nBands ?? null;
  }
```

Change `ensureRegion` to take the width it must allocate — replace every
`this.store.meta.nBands` inside it with a new `nBands` parameter, and update
its two call sites (`loadChunks`, `loadSingleChunk`) to pass the depth in
force.

At the top of `loadChunks`, before `ensureRegion`:

```typescript
    const depth = opts?.depth ?? this.store.meta.nBands;
    // A different width means a different buffer: drop the old region rather
    // than mixing depths in one allocation.
    if (this._embeddingRegion && this._embeddingRegion.nBands !== depth) {
      this.clearRegion();
    }
```

- [ ] **Step 4: Replace the per-tile loop with grouped reads**

In `loadChunks`, swap the `loadSingleChunk` call for a grouped path on NCHW
stores, leaving v1 alone:

```typescript
    if (this.store.meta.version === 'v2') {
      const [tileH, tileW] = this.store.meta.chunkShape;
      const arr = await this.getDepthArray(
        (this.store.meta.geoemb_depths ?? []).find(d => d.dimensions === depth)?.array ?? 'embeddings',
      );
      const chunks3 = arr.chunks as number[];
      const groups = groupTilesByChunk(
        chunks, tileH, tileW, chunks3[2], chunks3[3],
        this.store.meta.shape[0], this.store.meta.shape[1],
      );
      // ... iterate groups with the existing concurrency runner, calling
      // loadTileGroup(group, depth, signal) and reporting progress per tile
    }
```

Add the group loader:

```typescript
  /** Read one chunk of the depth array and scatter it into the region. */
  private async loadTileGroup(
    group: TileGroup,
    depth: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const region = this._embeddingRegion;
    if (!region) return;

    const block = await this.fetchDepthWindow({
      depth, r0: group.r0, c0: group.c0,
      height: group.height, width: group.width, signal,
    });
    if (!block) throw new Error(`depth ${depth} is not readable`);

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
    }
  }
```

- [ ] **Step 5: Run the package tests**

Run: `cd packages/tessera && pnpm vitest run && pnpm check`
Expected: PASS, no type errors.

- [ ] **Step 6: Verify against the live store**

Create `scripts/verify-depth-load.mjs`, which is the check that catches a
scatter bug — a misplaced offset produces plausible but wrong embeddings that
no unit test would notice:

```javascript
// Load the same tiles at d16 and at d128 and confirm the shallow values are
// exactly the prefix of the deep ones, pixel by pixel.
import { TesseraSource } from '@ucam-eo/tessera';

const src = new TesseraSource({ url: 'https://data.source.coop/tessera/tessera/zarr/v2-2B-L~beta1/utm30' });
await src.open();
src.setTimeIndex(src.metadata.years.indexOf(2024));

const tiles = [];
for (let ci = 7124; ci < 7128; ci++) for (let cj = 848; cj < 852; cj++) tiles.push({ ci, cj });

await src.loadChunks(tiles, { depth: 16 });
const shallow = src.embeddingRegion;
const d16 = { emb: shallow.emb.slice(), nBands: shallow.nBands, loaded: shallow.loaded.slice() };
console.log(`d16: nBands ${d16.nBands}, ${d16.loaded.filter(Boolean).length}/${tiles.length} tiles`);

await src.loadChunks(tiles, { depth: 128 });
const full = src.embeddingRegion;
console.log(`d128: nBands ${full.nBands}, ${[...full.loaded].filter(Boolean).length}/${tiles.length} tiles`);

const tilePixels = full.tileW * full.tileH;
let compared = 0, mismatched = 0;
for (let t = 0; t < full.loaded.length; t++) {
  if (!full.loaded[t] || !d16.loaded[t]) continue;
  for (let p = 0; p < tilePixels; p++) {
    const deep = (t * tilePixels + p) * full.nBands;
    const shal = (t * tilePixels + p) * d16.nBands;
    if (Number.isNaN(full.emb[deep])) continue;
    for (let b = 0; b < d16.nBands; b++) {
      compared++;
      if (full.emb[deep + b] !== d16.emb[shal + b]) mismatched++;
    }
  }
}
console.log(`${compared - mismatched}/${compared} values identical`);
if (mismatched > 0) { console.error('SCATTER BUG'); process.exit(1); }
```

Run: `cd apps/viewer && node ../../scripts/verify-depth-load.mjs`
Expected: both loads report 16/16 tiles, and every compared value identical.

- [ ] **Step 7: Commit**

```bash
git add packages/tessera scripts/verify-depth-load.mjs
git commit -m "feat(tessera): load regions at a chosen embedding depth"
```

---

### Task 4: Pass depth through the display plugin

**Files:**
- Modify: `packages/maplibre-tessera/src/maplibre-source.ts:282-297`

**Interfaces:**
- Consumes: `LoadChunksOptions.depth` (Task 3).
- Produces: `loadChunkBatch(chunks, onProgress?, opts?: { depth?: number })`.

- [ ] **Step 1: Widen the signature**

```typescript
  async loadChunkBatch(
    chunks: ChunkRef[],
    onProgress?: (loaded: number, total: number, ci: number, cj: number) => void,
    opts?: { depth?: number },
  ): Promise<number> {
    if (chunks.length === 0) return 0;
    this.batchLoading = true;

    await this.source.loadChunks(chunks, {
      depth: opts?.depth,
      onProgress: (loaded, total, chunk) => {
        onProgress?.(loaded, total, chunk.ci, chunk.cj);
      },
    });

    this.batchLoading = false;
    return chunks.length;
  }
```

- [ ] **Step 2: Typecheck and commit**

```bash
pnpm check && git add packages/maplibre-tessera && \
  git commit -m "feat(maplibre-tessera): forward load depth to the data source"
```

---

### Task 5: Depth setting and the Detail control

**Files:**
- Create: `apps/viewer/src/stores/depth.ts`
- Modify: `apps/viewer/src/stores/drawing.ts:47-100`
- Modify: `apps/viewer/src/components/ControlPanel.svelte`

**Interfaces:**
- Consumes: `loadChunkBatch(chunks, onProgress, { depth })` (Task 4).
- Produces: `loadDepth` writable store; `availableDepths` derived store; `addRegion` loading at `get(loadDepth)`.

- [ ] **Step 1: Create the store**

```typescript
import { derived, writable, get } from 'svelte/store';
import { metadata } from './zarr';

/** Depths this store offers, ascending. Empty when it ships only one. */
export const availableDepths = derived(metadata, $m => {
  const depths = $m?.geoemb_depths?.map(d => d.dimensions) ?? [];
  return depths.length > 1 ? depths : [];
});

/** Dimensions new region loads fetch. */
export const loadDepth = writable<number>(0);

/** Default to 16 where offered — most scene structure at an eighth the cost. */
export function resetLoadDepth(): void {
  const depths = get(availableDepths);
  const full = get(metadata)?.nBands ?? 128;
  loadDepth.set(depths.includes(16) ? 16 : full);
}
```

Call `resetLoadDepth()` from `loadCatalog` in `stores/stac.ts`, after
`metadata` is set, so switching datasets re-defaults the depth.

- [ ] **Step 2: Pass the depth when loading a region**

In `addRegion`, capture the depth once so a mid-load change cannot split a
region across two widths, and record it on the region:

```typescript
  const depth = get(loadDepth) || undefined;
  const region: RoiRegion = { id: `roi-${nextId++}`, feature, chunkKeys: [], depth };
  ...
      await displaySrc.loadChunkBatch(chunks, (loaded, _t, ci, cj) => { ... }, { depth });
```

Add `depth?: number` to the `RoiRegion` interface.

- [ ] **Step 3: Add the Detail control**

In `ControlPanel.svelte`, above the region list, rendered only when
`$availableDepths.length > 1`:

```svelte
<div class="flex items-center gap-1.5">
  <span class="text-gray-500 text-[10px] uppercase tracking-[0.15em]">Detail</span>
  {#each $availableDepths as d}
    <button
      onclick={() => loadDepth.set(d)}
      class="px-1.5 py-0.5 rounded text-[10px] transition-colors border
             {$loadDepth === d
               ? 'text-term-cyan border-term-cyan/40 bg-term-cyan/10'
               : 'text-gray-500 border-gray-700/60 hover:text-gray-300'}"
    >d{d}</button>
  {/each}
</div>
```

- [ ] **Step 4: Verify and commit**

```bash
pnpm check && pnpm build
git add apps/viewer/src
git commit -m "feat(viewer): choose the embedding depth new regions load at"
```

---

### Task 6: Upgrade a loaded region to full depth

**Files:**
- Modify: `apps/viewer/src/stores/drawing.ts`
- Modify: `apps/viewer/src/components/ControlPanel.svelte`
- Modify: `apps/viewer/src/components/SimilaritySearch.svelte`

**Interfaces:**
- Consumes: `loadDepth`, `RoiRegion.depth` (Task 5).
- Produces: `upgradeRegions(): Promise<void>` in `drawing.ts`.

- [ ] **Step 1: Implement the upgrade**

```typescript
/**
 * Reload every loaded region at the store's full depth and refresh whatever
 * was derived from the shallow one.
 *
 * Cached vectors — training labels and the similarity reference — were
 * captured at the old width and would not match the new region, so they are
 * re-extracted from their pixel addresses before anything reruns.
 */
export async function upgradeRegions(): Promise<void> {
  const sm = get(sourceManager);
  const full = get(metadata)?.nBands;
  if (!sm || !full) return;

  loadDepth.set(full);
  const regions = get(roiRegions);
  segmentPolygons.set({ type: 'FeatureCollection', features: [] });

  for (const region of regions) {
    await addRegionChunks(region, full);   // same tiles, full depth
    region.depth = full;
  }

  // Re-extract cached vectors at the new width.
  labels.update(ls => ls.map(l => {
    const emb = sm.getEmbeddingAt(l.lngLat[0], l.lngLat[1]);
    return emb ? { ...l, embedding: emb.embedding } : l;
  }));
  const px = get(simSelectedPixel);
  if (px) {
    const emb = sm.getEmbeddingAt(px.lng, px.lat);
    if (emb) simRefEmbedding.set(emb.embedding);
  }
}
```

Factor the per-zone loading loop already in `addRegion` into
`addRegionChunks(region, depth)` so both paths share it rather than
duplicating the zone grouping and progress plumbing.

- [ ] **Step 2: Rerun the analyses**

`SimilaritySearch.svelte` already recomputes when `simRefEmbedding` changes;
confirm its `$effect` covers this and add one if not. For classification,
call the existing rerun path after `upgradeRegions()` resolves when
`$isClassified` is true.

- [ ] **Step 3: Show depth and offer the upgrade**

In the region list in `ControlPanel.svelte`:

```svelte
{#if regionDepth && fullDepth && regionDepth < fullDepth}
  <button onclick={upgradeRegions} class="...">
    Upgrade to d{fullDepth} — {formatBytes(upgradeBytes)}
  </button>
{/if}
```

- [ ] **Step 4: Verify and commit**

```bash
pnpm check && pnpm build
git add apps/viewer/src
git commit -m "feat(viewer): upgrade loaded regions to full depth and rerun analysis"
```

---

### Task 7: Guard the consumers that assume full depth

**Files:**
- Modify: `apps/viewer/src/components/BandMapper.svelte`
- Modify: `apps/viewer/src/components/SegmentPanel.svelte`
- Modify: `apps/viewer/src/stores/drawing.ts:35,55`

**Interfaces:**
- Consumes: `upgradeRegions()` (Task 6), `metadata` (existing).

- [ ] **Step 1: Clamp the band sliders**

A region at d16 has no band 90. In `BandMapper.svelte`, replace the hardcoded
`max="127"` on all three sliders with `max={maxBand}` where:

```typescript
  const maxBand = $derived(Math.max(0, ($sourceManager?.regionDepth ?? $metadata?.nBands ?? 128) - 1));
```

and clamp `r`, `g`, `b` down when `maxBand` shrinks.

- [ ] **Step 2: Gate segmentation**

The UNet declares `in_channels: 128`. In `SegmentPanel.svelte`, replace the
run button when the region is shallow:

```svelte
{#if regionDepth && fullDepth && regionDepth < fullDepth}
  <div class="text-[9px] text-amber-400/80">
    Region loaded at d{regionDepth}; the model needs all {fullDepth} dimensions.
  </div>
  <button onclick={upgradeRegions} class="...">Upgrade to d{fullDepth} — {formatBytes(bytes)}</button>
{:else}
  <!-- existing run button -->
{/if}
```

- [ ] **Step 3: Make the large-region warning byte-based**

256 tiles is 4 MB at d16 and 32 MB at d128, so a tile count is the wrong
threshold. Replace `LARGE_REGION_THRESHOLD = 1000` with a byte budget:

```typescript
/** Warn above this much decoded embedding data for one region. */
const LARGE_REGION_BYTES = 64 * 1024 * 1024;

const bytes = managedChunks.length * tileH * tileW * depth;
if (!skipConfirm && bytes > LARGE_REGION_BYTES && _confirmLargeRegion) { ... }
```

Update `ConfirmModal`'s message in `App.svelte` to report megabytes rather
than a chunk count.

- [ ] **Step 4: Verify and commit**

```bash
pnpm check && pnpm test && pnpm build
git add apps/viewer/src
git commit -m "feat(viewer): clamp bands, gate segmentation, and size warnings by bytes"
```

---

### Task 8: Changeset

**Files:**
- Create: `.changeset/<name>.md`

- [ ] **Step 1: Write it**

```markdown
---
"@ucam-eo/tessera": minor
"@ucam-eo/maplibre-tessera": minor
"viewer": minor
---

Load regions at a chosen embedding depth, and upgrade them on demand

<body: the measured table, the chunk-grid constraint, the segmentation
requirement, and the re-extraction rule>
```

- [ ] **Step 2: Final verification and commit**

```bash
pnpm check && pnpm test && pnpm build
node scripts/verify-depth-load.mjs
git add .changeset && git commit -m "docs: changeset for progressive embedding depth"
```

---

## Self-Review

**Spec coverage:** chunk-grouped loading (Tasks 1, 3), depth as a load option
(Task 3), region reallocation as the upgrade mechanism (Task 3), package API
(Tasks 1–4), upgrade flow with re-extraction and rerun (Task 6), viewer
control and defaults (Task 5), per-region depth display and upgrade button
(Task 6), band clamping, segmentation gate, byte-based warning (Task 7),
live prefix-equality verification (Task 3 Step 6). No spec section is
unimplemented.

**Placeholders:** none — every step carries the code it needs. Task 6 Step 2
names the existing rerun paths rather than restating them, since they are
already-working code the executor will read in place.

**Type consistency:** `groupTilesByChunk` returns `TileGroup[]` (Task 1) and
is consumed with that name in Task 3. `LoadChunksOptions.depth` (Task 3) is
what Task 4 forwards and Task 5 supplies. `regionDepth` (Task 3) is the
accessor Tasks 6 and 7 read. `upgradeRegions()` (Task 6) is what Task 7's
buttons call.
