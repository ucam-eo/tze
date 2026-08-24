import { writable } from 'svelte/store';
import { onNetworkActivity, type NetworkActivity, type SourceManager, type StoreMetadata } from '@ucam-eo/tessera';
import type { MaplibreTesseraManager } from '@ucam-eo/maplibre-tessera';

/** Core data manager — embedding queries, zone routing, events. */
export const sourceManager = writable<SourceManager | null>(null);

/** MapLibre display manager — layers, overlays, animations. */
export const displayManager = writable<MaplibreTesseraManager | null>(null);

export const metadata = writable<StoreMetadata | null>(null);
export const bands = writable<[number, number, number]>([0, 1, 2]);
export const opacity = writable(0.9);
/**
 * Tile-load progress for the current region, as `{ total, done }`.
 *
 * `{ total: 0 }` means "nothing to show" — the UI hides the indicator. Write
 * through {@link reportLoading} and {@link clearLoading} rather than setting
 * this directly, so progress cannot strand on screen.
 */
export const loading = writable({ total: 0, done: 0 });

/** Grace period after a load finishes, so the completed count is visible. */
const LOADING_SETTLE_MS = 600;

/** Idle period after which a load that stopped short is assumed abandoned. */
const LOADING_STALL_MS = 2000;

let loadingTimer: ReturnType<typeof setTimeout> | null = null;

function cancelLoadingTimer(): void {
  if (loadingTimer) clearTimeout(loadingTimer);
  loadingTimer = null;
}

/**
 * Record a progress update, clearing the indicator once it is no longer useful.
 *
 * @remarks
 * A finished load lingers briefly so the final count registers, then clears.
 * A load that simply stops — the usual outcome when the user pans away and the
 * region is aborted mid-flight — would otherwise leave a stale `12/40` on
 * screen forever, so a stall watchdog clears it too. Every update reschedules
 * the watchdog, so an active load never trips it.
 */
export function reportLoading(progress: { total: number; done: number }): void {
  cancelLoadingTimer();
  loading.set(progress);
  if (progress.total <= 0) return;
  const done = progress.done >= progress.total;
  loadingTimer = setTimeout(clearLoading, done ? LOADING_SETTLE_MS : LOADING_STALL_MS);
}

/** Hide the progress indicator at once — dataset or year switch, teardown. */
export function clearLoading(): void {
  cancelLoadingTimer();
  loading.set({ total: 0, done: 0 });
}
export const status = writable('Ready');
export const globalPreviewUrl = writable<string>('');
export const globalPreviewBounds = writable<[number, number, number, number] | null>(null);

/**
 * Live Zarr network activity, fed by the retry extension in @ucam-eo/tessera.
 *
 * Covers every store in the app — preview tiles, embedding chunks, metadata —
 * because the counters live in the innermost store wrapper. Updates are
 * throttled upstream, so this is safe to bind directly in the UI.
 */
export const networkActivity = writable<NetworkActivity>({ inflight: 0, retrying: 0 });
onNetworkActivity(a => networkActivity.set(a));
