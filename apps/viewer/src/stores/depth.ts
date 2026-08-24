import { derived, writable, get } from 'svelte/store';
import { metadata } from './zarr';

/**
 * Matryoshka depth for region loading.
 *
 * @remarks
 * Stores declaring `geoemb:depths` carry truncated copies of the embeddings
 * array, so a region can be loaded at a fraction of the download and an
 * eighth of the memory. Similarity and classification read whatever width
 * the region has; segmentation needs all 128 dimensions and prompts for an
 * upgrade instead.
 */

/** Depths this store offers, ascending. Empty when it ships only one. */
export const availableDepths = derived(metadata, $m => {
  const depths = $m?.geoemb_depths?.map(d => d.dimensions) ?? [];
  return depths.length > 1 ? depths : [];
});

/** Dimensions new region loads fetch. */
export const loadDepth = writable<number>(0);

/** The store's full width, which an upgrade restores. */
export const fullDepth = derived(metadata, $m => $m?.nBands ?? 0);

/**
 * Default the depth for a freshly opened store.
 *
 * @remarks
 * 16 where offered: it keeps most of the scene structure the full vector
 * resolves (r=0.88 against the full-depth deviance map) for an eighth of the
 * bytes. Stores without depths load at their only width.
 */
export function resetLoadDepth(): void {
  const depths = get(availableDepths);
  loadDepth.set(depths.includes(16) ? 16 : (get(fullDepth) || 0));
}

/** Estimated decoded size of `tiles` tiles at `depth`, in bytes. */
export function estimateBytes(tiles: number, tileH: number, tileW: number, depth: number): number {
  return tiles * tileH * tileW * depth;
}

/** Human-readable byte count. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
