# Progressive embedding depth for region loading

**Date:** 2026-08-24
**Status:** design, awaiting review

## Problem

Drawing a region loads full 128-dimensional embeddings for every tile in it.
That is what similarity, classification, and segmentation consume, and it sets
both the download size and the ceiling on how large a region can be:

| 512×512 px ROI (~26 km²) | download | region buffer (float32) |
| --- | --- | --- |
| d128 | 32.0 MB | 134 MB |

Stores that declare `geoemb:depths` — TESSERA v2 ships `embeddings_d4`,
`embeddings_d16` and `embeddings` — carry byte-exact prefixes of the same
vectors, so the same region can be loaded at a fraction of that:

| 512×512 px ROI | chunks | download | region buffer |
| --- | --- | --- | --- |
| d4 | 16 | **1.0 MB** | 4 MB |
| d16 | 64 | **4.0 MB** | 17 MB |
| d128 | 256 | 32.0 MB | 134 MB |

Similarity and classification produce useful results at d16 (see *Prior
measurements*), so most exploratory work does not need the full read. The goal
is to load regions at a chosen depth, defaulting to d16, and let the user
upgrade a loaded region to full depth and rerun their analysis.

## Constraints

These were measured against `v2-2B-L~beta1`, not assumed.

### Shallow depths must be read on their own chunk grid

The region's tile grid is 32×32 px, taken from the `embeddings` array's inner
chunk shape `[1, 128, 32, 32]`. The shallow arrays are chunked differently —
`[1, 16, 64, 64]` and `[1, 4, 128, 128]` — each chunk holding ~64 KB either
way. Reading a 32×32 tile from `embeddings_d16` therefore decodes a whole
64×64 chunk and discards three quarters of it:

```
cost of ONE 32×32 store tile, read at each depth:
  d4    1 chunk =  64 KB for 1024 px  →  64 B/px
  d16   1 chunk =  64 KB for 1024 px  →  64 B/px
  d128  1 chunk = 128 KB for 1024 px  → 128 B/px

the same pixels read on each depth's own chunk grid:
  d4   128×128 px: 1 chunk =  64 KB for 16384 px  →   4 B/px
  d16   64×64 px:  1 chunk =  64 KB for  4096 px  →  16 B/px
  d128  32×32 px:  1 chunk = 128 KB for  1024 px  → 128 B/px
```

Tile-at-a-time loading would deliver a 2× saving at d16 instead of 8×. The
loader must group tiles into whole chunks of the depth being read.

### Upgrading is a full re-read, not a top-up

An inner chunk of `embeddings` holds all 128 bands, so slicing bands 16–127
decodes exactly as many bytes as slicing all of them. There is no cheap "add
the missing dimensions" path. The waste is bounded and small: loading d16 and
then upgrading costs 1.125× of going straight to d128.

### Segmentation cannot run below full depth

`solar_unet_stats.json` declares `in_channels: 128` and carries 128-element
mean/std vectors. The UNet has no shallow variant, so the Segment tool must
require a full-depth region.

### Analysis is otherwise already depth-agnostic

`similarity.ts`, `classify.ts` and `umap-subsample.ts` all read
`region.nBands` dynamically; none hardcode 128. They need no changes to work
at d16.

### Training labels cache their vector

`LabelPoint.embedding` is captured when a label is placed, and `classifyRegion`
takes `dim` from it. After a depth change the labels and the region disagree
and the TF.js matmul throws. Labels carry `lngLat` and `ci/cj/row/col`, so they
can be re-extracted rather than discarded.

### Prior measurements

From the explorer's depth panel, over a 128×128 px window near Madrid at 2024:

- Bands 0–2 — the RGB preview — are byte-identical at every depth.
- The deviance map at d16 correlates r=0.88 with the full-depth map; d4, 0.64.
- A similarity search truncated to d16 returns 39% of the full-depth top-100;
  at d4, 3%.

d16 is the default because it preserves most scene structure at ⅛ the cost.
It is not a free lunch for similarity, which is why upgrading is one click.

## Design

### Depth is a property of the load

`TesseraSource` stays stateless about depth; the caller passes it per load.

```ts
interface LoadChunksOptions {
  depth?: number;      // defaults to the store's full depth
  onProgress?: (loaded: number, total: number, chunk: ChunkRef) => void;
  signal?: AbortSignal;
}
```

`EmbeddingRegion.nBands` becomes the depth the region was loaded at. Nothing
else about the region changes: it keeps the canonical 32×32 tile grid, so
`ci/cj` keys, `ClassificationStore`, the display overlays and every existing
consumer are untouched.

`ensureRegion` allocates from the requested depth rather than
`meta.nBands`. A `loadChunks` call whose depth differs from the live region's
`nBands` clears and reallocates the region first — that single rule is the
whole upgrade mechanism.

