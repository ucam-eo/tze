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
    url: 'https://dl2.geotessera.org/zarr/v2/store.zarr' },
  { id: 'v1.1', label: 'v1.1', sublabel: 'Cambridge',
    url: 'https://tessera-embeddings.s3.us-west-2.amazonaws.com/v1.1/cambridge.zarr' },
];

export const catalogUrl = writable(DATASET_VERSIONS[0].url);
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

  // Update global preview URL for this year
  const urls = get(globalPreviewUrls);
  globalPreviewUrl.set(urls[year] ?? '');

  // Reinitialize the source manager with the new year's zones
  const filteredZones = get(zones);
  const map = get(mapInstance);
  if (!map || filteredZones.length === 0) return;

  const oldDisplay = get(displayManager);
  if (oldDisplay) oldDisplay.remove();

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

    // Clear stale pyramid cache from previous year's tiles
    clearZarrProtocolCache();

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
