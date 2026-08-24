import { writable, derived, get } from 'svelte/store';
import { sourceManager, displayManager, metadata } from './zarr';
import { simEmbeddingTileCount, simRefEmbedding, simSelectedPixel } from './similarity';
import { loadDepth, fullDepth, estimateBytes, formatBytes } from './depth';
import { labels } from './classifier';
import { segmentPolygons } from './segmentation';

export type DrawMode = 'polygon' | 'rectangle';
export type RoiRegion = {
  id: string;
  feature: GeoJSON.Feature;
  chunkKeys: string[]; // "zoneId:ci_cj" keys loaded for this region
  /** Embedding dimensions this region was loaded at. */
  depth?: number;
};

/** Whether terra-draw is currently active for drawing. */
export const roiDrawing = writable(false);

/** Active terra-draw mode (polygon or rectangle). */
export const drawMode = writable<DrawMode>('rectangle');

/** All drawn ROI regions. */
export const roiRegions = writable<RoiRegion[]>([]);

/** Loading progress: null when idle. */
export const roiLoading = writable<{ loaded: number; total: number } | null>(null);

/** Total number of embedding tiles loaded across all regions. */
export const roiTileCount = derived(roiRegions, ($regions) => {
  const keys = new Set<string>();
  for (const r of $regions) {
    for (const k of r.chunkKeys) keys.add(k);
  }
  return keys.size;
});

let nextId = 0;

/** Warn above this much decoded embedding data for one region. */
const LARGE_REGION_BYTES = 64 * 1024 * 1024;

let _confirmLargeRegion: ((count: number) => Promise<boolean>) | null = null;

/** Register a callback that confirms large region loads. Returns true to proceed. */
export function setConfirmLargeRegion(fn: (count: number) => Promise<boolean>) {
  _confirmLargeRegion = fn;
}

/**
 * Load managed chunks zone by zone, animating and reporting progress.
 *
 * @param depth - Embedding dimensions to load, or undefined for full depth.
 *
 * @remarks
 * Shared by drawing a region and upgrading one, so both animate, report and
 * batch identically.
 */
async function loadManagedChunks(
  managedChunks: { zoneId: string; ci: number; cj: number }[],
  geometry: GeoJSON.Polygon,
  depth: number | undefined,
): Promise<void> {
  const dm = get(displayManager);

  const byZone = new Map<string, { ci: number; cj: number }[]>();
  for (const { zoneId, ci, cj } of managedChunks) {
    let arr = byZone.get(zoneId);
    if (!arr) { arr = []; byZone.set(zoneId, arr); }
    arr.push({ ci, cj });
  }

  if (dm) {
    for (const [zoneId, chunks] of byZone) {
      dm.startRegionAnimation(zoneId, geometry, chunks, depth);
    }
  }

  const total = managedChunks.length;
  roiLoading.set({ loaded: 0, total });
  let globalLoaded = 0;
  let rafId = 0;

  for (const [zoneId, chunks] of byZone) {
    const displaySrc = dm ? await dm.getDisplaySource(zoneId) : null;
    const baseLoaded = globalLoaded;
    if (displaySrc) {
      await displaySrc.loadChunkBatch(chunks, (loaded, _t, ci, cj) => {
        globalLoaded = baseLoaded + loaded;
        if (dm) dm.updateRegionAnimation(zoneId, loaded, chunks.length, ci, cj);
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            roiLoading.set({ loaded: globalLoaded, total });
          });
        }
      }, { depth });
    }
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    roiLoading.set({ loaded: globalLoaded, total });
  }

  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }

  if (dm) {
    dm.stopRegionAnimation();
    dm.recolorAllChunks();
  }
}

/** Called when terra-draw finishes a shape. Starts loading chunks for the region.
 *  Returns false if the user cancelled (e.g. large region confirmation).
 *  Pass skipConfirm=true to bypass the large-region modal (used by tutorials). */
