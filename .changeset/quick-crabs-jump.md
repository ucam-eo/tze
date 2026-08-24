---
"@ucam-eo/maplibre-tessera": minor
"@ucam-eo/tessera": minor
---

Pin the Zarr v3 opener and drop the per-zone RGB preview and chunk manifest

Store opening issued a burst of 404s on startup. zarrita's auto-detecting
`zarr.open` picks its first attempt from a per-store counter of successful
opens, which starts empty and therefore resolves to v2 — so every fresh
`FetchStore` (one per UTM zone, plus one per parent group) paid two
sequential 404s (`.zattrs`, then `.zgroup`/`.zarray`) before falling back to
`zarr.json`. TESSERA stores are always v3, so every node is now opened with
`zarr.open.v3` in `openStore`, `TesseraTileRenderer` and the `zarr://`
MapLibre protocol. The root group, `embeddings` and `scales` are also opened
concurrently rather than in a three-deep await chain, and parent-group
`geoemb:` attributes are memoised per URL — every zone under a store shares
one parent, so N identical fetches collapse into one.

Two probes that could only ever 404 are gone entirely, along with the
features they fed:

- **Per-zone `rgb` preview array.** Superseded by the store-level
  `global_rgb` pyramid served through the `zarr://` protocol; no published
  store has carried a per-zone `rgb` array for some time, so `hasRgb` was
  always `false` and the preview path was unreachable.
- **`_chunk_manifest.json`.** No longer generated. It listed non-empty
  chunks so sparse stores could skip them; with the file absent the guards
  were inert.

Breaking API changes:

- `StoreMetadata.hasRgb` and `ZarrStore.rgbArr` / `ZarrStore.chunkManifest`
  are removed.
- `PreviewMode`, `MaplibreDisplayOptions.preview`, `CachedChunk.isPreview`,
  and `setPreview()` on both `MaplibreTesseraSource` and
  `MaplibreTesseraManager` are removed. Viewport tiles always render from
  embedding bands; the global preview layer is configured via
  `globalPreviewUrl` as before.

Opening one zone of the v1 store drops from 14 requests (8 of them 404s,
~11 sequential round-trips) to 6 requests with no 404s.
