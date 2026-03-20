# tze Viewer: Adapt to Consolidated Zarr Store Layout

**Date**: 2026-03-12
**Upstream**: geotessera `docs/plans/2026-03-12-consolidated-zarr-stores.md`

## Context

The geotessera project is consolidating per-zone standalone Zarr stores into a single
per-year store. The layout changes from:

```
zarr/v1/utm29_2024.zarr/          → zarr/v1/2024.zarr/utm29/
zarr/v1/global_rgb_2024.zarr/     → zarr/v1/2024.zarr/global_rgb/
```

## Impact on tze

### Zone Stores — No Code Changes

Zone stores are discovered via STAC catalog. The viewer opens whatever URL the STAC
asset href resolves to. After consolidation, the STAC href changes from
`utm29_2024.zarr` to `2024.zarr/utm29`, but the resolved URL still points to a Zarr
group with `embeddings/`, `scales/`, `rgb/` arrays — the internal layout is unchanged.

**Action**: Rebuild the STAC catalog on the server after running the geotessera migration.
No TypeScript changes needed for zone store access.

STAC item IDs are preserved as `utm{NN}_{year}` so the existing year-extraction regex
`_(\d{4})$` in `stac.ts` (line ~87) continues to work.

### Global Preview — One Line Change

The global preview discovery in `apps/viewer/src/lib/stac.ts` (line ~92) probes for
stores using a hardcoded naming pattern:

```typescript
// Before
const candidateUrl = `${baseUrl}global_rgb_${year}.zarr`;

// After
const candidateUrl = `${baseUrl}${year}.zarr/global_rgb`;
```

The zarr-reader, zarr-source, zarr-tile-protocol, and source-manager are all
unaffected — they operate on group references, not store paths.

### TILES.md Documentation

Update `docs/TILES.md` to reflect the new store layout and URL patterns.

## Deployment Order

Note: there will be a brief outage between steps 1-3 where the old STAC catalog
points to non-existent paths. Deploy the tze change first (step 0) since the old
global preview probe will just fail gracefully if the URL doesn't exist.

0. Deploy tze with the global preview URL change (harmless — falls back if not found)
1. Run geotessera `zarr-consolidate` migration on the server
2. Rebuild STAC catalog: `geotessera-registry stac-index`
3. Verify zone stores load from STAC
4. Verify global preview loads at new URL