export async function addRegion(feature: GeoJSON.Feature, { skipConfirm = false } = {}): Promise<boolean> {
  const sm = get(sourceManager);
  const dm = get(displayManager);
  if (!sm) return false;

  const geometry = feature.geometry as GeoJSON.Polygon;
  const managedChunks = await sm.getChunksInRegion(geometry);

  // Read the depth once: a mid-load change must not split a region across
  // two widths.
  const depth = get(loadDepth) || get(fullDepth) || undefined;
  const cs = get(metadata)?.chunkShape;
  const bytes = cs && depth ? estimateBytes(managedChunks.length, cs[0], cs[1], depth) : 0;

  if (!skipConfirm && bytes > LARGE_REGION_BYTES && _confirmLargeRegion) {
    const proceed = await _confirmLargeRegion(bytes);
    if (!proceed) return false;
  }

  const region: RoiRegion = {
    id: `roi-${nextId++}`,
    feature,
    chunkKeys: [],
    depth,
  };

  // Add region immediately (shows in UI with 0 tiles)
  roiRegions.update(rs => [...rs, region]);

  if (managedChunks.length === 0) return true;

  await loadManagedChunks(managedChunks, geometry, depth);

  // Record which chunks this region owns (zone-prefixed keys)
  const loadedKeys: string[] = [];
  for (const { zoneId, ci, cj } of managedChunks) {
    if (sm.regionHasTile(zoneId, ci, cj)) {
      loadedKeys.push(`${zoneId}:${ci}_${cj}`);
    }
  }
  roiRegions.update(rs =>
    rs.map(r => r.id === region.id ? { ...r, chunkKeys: loadedKeys } : r)
  );

  roiLoading.set(null);
  simEmbeddingTileCount.set(sm.totalTileCount());
  return true;
}

/**
 * Reload every region at the store's full depth and refresh what was derived
 * from the shallow one.
 *
 * @remarks
 * Not a top-up: an inner chunk of the full array carries every band, so
 * reading only the missing dimensions would cost the same as reading all of
 * them. Cached vectors — training labels and the similarity reference — were
 * captured at the old width and would not match the new region, so they are
 * re-extracted from their coordinates before anything reruns. Segment
 * polygons come from a model that only accepts full depth, so they are
 * cleared rather than migrated.
 */
export async function upgradeRegions(): Promise<void> {
  const sm = get(sourceManager);
  const full = get(fullDepth);
  if (!sm || !full) return;

  loadDepth.set(full);
  segmentPolygons.set({ type: 'FeatureCollection', features: [] });

  for (const region of get(roiRegions)) {
    if (region.depth === full) continue;
    const geometry = region.feature.geometry as GeoJSON.Polygon;
    const managedChunks = await sm.getChunksInRegion(geometry);
    if (managedChunks.length === 0) continue;
    await loadManagedChunks(managedChunks, geometry, full);
  }

  roiRegions.update(rs => rs.map(r => ({ ...r, depth: full })));

  // Re-extract vectors captured at the old width.
  labels.update(ls => ls.map(l => {
    const emb = sm.getEmbeddingAt(l.lngLat[0], l.lngLat[1]);
    return emb ? { ...l, embedding: emb.embedding } : l;
  }));

  const px = get(simSelectedPixel);
  if (px) {
    const emb = sm.getEmbeddingAt(px.lng, px.lat);
    if (emb) simRefEmbedding.set(emb.embedding);
  }

  roiLoading.set(null);
  simEmbeddingTileCount.set(sm.totalTileCount());
}

/** Remove a single region. Evict its exclusive tiles from the embedding cache. */
export function removeRegion(regionId: string): void {
  const regions = get(roiRegions);
  const target = regions.find(r => r.id === regionId);
  if (!target) return;

  // Find keys owned exclusively by this region
  const otherKeys = new Set<string>();
  for (const r of regions) {
    if (r.id !== regionId) {
      for (const k of r.chunkKeys) otherKeys.add(k);
    }
  }
  const exclusiveKeys = target.chunkKeys.filter(k => !otherKeys.has(k));

  // Evict exclusive tiles from their zone's region buffer
  const sm = get(sourceManager);
  const dm = get(displayManager);
  if (sm) {
    for (const k of exclusiveKeys) {
      // Parse "zoneId:ci_cj"
      const colonIdx = k.indexOf(':');
      const zoneId = k.substring(0, colonIdx);
      const [ciStr, cjStr] = k.substring(colonIdx + 1).split('_');
      const ci = parseInt(ciStr), cj = parseInt(cjStr);

      const src = sm.getOpenSource(zoneId);
      if (!src) continue;

      src.evictTile(ci, cj);

      // If zone has no loaded tiles, clear its region entirely
      if (src.tileCount === 0) {
        src.clearRegion();
      }
    }

    if (dm) dm.clearClassificationOverlays();
    simEmbeddingTileCount.set(sm.totalTileCount());
  }

  roiRegions.update(rs => rs.filter(r => r.id !== regionId));
}

/** Clear all regions and the entire embedding cache. */
export function clearAllRegions(): void {
  const sm = get(sourceManager);
  const dm = get(displayManager);
  if (sm) {
    for (const src of sm.getActiveSources().values()) {
      src.clearRegion();
    }
    if (dm) dm.clearClassificationOverlays();
  }
  roiRegions.set([]);
  roiLoading.set(null);
}
