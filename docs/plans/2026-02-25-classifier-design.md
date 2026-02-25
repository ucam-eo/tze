# Browser-Based Tile Classification with TF.js KNN

**Date:** 2026-02-25
**Status:** Approved

## Summary

Port the tessera-interactive-map labeling/classification workflow to run entirely in the browser using TensorFlow.js KNN. Users double-click tiles to fetch full 128-d embeddings, click to place labeled training points, then classify all loaded tiles with a KNN model. Classification overlays render as solid-color-per-class RGBA canvases on the map.

## Architecture

Three new layers added to TZE:

1. **Embedding cache** — double-clicking a tile fetches its full 128-d Int8 embeddings + Float32 scales, stored in a `Map<string, TileEmbeddings>` keyed by `"ci,cj"`.
2. **Label store** — user-placed points, each storing the 128-d embedding vector at that pixel, a class name, and a color.
3. **KNN classifier** — `@tensorflow-models/knn-classifier` trained incrementally from labeled embeddings, applied per-tile to produce classification overlays.

```
Double-click tile → fetch embeddings (128-d Int8 + scales)
                  → store in embeddingCache

Click on loaded tile → lookup pixel → extract 128-d vector
                     → add to classifier + label store

Classify → for each tile with embeddings:
           → batch classify all pixels → render RGBA overlay
           → add as MapLibre image source above data layer
```

## Plugin Changes (zarr-source.ts)

- **`dblclick` handler** on map: converts click LngLat → UTM → chunk `(ci, cj)` → calls `loadFullChunk()`. Stores raw embeddings in public `embeddingCache` Map.
- **`getEmbeddingAt(lngLat)`**: given a map coordinate, returns the 128-d Float32 embedding vector from the cached chunk.
- **`getChunkAtLngLat(lngLat)`**: returns `{ci, cj}` for a given coordinate, or null.
- **`addClassificationOverlay(ci, cj, canvas)`** / **`clearClassificationOverlays()`**: manages classification image layers on the map, positioned above data layers but below grid/UTM overlays.
- **`'embeddings-loaded'` event**: emitted after double-click loads embeddings for a chunk.

## New Types (types.ts)

```typescript
interface TileEmbeddings {
  ci: number;
  cj: number;
  emb: Int8Array;         // [h * w * nBands]
  scales: Float32Array;   // [h * w]
  width: number;
  height: number;
  nBands: number;
}

interface LabelPoint {
  lngLat: [number, number];
  ci: number;
  cj: number;
  row: number;
  col: number;
  classId: number;
  embedding: Float32Array; // 128-d
}

interface ClassDef {
  name: string;
  color: string;  // hex
  id: number;
}
```

## New Components

### LabelPanel.svelte

New collapsible section in the right-side control panel:

```
▼ CLASSIFIER

Classes
┌─────────────────────────────┐
│ ■ Water       3 pts    [×] │
│ ■ Forest     12 pts    [×] │
│ ■ Urban       5 pts    [×] │
└─────────────────────────────┘

[+ Add class]
┌──────────────┐ ┌──────┐
│ Class name   │ │ ■ #c │
└──────────────┘ └──────┘

Active: ● Water (click row to set)
Kernel: [1] [3] [5] [7] [9]

k = [══●═════════] 5
Confidence [═══●══] 0.50

[ CLASSIFY ]  [ CLEAR ]

Double-click tile to load
embeddings, then click to label
```

**Interaction modes:**
- Default: pan/zoom
- Labeling active (class selected): click on tile with loaded embeddings → place label. Cursor → crosshair.
- Double-click any tile: fetch full embeddings, flash tile border.

**Kernel size** (matching Python "scales"): labels NxN pixels around click. Buttons 1/3/5/7/9, default 1.

**Label markers**: small colored circles on map. Click marker to remove.

### Classifier Store (stores/classifier.ts)

```typescript
// State
activeClass: string | null
classes: Map<string, ClassDef>
labels: LabelPoint[]
k: number                    // default 5
confidenceThreshold: number  // default 0.5
kernelSize: number           // 1, 3, 5, 7, or 9
isClassified: boolean

// Actions
addClass(name: string, color: string)
removeClass(name: string)
addLabel(lngLat, embedding, ci, cj, row, col, classId)
removeLabel(index: number)
classify(embeddingCache, zarrSource): Promise<void>
clearClassification()
exportLabels(): string  // JSON
importLabels(json: string)
```

## Data Flows

### Double-Click → Load Embeddings

1. User double-clicks map
2. `zarr-source.ts` dblclick handler:
   - `e.lngLat` → `proj.forward()` → UTM easting/northing
   - UTM → chunk indices `(ci, cj)`
   - `loadFullChunk(ci, cj)` fetches emb + scales via zarr-reader
   - Store in `embeddingCache.set("ci,cj", { emb, scales, width, height, nBands, ci, cj })`
   - Emit `'embeddings-loaded'` event
   - Flash tile border via temporary highlight layer

### Click → Place Label

1. User clicks map with active class selected
2. App click handler calls `zarrSource.getEmbeddingAt(lngLat)`:
   - LngLat → UTM → pixel `(row, col)` → chunk `(ci, cj)`
   - Check `embeddingCache` — if not loaded, ignore (toast: "double-click to load first")
   - Read `emb[pixelIndex * nBands .. + nBands]` → Float32Array(128)
   - Return `{ embedding, ci, cj, row, col }`
3. Apply kernel: for each pixel in NxN around `(row, col)`:
   - Extract embedding, add to classifier store
4. Add colored CircleMarker to map
5. Update point count in LabelPanel

### Classify All Loaded Tiles

1. User clicks CLASSIFY
2. Classifier store:
   - Create `knnClassifier`, add all labeled embeddings as `tf.tensor1d`
   - For each tile in `embeddingCache`:
     - For each valid pixel (scales != 0, != NaN):
       - `predictClass(tf.tensor1d(embedding), k)` → class + confidence
     - Build RGBA canvas: class color if confidence >= threshold, grey otherwise
   - Pass each `(ci, cj, canvas)` to `zarrSource.addClassificationOverlay()`
3. Overlays positioned above data layers, below grid/UTM

## Classification Visualization

- Solid class color per pixel at configurable overlay opacity
- Confidence threshold slider: pixels below threshold rendered grey
- Classification overlay opacity independent of data layer opacity
- Legend shown in LabelPanel matching class colors

## Dependencies

Added to `apps/viewer/package.json` only (plugin stays dependency-light):

- `@tensorflow/tfjs-core` — tensor operations
- `@tensorflow/tfjs-backend-webgl` — GPU acceleration
- `@tensorflow-models/knn-classifier` — KNN implementation

## Persistence

- `exportLabels()` / `importLabels()` for JSON save/load of:
  - Class definitions (name, color, id)
  - Label points (lngLat, classId — embeddings re-fetched on load)
  - k and confidence threshold settings
