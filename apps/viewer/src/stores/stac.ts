import { writable, derived, get } from 'svelte/store';
import { SourceManager } from '@ucam-eo/tessera';
import { MaplibreTesseraManager, clearZarrProtocolCache } from '@ucam-eo/maplibre-tessera';
import type { ZoneDescriptor } from '../lib/stac';
import { pointInBbox, loadStore } from '../lib/stac';
import { mapInstance } from './map';
import { sourceManager, displayManager, metadata, bands, opacity, preview, loading, status, globalPreviewUrl, globalPreviewBounds } from './zarr';
import { clearAllRegions } from './drawing';
import { simSelectedPixel, simScores, simRefEmbedding } from './similarity';
import { labels, isClassified } from './classifier';
import { segmentPolygons } from './segmentation';

/** A selectable dataset version (preset zarr store). */
export interface DatasetVersion {
  id: string;        // 'v1.0'
  label: string;     // 'v1.0'
  sublabel: string;  // 'global' | 'Cambridge'
  url: string;
}

/** Known dataset versions, surfaced as presets in the top-bar selector. */
export const DATASET_VERSIONS: DatasetVersion[] = [
  { id: 'v1.0', label: 'v1.0', sublabel: 'global',
    url: 'https://data.source.coop/tessera/tessera/zarr/v1' },
  // Still served from S3 while the source.coop copy is being processed; it will
  // move to `https://data.source.coop/tessera/tessera/zarr/v1.1-cam` once ready.
  { id: 'v1.1', label: 'v1.1', sublabel: 'Cambridge',
    url: 'https://tessera-embeddings.s3.us-west-2.amazonaws.com/v1.1/cambridge.zarr' },
];

/** Query-string key carrying the active dataset, so the page URL is shareable.
 *  Built-in stores use a short id (`?store=v1.1`); the default v1.0 omits the
 *  param entirely; custom stores fall back to the full URL (`?store=<zarr url>`). */
const STORE_PARAM = 'store';

/** Map an active store URL to its query-param value (null = omit the param). */
function urlToStoreParam(url: string): string | null {
  const version = DATASET_VERSIONS.find(v => v.url === url);
  if (!version) return url;                          // custom store → full URL
  if (version.id === DATASET_VERSIONS[0].id) return null;  // default → clean URL
  return version.id;                                 // other built-ins → short id
}

/** Resolve a query-param value back to a store URL (id shorthand or raw URL). */
function storeParamToUrl(param: string): string {
  return DATASET_VERSIONS.find(v => v.id === param)?.url ?? param;
}

/** Read the initial store URL from the page query string, falling back to v1.0. */
function readInitialStoreUrl(): string {
  try {
    const param = new URLSearchParams(window.location.search).get(STORE_PARAM);
    if (param) return storeParamToUrl(param);
  } catch { /* no window / malformed URL */ }
  return DATASET_VERSIONS[0].url;
}

/** Reflect the active store into the page query string (replaceState, no nav). */
function syncStoreUrlParam(url: string): void {
  try {
    const u = new URL(window.location.href);
    const param = urlToStoreParam(url);
    if (param === null) u.searchParams.delete(STORE_PARAM);
    else u.searchParams.set(STORE_PARAM, param);
    window.history.replaceState(null, '', u.toString());
  } catch { /* no window / malformed URL */ }
}

export const catalogUrl = writable(readInitialStoreUrl());
export const catalogStatus = writable<'idle' | 'loading' | 'loaded' | 'error'>('idle');
export const catalogError = writable<string>('');

/**
 * Guards manager (re)initialization. Set false whenever a new catalog starts
 * loading; the init `$effect` in CatalogModal flips it true once it has spun up
 * the source/display managers for the freshly discovered zones.
 */
export const managerInitStarted = writable(false);

/** All zones discovered in the store */
export const allZones = writable<ZoneDescriptor[]>([]);

/** Years discovered in the store, sorted ascending */
export const availableYears = writable<string[]>([]);

/** Currently active year */
export const activeYear = writable<string>('');

/** Per-year global preview URLs */
export const globalPreviewUrls = writable<Record<string, string>>({});

/** All zones (zarr stores always contain all zones). */
export const zones = derived(
  [allZones],
  ([$allZones]) => $allZones
);

/**
 * Load a catalog from a zarr store URL: discover zones/years and arm the
 * manager init `$effect`. Switching datasets invalidates all embedding-specific
 * analysis state, so that is cleared here (a no-op on first load). Used by both
 * the Connect Catalog modal and the top-bar version selector.
 */
export async function loadCatalog(url: string): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) return;

  catalogUrl.set(trimmed);
  syncStoreUrlParam(trimmed);
  catalogStatus.set('loading');
  catalogError.set('');
  allZones.set([]);
  managerInitStarted.set(false);
  status.set('Loading catalog...');

  // A dataset change invalidates all embedding-specific analysis state.
  clearAllRegions();
  simSelectedPixel.set(null);
  simRefEmbedding.set(null);
  simScores.set(new Map());
  labels.set([]);
  isClassified.set(false);
  segmentPolygons.set({ type: 'FeatureCollection', features: [] });

  try {
    const result = await loadStore(trimmed);
    allZones.set(result.zones);
    availableYears.set(result.availableYears);
    globalPreviewUrls.set(result.globalPreviewUrls);

    // Default to the latest year.
    const defaultYear = result.availableYears[result.availableYears.length - 1] ?? '';
    activeYear.set(defaultYear);

    globalPreviewUrl.set(result.globalPreviewUrls[defaultYear] ?? result.globalPreviewUrl ?? '');
    globalPreviewBounds.set(result.globalBounds);
    catalogStatus.set('loaded');
    status.set(`${result.zones.length} zones discovered${result.globalPreviewUrl ? ' (global preview available)' : ''}`);
  } catch (err) {
    console.error('[loadCatalog] failed:', err);
    catalogStatus.set('error');
    catalogError.set((err as Error).message);
    status.set(`Catalog error: ${(err as Error).message}`);
  }
}

