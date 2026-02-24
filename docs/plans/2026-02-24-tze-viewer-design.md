# TZE: Tessera Zarr Explorer

**Date:** 2026-02-24
**Status:** Approved

## Overview

A standalone TypeScript project that extracts the map viewer from `geotessera-registry serve` into a static web application. It streams Zarr v3 embedding stores over HTTP and renders them as MapLibre GL image overlays with UTM reprojection. The Tessera Zarr integration is packaged as a reusable, npm-publishable MapLibre plugin.

## Goals

1. Browse any HTTP-served Zarr v3 embedding store without needing `geotessera-registry serve`
2. Publish the Zarr-to-MapLibre integration as `@ucam-eo/maplibre-zarr-tessera`
3. Deploy the viewer as a static site (GitHub Pages, Cloudflare Pages, etc.)
4. Provide multiple basemap layers via a layer switcher

## Non-Goals

- S3/GCS native protocol support (HTTP-only; S3 accessible via HTTPS URLs)
- Server-side rendering or backend
- Zarr v2 support

## Architecture

Monorepo with two packages managed by pnpm workspaces:

```
tze/
├── packages/
│   └── maplibre-zarr-tessera/     # npm plugin (library)
│       ├── src/
│       │   ├── index.ts           # public API exports
│       │   ├── zarr-source.ts     # ZarrTesseraSource class
│       │   ├── zarr-reader.ts     # Zarr v3 chunk reading via zarrita
│       │   ├── projection.ts      # UTM <-> WGS84 via proj4
│       │   ├── render-worker.ts   # Web Worker for band -> RGBA rendering
│       │   └── types.ts           # shared types
│       ├── package.json
│       ├── tsconfig.json
│       └── vite.config.ts         # library build
├── apps/
│   └── viewer/                    # Svelte static site
│       ├── src/
│       │   ├── App.svelte
│       │   ├── components/
│       │   │   ├── ControlPanel.svelte
│       │   │   ├── StoreSelector.svelte
│       │   │   ├── BandMapper.svelte
│       │   │   ├── LayerSwitcher.svelte
│       │   │   └── InfoPanel.svelte
│       │   ├── stores/
│       │   │   ├── map.ts         # Svelte store for map state
│       │   │   └── zarr.ts        # Svelte store for Zarr state
│       │   └── main.ts
│       ├── index.html
│       ├── package.json
│       └── vite.config.ts
├── package.json                   # workspace root
└── pnpm-workspace.yaml
```

### Package: `@ucam-eo/maplibre-zarr-tessera`

The plugin is the core deliverable. It reads Zarr v3 stores, reprojects UTM chunks to WGS84, renders bands to RGBA images, and places them on a MapLibre map.

**Public API:**

```typescript
import { ZarrTesseraSource } from '@ucam-eo/maplibre-zarr-tessera';

// Create a source from a Zarr store URL
const source = new ZarrTesseraSource({
  url: 'https://example.com/utm30_2025.zarr',
  bands: [0, 1, 2],       // which bands map to R, G, B
  opacity: 0.8,
  preview: 'rgb',          // 'rgb' | 'pca' | 'bands'
});

// Attach to a MapLibre map
source.addTo(map);

// Update rendering parameters (re-renders visible chunks)
source.setBands([3, 4, 5]);
source.setOpacity(0.6);
source.setPreview('pca');

// Query store metadata
source.getMetadata();  // { utmZone, epsg, shape, chunkShape, nBands, ... }

// Overlay controls
source.setGridVisible(true);
source.setUtmBoundaryVisible(true);

// Cleanup
source.remove();

// Events
source.on('chunk-loaded', ({ ci, cj }) => {});
source.on('metadata-loaded', (meta) => {});
source.on('error', (err) => {});
```

**Internal components:**

- **`zarr-reader.ts`** — Opens a Zarr v3 store via zarrita.js `FetchStore`, reads group metadata (`.zattrs` for UTM zone, EPSG, transform), opens `embeddings`, `scales`, `rgb`, and `pca_rgb` arrays. Provides `fetchChunkRegion(array, slices)` for reading typed array regions.

- **`projection.ts`** — Manages proj4 transformer setup from EPSG code. Converts UTM pixel bounds to WGS84 corner coordinates for MapLibre image sources. Caches transformers per EPSG.

- **`render-worker.ts`** — Web Worker that receives raw int8 embeddings + float32 scales + band indices, computes per-band min/max normalization, and outputs RGBA Uint8Array. Also handles RGB and PCA preview pass-through. Bundled as an inline blob URL.

