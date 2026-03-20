# Multi-Year Selector Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a year selector so users can switch which year's RGB preview and embedding zones are active on the map.

**Architecture:** The STAC catalog already returns zones for all years (e.g. `utm30_2024`, `utm30_2025`). We extract available years from zone IDs, add an `activeYear` store, and filter the flat zone list by year. Switching year updates the global preview URL, re-initializes the source manager with that year's zones, and clears loaded embeddings/analysis. The TopBar gets a compact year toggle; the CatalogModal shows discovered years.

**Tech Stack:** Svelte 5 (runes), TypeScript, existing store pattern (writable/derived)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/viewer/src/lib/stac.ts` | Modify | Return `availableYears` and per-year `globalPreviewUrls` from catalog |
| `apps/viewer/src/stores/stac.ts` | Modify | Add `availableYears`, `activeYear` stores; filter zones by year; year-switch logic |
| `apps/viewer/src/stores/zarr.ts` | No change | `globalPreviewUrl` and `globalPreviewBounds` already writable |
| `apps/viewer/src/components/TopBar.svelte` | Modify | Add compact year toggle |
| `apps/viewer/src/components/CatalogModal.svelte` | Modify | Show discovered years, wire up year-aware init |

---

## Chunk 1: Data Layer — Catalog & Stores

### Task 1: Extend `loadCatalog` to return year metadata

**Files:**
- Modify: `apps/viewer/src/lib/stac.ts`

- [ ] **Step 1: Update `CatalogResult` interface**

Add `availableYears` and a map of per-year global preview URLs. Change the single `globalPreviewUrl` to a per-year map so that switching year doesn't require re-probing.

```typescript
export interface CatalogResult {
  zones: ZoneDescriptor[];
  availableYears: string[];               // e.g. ["2024", "2025"]
  globalPreviewUrls: Record<string, string>;  // year → preview zarr URL
  globalPreviewUrl: string | null;         // keep for back-compat (latest year)
  globalBounds: [number, number, number, number] | null;
}
```

In `apps/viewer/src/lib/stac.ts`, replace the `CatalogResult` interface (lines 23-28) with the above.

- [ ] **Step 2: Extract years and probe all preview URLs**

Replace the single-year preview probe (lines 82-105) with a loop over all discovered years:

```typescript
// Probe for global preview stores (one per year)
const baseUrl = resolvedCatalogUrl.replace(/\/[^/]*$/, '/');
const years = [...new Set(
  zones.map(z => z.id.match(/_(\d{4})$/)?.[1]).filter(Boolean)
)].sort() as string[];

const globalPreviewUrls: Record<string, string> = {};
for (const year of years) {
  const candidateUrl = `${baseUrl}global_rgb_${year}.zarr`;
  try {
    const resp = await fetch(`${candidateUrl}/zarr.json`, { signal });
    if (resp.ok) {
      globalPreviewUrls[year] = candidateUrl;
      // Read bounds from the first successful probe
      if (!globalBounds) {
        const zarrMeta = await resp.json() as Record<string, unknown>;
        const attrs = zarrMeta.attributes as Record<string, unknown> | undefined;
        const spatialBbox = attrs?.['spatial:bbox'] as [number, number, number, number] | undefined;
        const spatial = attrs?.spatial as { bounds?: [number, number, number, number] } | undefined;
        if (spatialBbox) {
          globalBounds = spatialBbox;
        } else if (spatial?.bounds) {
          globalBounds = spatial.bounds;
        }
      }
    }
  } catch {
    // Preview not available for this year
  }
}

const latestYear = years[years.length - 1] ?? null;
const globalPreviewUrl = latestYear ? (globalPreviewUrls[latestYear] ?? null) : null;
```

- [ ] **Step 3: Update return statement**

```typescript
return { zones, availableYears: years, globalPreviewUrls, globalPreviewUrl, globalBounds };
```

- [ ] **Step 4: Verify build compiles**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm check`
Expected: May show errors in CatalogModal (consuming new fields) — that's fine, we fix those next.

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/lib/stac.ts
git commit -m "feat(stac): return available years and per-year preview URLs from catalog"
```

---

### Task 2: Add year stores and year-switching logic

**Files:**
- Modify: `apps/viewer/src/stores/stac.ts`

- [ ] **Step 1: Add new stores and allZones**

Add these stores to `apps/viewer/src/stores/stac.ts`:

```typescript
import { writable, derived, get } from 'svelte/store';

/** All zones across all years, as returned by loadCatalog */
export const allZones = writable<ZoneDescriptor[]>([]);