/** Initialize the multi-zone source manager. */
export async function initManager(initialZoneId?: string): Promise<void> {
  const filteredZones = get(zones);
  const map = get(mapInstance);
  if (!map || filteredZones.length === 0) return;

  const oldDisplay = get(displayManager);
  if (oldDisplay) oldDisplay.remove();

  status.set('Initializing...');
  // console.log('[initManager] Starting with', filteredZones.length, 'zones, initialZone:', initialZoneId);

  try {
    const mobile = window.innerWidth < 640 || /iPhone|iPad|Android/i.test(navigator.userAgent);
    const sm = new SourceManager(
      filteredZones.map(z => ({ id: z.id, bbox: z.bbox, zarrUrl: z.zarrUrl })),
    );

    const dm = new MaplibreTesseraManager(sm, {
      bands: get(bands),
      opacity: get(opacity),
      preview: get(preview),
      globalPreviewUrl: get(globalPreviewUrl),
      globalPreviewBounds: get(globalPreviewBounds) ?? undefined,
      maxCached: mobile ? 4 : undefined,
    });

    sm.on('metadata-loaded', (meta) => {
      metadata.set(meta);
      status.set(`Loaded: zone ${meta.utmZone}`);
    });
    sm.on('loading', (p) => loading.set(p));
    sm.on('error', (err) => status.set(`Error: ${err.message}`));

    await dm.addTo(map);
    sourceManager.set(sm);
    displayManager.set(dm);

    if (initialZoneId) {
      const zone = filteredZones.find(z => z.id === initialZoneId);
      if (zone) await dm.getDisplaySource(zone.id);
    }

    catalogStatus.set('loaded');
    status.set('Ready');
    // console.log('[initManager] Complete, manager ready');
  } catch (err) {
    console.error('[initManager] Failed:', err);
    status.set(`Error: ${(err as Error).message}`);
  }
}

/** Switch active year: updates preview URL and reinitializes the source manager. */
export async function switchYear(year: string): Promise<void> {
  const years = get(availableYears);
  if (!years.includes(year) || year === get(activeYear)) return;

  activeYear.set(year);

  // Clear analysis state — embeddings are year-specific
  clearAllRegions();
  simSelectedPixel.set(null);
  simRefEmbedding.set(null);
  simScores.set(new Map());
  labels.set([]);
  isClassified.set(false);
  segmentPolygons.set({ type: 'FeatureCollection', features: [] });

  // Update global preview URL for this year. The store-level `global_rgb` array
  // has no time axis, so this is normally the same URL across every year — in
  // which case the preview layer is left on the map untouched below.
  const urls = get(globalPreviewUrls);
  const previewUrl = urls[year] ?? '';
  const previewUnchanged = previewUrl !== '' && previewUrl === get(globalPreviewUrl);
  globalPreviewUrl.set(previewUrl);

  // Reinitialize the source manager with the new year's zones
  const filteredZones = get(zones);
  const map = get(mapInstance);
  if (!map || filteredZones.length === 0) return;

  const oldDisplay = get(displayManager);
  if (oldDisplay) oldDisplay.remove({ keepPreview: previewUnchanged });

  status.set(`Switching to ${year}...`);

  try {
    const mobile = window.innerWidth < 640 || /iPhone|iPad|Android/i.test(navigator.userAgent);
    const sm = new SourceManager(
      filteredZones.map(z => ({ id: z.id, bbox: z.bbox, zarrUrl: z.zarrUrl })),
    );

    const dm = new MaplibreTesseraManager(sm, {
      bands: get(bands),
      opacity: get(opacity),
      preview: get(preview),
      globalPreviewUrl: get(globalPreviewUrl),
      globalPreviewBounds: get(globalPreviewBounds) ?? undefined,
      maxCached: mobile ? 4 : undefined,
    });

    sm.on('metadata-loaded', (meta) => {
      metadata.set(meta);
      status.set(`Loaded: zone ${meta.utmZone}`);
    });
    sm.on('loading', (p) => loading.set(p));
    sm.on('error', (err) => status.set(`Error: ${err.message}`));

    // The zarr:// protocol serves only the year-independent global RGB preview,
    // and its pyramid cache is keyed by store URL — nothing goes stale on a year
    // switch, so keep it and avoid reopening the preview store.
    if (!previewUnchanged) clearZarrProtocolCache();

    await dm.addTo(map);
    sourceManager.set(sm);
    displayManager.set(dm);

    // Eagerly open the zone the user is looking at so the preview layer appears immediately
    const center = map.getCenter();
    let initialZone = filteredZones.find(z => pointInBbox(center.lng, center.lat, z.bbox));
    if (!initialZone) initialZone = filteredZones[0];
    if (initialZone) await dm.getDisplaySource(initialZone.id);

    status.set(`${year} ready`);
  } catch (err) {
    status.set(`Error: ${(err as Error).message}`);
  }
}
