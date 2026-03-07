# Design: Extract tessera-tasks Library

## Goal

Split the TZE monorepo into three clean layers:

1. `@ucam-eo/maplibre-zarr-tessera` — MapLibre GL plugin (tile rendering, embeddings) [existing]
2. `@ucam-eo/tessera-tasks` — analysis algorithms + bundled model [new]
3. `apps/viewer` — Svelte UI consuming both [updated]

## Package: `@ucam-eo/tessera-tasks`

### Scope

Three analysis modules plus bundled ONNX model and a Vite plugin for ORT WASM.

### Exports

```typescript
// --- Similarity ---
export interface SimilarityResult {
  scores: Float32Array
  gridRows: number; gridCols: number
  tileW: number; tileH: number
  ciMin: number; cjMin: number
  loaded: Uint8Array
}
export function computeSimilarityScores(region: EmbeddingRegion, refEmbedding: Float32Array): SimilarityResult
export function renderSimilarityCanvas(result: SimilarityResult, threshold: number, canvas?: HTMLCanvasElement): HTMLCanvasElement

// --- Classification ---
export interface ClassDef { name: string; color: string }
export interface LabelPoint { lng: number; lat: number; className: string; embedding: Float32Array }
export interface ClassifyProgress { done: number; total: number; phase: string }
export interface ClassificationResult {
  ci: number; cj: number
  canvas: HTMLCanvasElement
  classMap: Int16Array
  stats: { total: number; classified: number; uncertain: number }
}
export function classifyTiles(
  region: EmbeddingRegion,
  labelPoints: LabelPoint[],
  classDefs: ClassDef[],
  k: number,
  confidenceThreshold: number,
  onProgress?: (p: ClassifyProgress) => void,
  onBatchUpdate?: (ci: number, cj: number, canvas: HTMLCanvasElement, classMap: Int16Array, w: number, h: number) => void
): Promise<ClassificationResult[]>

// --- Segmentation ---
export interface SegmentResult {
  ci: number; cj: number
  polygons: GeoJSON.Feature<GeoJSON.Polygon>[]
}
export class SegmentationSession {
  constructor()
  run(region: EmbeddingRegion, source: ZarrTesseraSource, threshold?: number, onProgress?: (done: number, total: number) => void): Promise<SegmentResult[]>
  rethreshold(threshold: number): SegmentResult[]
  clear(): void
  get hasCachedProbabilities(): boolean
}

// --- Vite Plugin ---
export function ortWasmPlugin(): import('vite').Plugin
```

### Dependencies

| Package | Used by |
|---------|---------|
| `@ucam-eo/maplibre-zarr-tessera` | All (EmbeddingRegion type); segment (ZarrTesseraSource) |
| `@tensorflow/tfjs-core` | classify |
| `@tensorflow/tfjs-backend-webgl` | classify |
| `onnxruntime-web` | segment |

### Bundled Assets

- `models/solar_unet.onnx` (213K)
- `models/solar_unet_stats.json` (5K)

### Vite Plugin: `ortWasmPlugin`

Moves from `apps/viewer/vite.config.ts` inline plugin into the library. Copies ORT WASM files from `onnxruntime-web` into the app's public directory and serves `.mjs` files with correct MIME types during dev.

### Build

Vite library mode, ESM output. Externalizes all dependencies (tfjs, onnx, maplibre-zarr-tessera). Model files copied to `dist/models/`.

## Package: `@ucam-eo/maplibre-zarr-tessera`

No API changes. Already well-structured.

## App: `apps/viewer`

### Import Changes

| Before | After |
|--------|-------|
| `from '../lib/similarity'` | `from '@ucam-eo/tessera-tasks'` |
| `from '../lib/classify'` | `from '@ucam-eo/tessera-tasks'` |
| `from '../lib/segment'` | `from '@ucam-eo/tessera-tasks'` |
| `ClassDef, LabelPoint` defined in `stores/classifier.ts` | Imported from `@ucam-eo/tessera-tasks` |
| ORT WASM plugin inline in `vite.config.ts` | `import { ortWasmPlugin } from '@ucam-eo/tessera-tasks'` |

### SegmentPanel Changes

Current module-level functions (`runSolarSegmentation`, `rethreshold`, `clearSegmentation`, `hasCachedProbabilities`) replaced by a `SegmentationSession` instance stored in component or store state.

### What Stays in the Viewer

- All Svelte stores (UI state management)
- All components
- `osm-sampler.ts`, `overpass.ts` (OSM workflow utilities)
- `umap-worker.ts`, `umap-subsample.ts`, `point-cloud-renderer.ts` (visualization)
- Tutorials

## Build Order

```
maplibre-zarr-tessera -> tessera-tasks -> viewer
```

## Monorepo Layout After

```
packages/
  maplibre-zarr-tessera/   # MapLibre plugin
  tessera-tasks/           # Analysis algorithms + model + vite plugin
apps/
  viewer/                  # Svelte UI
```