/** Years discovered in the catalog, sorted ascending */
export const availableYears = writable<string[]>([]);

/** Currently active year */
export const activeYear = writable<string>('');

/** Per-year global preview URLs */
export const globalPreviewUrls = writable<Record<string, string>>({});

/** Zones filtered to the active year */
export const zones = derived(
  [allZones, activeYear],
  ([$allZones, $activeYear]) =>
    $activeYear ? $allZones.filter(z => z.id.endsWith(`_${$activeYear}`)) : $allZones
);
```

Remove the old `export const zones = writable<ZoneDescriptor[]>([]);` line.

- [ ] **Step 2: Add `switchYear` function**

This is the core year-switching logic. Add to `apps/viewer/src/stores/stac.ts`:

```typescript
/** Switch active year: updates preview URL and reinitializes the source manager. */
export async function switchYear(year: string): Promise<void> {
  const years = get(availableYears);
  if (!years.includes(year)) return;

  activeYear.set(year);

  // Update global preview URL for this year
  const urls = get(globalPreviewUrls);
  globalPreviewUrl.set(urls[year] ?? '');

  // Reinitialize the source manager with the new year's zones
  const filteredZones = get(zones);
  const map = get(mapInstance);
  if (!map || filteredZones.length === 0) return;

  const oldManager = get(sourceManager);
  if (oldManager) oldManager.remove();

  status.set(`Switching to ${year}...`);

  try {
    const mobile = window.innerWidth < 640 || /iPhone|iPad|Android/i.test(navigator.userAgent);
    const manager = new ZarrSourceManager(
      filteredZones.map(z => ({ id: z.id, bbox: z.bbox, zarrUrl: z.zarrUrl })),
      {
        bands: get(bands),
        opacity: get(opacity),
        preview: get(preview),
        globalPreviewUrl: get(globalPreviewUrl),
        globalPreviewBounds: get(globalPreviewBounds) ?? undefined,
        maxCached: mobile ? 4 : undefined,
      },
    );

    manager.on('metadata-loaded', (meta) => {
      metadata.set(meta);
      status.set(`Loaded: zone ${meta.utmZone}`);
    });
    manager.on('loading', (p) => loading.set(p));
    manager.on('error', (err) => status.set(`Error: ${err.message}`));

    await manager.addTo(map);
    sourceManager.set(manager);
    status.set(`${year} ready`);
  } catch (err) {
    status.set(`Error: ${(err as Error).message}`);
  }
}
```

- [ ] **Step 3: Update `initManager` to use `zones` derived store**

In `initManager`, change `const allZones = get(zones);` to `const filteredZones = get(zones);` and use `filteredZones` throughout that function. The derived `zones` store already filters by active year.

- [ ] **Step 4: Verify build compiles**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm check`

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/stores/stac.ts
git commit -m "feat(stores): add activeYear, availableYears stores and switchYear function"
```

---

### Task 3: Wire CatalogModal to year-aware stores

**Files:**
- Modify: `apps/viewer/src/components/CatalogModal.svelte`

- [ ] **Step 1: Update imports**

Replace the zones import and add new stores:

```typescript
import {
  catalogUrl, zones, allZones, availableYears, activeYear,
  globalPreviewUrls as globalPreviewUrlsStore,
  catalogStatus, catalogError, initManager,
} from '../stores/stac';
```

- [ ] **Step 2: Update `fetchCatalog` to populate year stores**

In `fetchCatalog()`, replace `$zones = [];` (line 55) with `$allZones = [];` (derived stores are read-only). Keep `managerInitStarted = false;` on the next line.

Then after `const result = await loadCatalog(url);`, replace the existing store assignments (`$zones = result.zones`, `$globalPreviewUrl = ...`, etc.) with:

```typescript
$allZones = result.zones;
$availableYears = result.availableYears;
$globalPreviewUrlsStore = result.globalPreviewUrls;

// Default to the latest year
const defaultYear = result.availableYears[result.availableYears.length - 1] ?? '';
$activeYear = defaultYear;