### Chunk-grouped loading

New internal step in `loadChunks`, replacing the tile-at-a-time loop:

1. Resolve the depth's array handle and read its spatial chunk shape
   (`arr.chunks[2]`, `arr.chunks[3]`).
2. Group the requested tiles by which chunk of that array they fall in.
3. Per group, issue one read covering that chunk's pixel extent (clipped to
   the array bounds), dequantise it, and scatter only the requested tiles into
   the region.
4. Emit `embedding-progress` and `loading` per requested tile as its group
   lands, preserving the current event contract.

At full depth a group is exactly one tile, so the request pattern is
byte-for-byte what it is today.

The grouping is a pure function and is where the correctness risk lives:

```ts
export function groupTilesByChunk(
  tiles: ChunkRef[],
  tileH: number, tileW: number,
  chunkH: number, chunkW: number,
): Array<{ r0: number; c0: number; height: number; width: number; tiles: ChunkRef[] }>
```

### Package API

`@ucam-eo/tessera`
- `LoadChunksOptions.depth?: number`.
- `groupTilesByChunk()` exported for testing and reuse.
- `TesseraSource.fetchDepthWindow()` already exists and supplies the read.

`@ucam-eo/maplibre-tessera`
- `loadChunkBatch(chunks, onProgress, opts?: { depth?: number })`, forwarded.

`@ucam-eo/tessera-tasks` — unchanged.

### Upgrade flow

A region records the depth it was loaded at. "Upgrade to full depth" then:

1. Reloads the same tiles at the store's full depth (region reallocates).
2. Re-extracts every `LabelPoint.embedding` from the new region by its
   `lngLat`, so training data matches the region's width.
3. Re-extracts `simRefEmbedding` from `simSelectedPixel`, for the same reason.
4. Reruns whichever analysis has results: similarity scores, classification,
   UMAP projection.

Anything not rerun is cleared rather than left stale. Segment polygons are
cleared on any depth change.

### Viewer

- New `loadDepth` store, defaulting to 16 when the store offers it and full
  depth otherwise. Persisted in the URL alongside `?store=`, so a shared link
  reproduces the same load.
- A "Detail" control in the sidebar near the region list: `d4 · d16 · d128`,
  applying to subsequent loads. Hidden for stores with a single depth.
- The region list shows each region's depth and download size, with an
  "Upgrade to d128" button carrying the cost (`32 MB`).
- `BandMapper`'s sliders clamp to `nBands - 1`; a region at d16 cannot map
  band 90 to green.
- The Segment panel replaces its run button with "Segmentation needs full
  depth — upgrade (32 MB)" when the region is shallow.
- The large-region confirmation threshold becomes byte-based rather than
  tile-based, since 256 tiles at d16 is 4 MB and at d128 is 32 MB.

## Not changing

- The explorer's depth panel, which reads its own window independently.
- `global_rgb` preview rendering.
- The segmentation model, or any attempt to make it accept fewer channels.
- `EmbeddingRegion`'s layout, tile grid, or NaN convention.

## Testing

`@ucam-eo/tessera`, test-first:
- `groupTilesByChunk`: tiles inside one chunk group together; tiles spanning
  chunks split; a full-depth grid yields one tile per group; groups clip at the
  array edge; a sparse tile selection does not pull in unrequested tiles.
- Region reallocation when a load's depth differs from the live region.
- `LoadChunksOptions.depth` defaulting to full depth.

Live verification against `v2-2B-L~beta1`, as with `fetchDepthWindow`: load the
same tiles at d16 and at d128 and confirm the d16 values equal the d128 prefix,
and that the byte counts match the table above.

The viewer has no test runner, so its wiring is covered by `pnpm check`,
`pnpm build`, and manual use.

## Risks

- **Scatter-path bugs corrupt embeddings silently.** A misplaced offset yields
  plausible-looking but wrong analysis. Mitigated by the live prefix-equality
  check, which compares a shallow load against a full one pixel by pixel.
- **Depth changes leave stale derived state.** Every consumer of
  `region.nBands` must be re-derived or cleared; the invalidation list above is
  the contract, and anything missed shows up as a dimension-mismatch throw
  rather than a wrong answer.
- **d16 may disappoint for similarity.** 39% top-100 overlap is a real
  degradation. The UI should present d16 as "explore cheaply, upgrade to
  confirm" rather than as an equivalent result.
- **Progress reporting granularity changes.** Tiles now land in groups of up
  to 16, so the progress bar advances in steps at shallow depths.

## Open questions

None blocking. Two worth revisiting after use:

- Whether d4 is worth exposing at all, given 3% similarity overlap — it may be
  better as a preview-only depth.
- Whether upgrade should stream in the background rather than block, once the
  basic flow is in use.
