# V1 Zarr Migration + Terra Draw Integration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the tze viewer from geotessera v0 to v1 sharded zarr stores, and add terra-draw polygon drawing for spatial queries.

**Architecture:** The v1 stores use zarr v3 sharding (256×256 shards with 4×4 inner chunks, blosc-zstd compression). zarrita 0.6.1 already handles sharding transparently — the main changes are STAC item property updates, removing the chunk manifest dependency, and adapting the catalog URL. Terra-draw provides a MapLibre adapter for polygon/rectangle drawing that replaces the current click-based pixel selection with spatial region queries.

**Tech Stack:** zarrita 0.6.1 (existing), terra-draw + terra-draw-maplibre-gl-adapter (new), Svelte 5, MapLibre GL JS, TF.js (classify only)

---

## Background

### V0 → V1 differences

| Aspect | V0 | V1 |
|--------|----|----|
| Chunk layout | Flat 256×256 uncompressed | Sharded: 256×256 outer, 4×4 inner |
| Compression | None | blosc-zstd level 3 |
| Chunk manifest | `_chunk_manifest.json` | Not needed (empty shards don't exist) |
| STAC item props | `has_rgb_preview`, `has_pca_preview` | `has_rgb_preview` only, no pca field |
| Catalog path | `/zarr/v0/catalog.json` | `/zarr/v1/catalog.json` |
| Dataset version attr | None | `tessera_dataset_version: "v1"` |
| RGB preview | Available | Not yet built (`has_rgb_preview: false`) |
| Store dimensions | ~256×256 chunks | Same shard size, but much smaller HTTP fetches for point queries |

### V1 zarr.json examples

**Group metadata** (`utm30_2025.zarr/zarr.json`):
```json
{
  "zarr_format": 3, "node_type": "group",
  "attributes": {
    "utm_zone": 30, "year": 2025, "crs_epsg": 32630,
    "transform": [10.0, 0.0, 167440.0, 0.0, -10.0, 6753840.0],
    "pixel_size_m": 10.0, "geotessera_version": "0.7.5",
    "tessera_dataset_version": "v1", "n_tiles": 8923
  }
}
```

**Embeddings array** (`embeddings/zarr.json`):
```json
{
  "shape": [616960, 59648, 128], "data_type": "int8",
  "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": [256, 256, 128] } },
  "codecs": [{
    "name": "sharding_indexed",
    "configuration": {
      "chunk_shape": [4, 4, 128],
      "codecs": [{ "name": "bytes" }, { "name": "blosc", "configuration": { "cname": "zstd", "clevel": 3, "shuffle": "bitshuffle" } }],
      "index_codecs": [{ "name": "bytes", "configuration": { "endian": "little" } }, { "name": "crc32c" }],
      "index_location": "end"
    }
  }]
}
```

### V1 STAC structure

```
/zarr/v1/
├── catalog.json                          → links to geotessera-2025/collection.json
├── geotessera-2025/
│   ├── collection.json                   → links to utm{29,30,31}_2025 items
│   ├── utm29_2025/utm29_2025.json        → asset href: ../../utm29_2025.zarr
│   ├── utm30_2025/utm30_2025.json
│   └── utm31_2025/utm31_2025.json
├── utm29_2025.zarr/
├── utm30_2025.zarr/
├── utm31_2025.zarr/
└── global_rgb_2025.zarr/
```

### Terra-draw setup pattern

```typescript
import { TerraDraw, TerraDrawPolygonMode, TerraDrawRectangleMode } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';

// After map load:
const draw = new TerraDraw({
  adapter: new TerraDrawMapLibreGLAdapter({ map, lib: maplibregl }),
  modes: [new TerraDrawPolygonMode(), new TerraDrawRectangleMode()],
});
draw.start();
draw.setMode('polygon');

// Get drawn features:
draw.on('finish', (id, ctx) => {
  if (ctx.action === 'draw') {
    const feature = draw.getSnapshotFeature(id);
    // feature.geometry is a GeoJSON Polygon
  }
});
```

---

## Task 1: Update catalog URL to v1

**Files:**
- Modify: `apps/viewer/src/stores/stac.ts:7`

**Step 1: Change the default catalog URL**

The store currently defaults to `/zarr/v1/catalog.json` (already updated by user). Verify this is correct:

```typescript
// apps/viewer/src/stores/stac.ts line 7
export const catalogUrl = writable('/zarr/v1/catalog.json');
```

**Step 2: Verify proxy mapping still works**

The vite proxy maps `/zarr` → `http://localhost:9999`, and httpz-perma-proxy maps `/zarr` → `https://dl2.geotessera.org/zarr`. Since v1 lives at `/zarr/v1/...`, the same prefix works. No config changes needed.

**Step 3: Run build to verify**

Run: `pnpm run build`
Expected: Builds successfully (the STAC walker code is generic — it follows links, doesn't assume v0 paths).

**Step 4: Commit**

```bash
git add apps/viewer/src/stores/stac.ts
git commit -m "feat: switch catalog URL to v1"
```

---

## Task 2: Remove chunk manifest dependency

**Files:**
- Modify: `packages/maplibre-zarr-tessera/src/zarr-reader.ts:50-72`
- Modify: `packages/maplibre-zarr-tessera/src/zarr-source.ts` (grep for `chunkManifest`)

V1 stores don't have `_chunk_manifest.json`. The manifest was used to skip chunks known to be empty. With sharded zarr v3, empty shards simply return 404 or empty data — zarrita handles this gracefully. The manifest fetch silently 404s anyway (wrapped in try/catch), but we should clean up the logic that depends on it.

**Step 1: Make manifest optional in zarr-reader.ts**

In `packages/maplibre-zarr-tessera/src/zarr-reader.ts`, the manifest fetch (lines 50-72) is already wrapped in try/catch. No change needed to the fetch — it gracefully handles 404. But we should stop relying on it for has_rgb/has_pca detection since v1 items provide this info through STAC properties.

Leave the manifest code as-is (it's harmless) but note that v1 stores will always have `chunkManifest: null`.

**Step 2: Verify chunk loading still works without manifest**

The manifest is used in `zarr-source.ts` to skip chunks known to be empty. Search for `chunkManifest` usage:

```bash
grep -n 'chunkManifest' packages/maplibre-zarr-tessera/src/zarr-source.ts
```

If it's used as a guard (`if (manifest && !manifest.has(key)) return;`), chunks without a manifest will simply attempt to load and handle the empty/404 case. This is correct for v1.

**Step 3: Run build to verify**

Run: `pnpm run build`
Expected: PASS

**Step 4: Commit**

```bash
git commit -m "docs: note v1 stores don't require chunk manifest" --allow-empty
```

---

## Task 3: Handle missing RGB preview gracefully

**Files:**
- Modify: `packages/maplibre-zarr-tessera/src/zarr-reader.ts:34-48`
- Modify: `apps/viewer/src/lib/stac.ts:81-96` (global preview probe)

V1 STAC items report `has_rgb_preview: false`. The zarr-reader already wraps RGB/PCA array opens in try/catch, so this works. But the global preview probe in `stac.ts` tries to fetch `global_rgb_2025.zarr/zarr.json` — this exists for v1 too.

**Step 1: Verify the global preview probe path**

The v1 server has `global_rgb_2025.zarr/` at `/zarr/v1/global_rgb_2025.zarr/`. The probe in `stac.ts` line 81 constructs:
```typescript
const candidateUrl = `${baseUrl}global_rgb_${latestYear}.zarr`;
```
Where `baseUrl` = `http://localhost:5173/zarr/v1/`. This produces `http://localhost:5173/zarr/v1/global_rgb_2025.zarr` — correct.

**Step 2: Verify the viewer handles no RGB in zone stores**

When `hasRgb: false`, the preview mode dropdown should not offer 'rgb'. Check `BandMapper.svelte` or wherever preview mode is selected. If it defaults to 'rgb' and the store has no RGB, it should fall back to 'bands'.

Read the relevant component and verify the fallback logic. If missing, add:
```typescript
// In the preview mode selector, disable 'rgb' when !$metadata?.hasRgb
```

**Step 3: Run build and test**

Run: `pnpm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "fix: handle missing RGB preview in v1 stores"
```

---

## Task 4: Install terra-draw

**Files:**
- Modify: `apps/viewer/package.json`

**Step 1: Install packages**

```bash
cd apps/viewer
pnpm add terra-draw terra-draw-maplibre-gl-adapter
```

**Step 2: Verify build**

Run: `pnpm run build`
Expected: PASS (no imports yet, just dependency)

**Step 3: Commit**

```bash
git add apps/viewer/package.json pnpm-lock.yaml
git commit -m "deps: add terra-draw and maplibre adapter"
```

---

## Task 5: Add 'draw' tool type and store

**Files:**
- Modify: `apps/viewer/src/stores/tools.ts`
- Create: `apps/viewer/src/stores/drawing.ts`

**Step 1: Extend ToolId type**

```typescript
// apps/viewer/src/stores/tools.ts
import { writable } from 'svelte/store';

export type ToolId = 'similarity' | 'classifier' | 'segmenter' | 'draw';

export const activeTool = writable<ToolId>('similarity');
```

**Step 2: Create drawing store**

```typescript
// apps/viewer/src/stores/drawing.ts
import { writable } from 'svelte/store';

export type DrawMode = 'polygon' | 'rectangle';

/** Active terra-draw mode */
export const drawMode = writable<DrawMode>('polygon');

/** GeoJSON features drawn by the user */
export const drawnFeatures = writable<GeoJSON.Feature[]>([]);
```

**Step 3: Run build**

Run: `pnpm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/viewer/src/stores/tools.ts apps/viewer/src/stores/drawing.ts
git commit -m "feat: add draw tool type and drawing store"
```

---

## Task 6: Create DrawPanel component

**Files:**
- Create: `apps/viewer/src/components/DrawPanel.svelte`

This is the sidebar panel for the draw tool — mode selector (polygon/rectangle), feature list, clear button.

**Step 1: Create DrawPanel.svelte**

```svelte
<script lang="ts">
  import { Pencil, Square, Trash2 } from 'lucide-svelte';
  import { drawMode, drawnFeatures, type DrawMode } from '../stores/drawing';

  const modes: { id: DrawMode; label: string; icon: typeof Pencil }[] = [
    { id: 'polygon',   label: 'Polygon',   icon: Pencil },
    { id: 'rectangle', label: 'Rectangle', icon: Square },
  ];

  function handleClear() {
    $drawnFeatures = [];
  }
</script>

<div class="space-y-3">
  <div class="flex gap-1">
    {#each modes as m}
      <button
        onclick={() => { $drawMode = m.id; }}
        class="flex-1 flex items-center justify-center gap-1.5 text-[10px] px-2 py-1.5 rounded
               border transition-all
               {$drawMode === m.id
                 ? 'bg-term-cyan/20 text-term-cyan border-term-cyan/40'
                 : 'text-gray-500 border-gray-700/60 hover:text-gray-300'}"
      >
        <m.icon size={11} />
        {m.label}
      </button>
    {/each}
  </div>

  {#if $drawnFeatures.length > 0}
    <div class="text-[10px] text-gray-500">
      {$drawnFeatures.length} region{$drawnFeatures.length !== 1 ? 's' : ''} drawn
    </div>
    <button
      onclick={handleClear}
      class="w-full flex items-center justify-center gap-1.5 text-[10px] text-gray-500
             hover:text-red-400 px-2 py-1.5 rounded border border-gray-700/60
             hover:border-red-400/40 transition-all"
    >
      <Trash2 size={11} />
      Clear all
    </button>
  {:else}
    <div class="text-[9px] text-gray-700 leading-relaxed">
      Draw a polygon or rectangle on the map to select a region for analysis.
    </div>
  {/if}
</div>
```

**Step 2: Run build**

Run: `pnpm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/viewer/src/components/DrawPanel.svelte
git commit -m "feat: add DrawPanel component"
```

---

## Task 7: Wire DrawPanel into ToolSwitcher

**Files:**
- Modify: `apps/viewer/src/components/ToolSwitcher.svelte`

**Step 1: Add draw tab**

Add import and tab entry:

```typescript
// Add to imports
import { PenTool } from 'lucide-svelte';
import DrawPanel from './DrawPanel.svelte';
```

Add to the `tools` array:
```typescript
const tools: { id: ToolId; label: string; icon: typeof Search }[] = [
  { id: 'similarity', label: 'Similar', icon: Search },
  { id: 'classifier', label: 'Classify', icon: Tags },
  { id: 'segmenter',  label: 'Segment', icon: Scan },
  { id: 'draw',       label: 'Draw',    icon: PenTool },
];
```

Add to the panel section (after the segmenter conditional):
```svelte
{:else if $activeTool === 'draw'}
  <DrawPanel />
```

**Step 2: Run build**

Run: `pnpm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/viewer/src/components/ToolSwitcher.svelte
git commit -m "feat: wire DrawPanel into tool switcher"
```

---

## Task 8: Initialize terra-draw on the map

**Files:**
- Modify: `apps/viewer/src/App.svelte`

**Step 1: Add terra-draw initialization**

Add imports at the top of the `<script>` block:
```typescript
import { TerraDraw, TerraDrawPolygonMode, TerraDrawRectangleMode } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import { drawMode, drawnFeatures } from './stores/drawing';
```

Add a module-level variable:
```typescript
let terraDraw: TerraDraw | undefined = $state();
```

Inside the existing `map.on('load', ...)` callback (after all the existing layer setup), add:
```typescript
      // Initialize terra-draw
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map, lib: maplibregl }),
        modes: [new TerraDrawPolygonMode(), new TerraDrawRectangleMode()],
      });
      draw.start();
      terraDraw = draw;

      draw.on('finish', (id: string, ctx: { action: string }) => {
        if (ctx.action === 'draw') {
          const feat = draw.getSnapshotFeature(id);
          if (feat) {
            drawnFeatures.update(fs => [...fs, feat]);
          }
        }
      });
```

**Step 2: Add reactive effect to sync draw mode**

Add an `$effect` block that activates/deactivates terra-draw based on the active tool and draw mode:

```typescript
  // Sync terra-draw mode with active tool
  $effect(() => {
    if (!terraDraw) return;
    const tool = $activeTool;
    const mode = $drawMode;

    if (tool === 'draw') {
      terraDraw.setMode(mode);
    } else {
      terraDraw.setMode('static');
    }
  });

  // Sync drawn features → clear terra-draw when store is cleared
  $effect(() => {
    const features = $drawnFeatures;
    if (terraDraw && features.length === 0) {
      terraDraw.clear();
    }
  });
```

**Step 3: Update cursor logic**

In the existing cursor `$effect`, add the draw tool:
```typescript
  $effect(() => {
    const map = $mapInstance;
    if (!map) return;
    const canvas = map.getCanvasContainer();
    if ($activeTool === 'similarity') {
      canvas.style.cursor = 'crosshair';
    } else if ($activeTool === 'classifier' && $activeClass) {
      canvas.style.cursor = 'crosshair';
    } else if ($activeTool === 'draw') {
      canvas.style.cursor = 'crosshair';
    } else {
      canvas.style.cursor = '';
    }
  });
```

**Step 4: Run build**

Run: `pnpm run build`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/viewer/src/App.svelte
git commit -m "feat: initialize terra-draw with polygon and rectangle modes"
```

---

## Task 9: End-to-end verification

**Step 1: Start the proxy**

```bash
httpz-perma-proxy --port 9999 --cache-dir ~/zarr-cache \
  --map /zarr=https://dl2.geotessera.org/zarr -v
```

**Step 2: Start the dev server**

```bash
pnpm dev
```

**Step 3: Verify v1 catalog loads**

**Note:** Only utm29_2025 is fully generated in v1 so far. The STAC catalog lists utm30 and utm31 too, but their zarr stores may be incomplete. The viewer should handle zone open failures gracefully (the existing try/catch in `switchZone` covers this). Pan to the utm29 area (western Iberia / Atlantic coast, roughly -9° to -6° longitude) to test.

Open the browser. The catalog modal should discover 3 zones from the v1 catalog. The proxy logs should show:
```
GET /zarr/v1/catalog.json
GET /zarr/v1/geotessera-2025/collection.json
GET /zarr/v1/geotessera-2025/utm{29,30,31}_2025/utm{29,30,31}_2025.json
GET /zarr/v1/global_rgb_2025.zarr/zarr.json
```

**Step 4: Verify zone loads**

Click a zone. The proxy should show zarr.json metadata requests followed by sharded chunk fetches (these use Range headers for sub-shard reads).

**Step 5: Verify draw tool**

Switch to the Draw tab. Draw a polygon on the map. The DrawPanel should show "1 region drawn". Clear it.

**Step 6: Verify existing tools still work**

- Similarity: Click a pixel → CPU cosine similarity should compute
- Classify: Add labels → KNN classification should run
- Segment: Run solar detection

**Step 7: Final build**

Run: `pnpm run build`
Expected: PASS

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: v1 zarr support with terra-draw polygon drawing"
```

---

## Future work (not in this plan)

These are natural follow-ons but out of scope:

1. **Spatial similarity/classification** — Use drawn polygons to select regions for batch similarity search or classification (sample embeddings within polygon, run against all loaded tiles)
2. **Export drawn regions** — GeoJSON download of drawn features with embedded classification results
3. **Layer selection UI** — When v1 adds multiple embedding layers (different models/years), add a layer dropdown to switch between them
4. **Point query mode** — Use terra-draw point mode to replace the current click-based similarity reference pixel selection (unifies the interaction model)