// Set preview URL for the default year
$globalPreviewUrl = result.globalPreviewUrls[defaultYear] ?? result.globalPreviewUrl ?? '';
$globalPreviewBounds = result.globalBounds;
$catalogStatus = 'loaded';
```

- [ ] **Step 3: Update the `$effect` that initializes the manager**

Change the reactive dependency from `$zones` (now derived) — the effect should watch `zones` as a store subscription:

```typescript
$effect(() => {
  const map = $mapInstance;
  const currentZones = $zones;
  if (map && currentZones.length > 0 && $catalogStatus === 'loaded' && !managerInitStarted) {
    managerInitStarted = true;
    const center = map.getCenter();
    let initialZoneId: string | undefined;
    for (const zone of currentZones) {
      if (pointInBbox(center.lng, center.lat, zone.bbox)) {
        initialZoneId = zone.id;
        break;
      }
    }
    initManager(initialZoneId ?? currentZones[0].id);
  }
});
```

- [ ] **Step 4: Add year display in the modal status area**

After the existing status section (around line 131), add year info when loaded:

```svelte
{:else if $catalogStatus === 'loaded'}
  <span class="text-green-400">
    {$zones.length} zones discovered
    {#if $availableYears.length > 1}
      &middot; {$availableYears.length} years ({$availableYears.join(', ')})
    {/if}
  </span>
```

- [ ] **Step 5: Verify build compiles**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/viewer/src/components/CatalogModal.svelte
git commit -m "feat(catalog): wire CatalogModal to year-aware stores"
```

---

## Chunk 2: UI — TopBar Year Toggle

### Task 4: Add year toggle to TopBar

**Files:**
- Modify: `apps/viewer/src/components/TopBar.svelte`

- [ ] **Step 1: Add imports**

Add the year stores and switchYear to the existing imports from stac:

```typescript
import { zones, catalogStatus, availableYears, activeYear, switchYear } from '../stores/stac';
```

- [ ] **Step 2: Add the year toggle UI**

Insert a year toggle between the TZE branding and the tutorial dropdown (after line 280 in the current TopBar, after the TZE branding `</div>`). Only show when there are multiple years:

```svelte
<!-- Year toggle -->
{#if $availableYears.length > 1}
  <div class="flex items-center rounded border border-gray-700/60 overflow-hidden h-5">
    {#each $availableYears as year}
      <button
        onclick={() => switchYear(year)}
        class="px-1.5 text-[9px] h-full transition-all
               {$activeYear === year
                 ? 'bg-term-cyan/15 text-term-cyan border-term-cyan/40'
                 : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/60'}"
      >
        {year}
      </button>
    {/each}
  </div>
{/if}
```

- [ ] **Step 3: Update the catalog status indicator**

In the catalog status button at the bottom of TopBar (around line 549), update the zone count to include the active year:

```svelte
<span class="text-[10px] hidden sm:inline">
  {#if $catalogStatus === 'loaded'}
    {$zones.length}z
    {#if $availableYears.length > 1}
      <span class="text-gray-600">{$activeYear}</span>
    {/if}
  {:else if $catalogStatus === 'loading'}
    ...
  {:else if $catalogStatus === 'error'}
    Err
  {:else}
    --
  {/if}
</span>
```

- [ ] **Step 4: Verify build compiles and dev server renders**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/components/TopBar.svelte
git commit -m "feat(ui): add year toggle to TopBar for switching between dataset years"
```

---

### Task 5: Clear analysis state on year switch

**Files:**
- Modify: `apps/viewer/src/stores/stac.ts`

- [ ] **Step 1: Import analysis reset functions**

In `switchYear`, we need to clear ROI regions and analysis results when switching years, since embeddings from one year are not valid for another. Add imports:

```typescript
import { clearAllRegions } from './drawing';
import { simSelectedPixel, simScores, simRefEmbedding } from './similarity';
```

- [ ] **Step 2: Add cleanup to `switchYear` before reinitializing**

At the start of `switchYear`, after `activeYear.set(year)`:

```typescript
// Clear analysis state — embeddings are year-specific
clearAllRegions();
simSelectedPixel.set(null);
simRefEmbedding.set(null);
simScores.set(new Map());
```

- [ ] **Step 3: Verify build compiles**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/viewer/src/stores/stac.ts
git commit -m "feat(stores): clear analysis state when switching years"
```

---

### Task 6: Manual smoke test

- [ ] **Step 1: Start dev server**

Run: `cd /Users/avsm/src/git/ucam-eo/tze && pnpm dev`

- [ ] **Step 2: Verify year toggle appears**

After catalog loads, confirm the TopBar shows `2024 | 2025` toggle buttons with 2025 highlighted as default.

- [ ] **Step 3: Verify year switching works**

Click `2024` — confirm:
- RGB preview tiles reload with 2024 imagery
- Zone count updates
- Any loaded ROI regions are cleared
- Status shows "2024 ready"

Click `2025` — confirm the reverse.

- [ ] **Step 4: Verify catalog modal shows years**

Click the catalog status indicator — confirm modal shows "6 zones discovered · 2 years (2024, 2025)".
