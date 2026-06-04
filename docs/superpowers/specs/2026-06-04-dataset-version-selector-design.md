# Dataset Version Selector — Design

**Date:** 2026-06-04
**Status:** Approved

## Goal

Let users switch the active TESSERA dataset between known versions (v1.0 and
v1.1) from the top bar, by turning the existing catalog-status chip into a
dropdown. Custom URLs remain available via the existing Connect Catalog modal.

## Background

The viewer loads a Zarr store whose URL is held in the `catalogUrl` store
(`apps/viewer/src/stores/stac.ts`), defaulting to
`https://dl2.geotessera.org/zarr/v2/store.zarr`. `CatalogModal.fetchCatalog()`
sets `catalogUrl`, calls `loadStore()` to discover zones/years, and resets a
component-local `managerInitStarted` flag; a `$effect` in `CatalogModal` (always
mounted) then reinitializes `SourceManager` / `MaplibreTesseraManager`.

Both target stores are structurally identical (same `geoemb:` convention, same
`consolidated_metadata` with `utmNN` zone groups), verified by fetching each
`zarr.json`. Switching versions is therefore a pure URL swap through the existing
load path. v1.0 is global; v1.1 is a Cambridge-only store.

## Design

### 1. Preset config (new, in `stores/stac.ts`)

```ts
export interface DatasetVersion {
  id: string;        // 'v1.0'
  label: string;     // 'v1.0'
  sublabel: string;  // 'global' | 'Cambridge'
  url: string;
}

export const DATASET_VERSIONS: DatasetVersion[] = [
  { id: 'v1.0', label: 'v1.0', sublabel: 'global',
    url: 'https://dl2.geotessera.org/zarr/v2/store.zarr' },
  { id: 'v1.1', label: 'v1.1', sublabel: 'Cambridge',
    url: 'https://tessera-embeddings.s3.us-west-2.amazonaws.com/v1.1/cambridge.zarr' },
];
```

`catalogUrl` default stays v1.0's URL.

### 2. Refactor: lift catalog loading into the store

- Move the body of `CatalogModal.fetchCatalog()` into a shared exported async
  function `loadCatalog(url: string)` in `stores/stac.ts`.
- Lift `managerInitStarted` from component-local `$state` in `CatalogModal` into
  a module-level writable store in `stores/stac.ts`, so both the modal and the
  new dropdown drive the same re-init `$effect` (which stays in `CatalogModal`).
- `loadCatalog` clears analysis state on every (re)load — regions, similarity
  selection/scores/ref embedding, labels + `isClassified`, segmentation polygons
  — mirroring `switchYear`. (No-op on first load; correct on version switch.)
- `CatalogModal.fetchCatalog()` and its `onMount` call `loadCatalog`. The modal
  keeps only its UI concerns (`urlInput`, open/close `$effect`).

### 3. TopBar: chip → dropdown

- The catalog-status chip (`TopBar.svelte` ~lines 553–574) becomes a dropdown
  trigger.
- Trigger content: keep the health dot and the `done/total` loading progress;
  replace the `{zones.length}z` text with the **active version label** —
  computed by matching `$catalogUrl` against `DATASET_VERSIONS` (`.find(v => v.url === $catalogUrl)`),
  falling back to `"Custom"`. Add a `ChevronDown`.
- Menu (reusing the adjacent year-dropdown markup: click-outside backdrop,
  positioning, z-index, styling):
  - one item per `DATASET_VERSIONS` entry — `label` plus dimmed `sublabel`, with
    a check / active highlight on the entry whose `url === $catalogUrl`;
    `onclick` → `loadCatalog(version.url)` and close.
  - a final `Custom URL…` item → calls the existing `onOpenCatalog` prop and
    closes.
- Add a `versionDropdownOpen` `$state` alongside the existing
  `yearDropdownOpen`.

## Data flow

select version → `loadCatalog(url)` (sets `catalogUrl`/status, clears analysis
state) → `loadStore()` discovers zones/years → resets `managerInitStarted`
store → `CatalogModal`'s `$effect` reinitializes managers → map reloads.
Identical to a modal CONNECT.

## Error handling

Unchanged. `loadCatalog` sets `catalogStatus = 'error'` and `catalogError`; the
chip health dot turns red as it does today. A failed switch leaves the previous
manager in place (it is only removed inside successful re-init).

## Decisions made

- Switching version **silently clears** in-progress analysis (matches existing
  year-switch behavior).
- The chip shows `"Custom"` when `catalogUrl` is not a known preset.

## Out of scope

- Persisting the chosen version across page reloads.
- Mixing versions per zone.
- Validating/canonicalizing a custom URL against the preset list.

## Testing

- Type check: `pnpm check`.
- Manual: load app (v1.0 shown, global zones); open chip dropdown, pick v1.1
  (Cambridge) — map reloads to Cambridge store, chip reads `v1.1`, analysis
  state cleared; switch back to v1.0; use `Custom URL…` to open the modal and
  connect an arbitrary store — chip reads `Custom`.