- **`zarr-source.ts`** — The main class. On `addTo(map)`, listens to `moveend`/`zoomend` events, computes visible chunk indices from viewport bounds, fetches and renders chunks not in cache, and adds them as MapLibre `image` sources with `raster` layers. Manages an LRU chunk cache (default 50 entries). Adds optional overlay layers for chunk grid and UTM zone boundary.

**Dependencies:**
- `zarrita` (Zarr v3 reading)
- `proj4` (UTM reprojection)
- `maplibre-gl` (peer dependency)

### App: `viewer`

A Svelte 5 application that wraps the plugin with a UI.

**Components:**

- **`StoreSelector`** — URL text input. Maintains a localStorage-backed list of recent stores (last 10). Dropdown shows recent entries for quick re-access. "Load" button triggers store loading.

- **`LayerSwitcher`** — Radio buttons or dropdown to switch basemap. Available styles:
  - OpenStreetMap (default)
  - ESRI World Imagery (satellite)
  - Stadia Stamen Terrain
  - CartoDB Dark Matter (dark mode)
  All use free tile endpoints that don't require API keys.

- **`BandMapper`** — Three range sliders (R/G/B) mapping to band indices 0-127. Updates the plugin's band selection on change.

- **`ControlPanel`** — Container for all controls. Includes opacity slider, overlay toggles (chunk grid, UTM boundary), and preview mode toggle (RGB/PCA/Bands).

- **`InfoPanel`** — Displays store metadata: UTM zone, EPSG, grid dimensions, chunk count, loading status.

**State management:** Svelte stores (`writable`/`derived`) for:
- Current map instance
- Active `ZarrTesseraSource` instance
- Band selection, opacity, preview mode
- Recent store URLs
- Loading state

**Styling:** Tailwind CSS 4 with the dark terminal aesthetic from the existing viewer (cyan accents, monospace font, scanline effects).

## Data Flow

1. User enters a Zarr store URL and clicks Load
2. `ZarrTesseraSource` opens the store, reads group metadata (EPSG, transform, shape)
3. Plugin sets up proj4 transformer for the store's UTM zone
4. Plugin emits `metadata-loaded` event; UI updates info panel and enables controls
5. On each viewport change (`moveend`):
   a. Compute visible UTM bounds from map viewport
   b. Convert to chunk indices
   c. For each visible chunk not in cache:
      - If RGB/PCA preview available and chunk not clicked: fetch preview array
      - Otherwise: fetch embeddings + scales arrays
   d. Dispatch raw data to Web Worker pool for RGBA rendering
   e. Worker returns RGBA buffer; convert to canvas
   f. Add canvas as MapLibre image source with raster layer
   g. Cache the chunk data and map layer references
6. LRU eviction removes off-screen chunks when cache exceeds limit

## Basemap Tile Sources

| Name | URL Pattern | Attribution |
|------|------------|-------------|
| OpenStreetMap | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | OpenStreetMap contributors |
| ESRI Satellite | `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` | Esri, Maxar, Earthstar |
| Stadia Terrain | `https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}.png` | Stadia Maps, Stamen |
| CartoDB Dark | `https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png` | CartoDB, OSM |

## Build & Deploy

- **Dev:** `pnpm dev` starts Vite dev server for the viewer app with HMR
- **Build plugin:** `pnpm -F @ucam-eo/maplibre-zarr-tessera build` produces ESM + CJS + types in `dist/`
- **Build site:** `pnpm -F viewer build` produces static files in `apps/viewer/dist/`
- **Deploy:** Upload `apps/viewer/dist/` to any static host
- **Publish plugin:** `pnpm -F @ucam-eo/maplibre-zarr-tessera publish`

## Key Decisions

1. **Vite** for both library and app builds — fast dev, simple config, handles Web Worker bundling natively.
2. **Svelte 5** for the viewer — compiles away, small bundle, good component model for a control-panel-heavy UI.
3. **Monorepo** — keeps plugin cleanly separated from the viewer app, each with its own `package.json` and build.
4. **HTTP-only** — no S3 SDK needed; S3 stores are accessible via HTTPS URLs anyway.
5. **zarrita.js** — same library as the existing viewer, proven to work with the Tessera Zarr v3 format.
6. **proj4** — same as existing viewer for UTM reprojection. Lightweight, well-tested.
7. **pnpm** — fast, disk-efficient, good workspace support.
