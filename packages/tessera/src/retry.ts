/**
 * Retry for transient network failures, plus the activity signal the UI
 * reads to show what the network is doing.
 *
 * @remarks
 * Browsers under connection pressure drop requests that nothing asked to
 * cancel: Safari reports `TypeError: Load failed` (and logs "The network
 * connection was lost") when it tears down a connection with requests still
 * on it. A single re-attempt turns most of those into a rendered tile.
 *
 * {@link withRetry} belongs *innermost* in an `extendStore` chain, closest to
 * the network:
 *
 * ```ts
 * const store = await zarr.extendStore(
 *   new zarr.FetchStore(url),
 *   withRetry,
 *   withRequestCoalescing,
 *   withRangeCoalescing,
 * );
 * ```
 *
 * `extendStore` applies extensions left to right, each wrapping the last, so
 * the first listed sits nearest the store. Placing retry there means the one
 * shared fetch behind a coalesced group is what retries — every reader
 * waiting on it benefits from a single re-attempt, rather than each reader
 * retrying its own copy of the same request.
 */
import * as zarr from 'zarrita';
import type { AbsolutePath, GetOptions, RangeQuery } from 'zarrita';

/** How many times a failed request is re-attempted before giving up. */
const DEFAULT_RETRIES = 2;

/** Delay before the first re-attempt; each subsequent one waits 4× longer. */
const DEFAULT_BASE_DELAY_MS = 250;

/** Fraction of the delay to randomise, spreading a batch's retries apart. */
const DEFAULT_JITTER = 0.25;

/** Minimum gap between activity notifications, in milliseconds. */
const ACTIVITY_EMIT_INTERVAL_MS = 80;

export interface RetryOptions {
  /** Re-attempts after the initial failure. Default 2. */
  retries?: number;
  /** Delay before the first re-attempt, in ms. Default 250. */
  baseDelayMs?: number;
  /** Fraction of each delay to randomise, 0–1. Default 0.25. */
  jitter?: number;
}

/** A snapshot of what the network layer is currently doing. */
export interface NetworkActivity {
  /** Requests issued and not yet settled, including those between retries. */
  inflight: number;
  /** Requests currently waiting out a backoff before another attempt. */
  retrying: number;
}

// ---------------------------------------------------------------------------
// Activity signal
// ---------------------------------------------------------------------------

let inflight = 0;
let retrying = 0;
const listeners = new Set<(activity: NetworkActivity) => void>();
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let lastEmit = 0;

function snapshot(): NetworkActivity {
  return { inflight, retrying };
}

/**
 * Notify listeners, at most once per {@link ACTIVITY_EMIT_INTERVAL_MS}.
 *
 * @remarks
 * Throttled rather than debounced: a debounce would keep resetting during
 * sustained tile loading and never report that anything was happening. This
 * always emits a trailing update, so the counts settle correctly at idle.
 */
function notifyActivity(): void {
  if (listeners.size === 0 || emitTimer) return;
  const wait = Math.max(0, ACTIVITY_EMIT_INTERVAL_MS - (Date.now() - lastEmit));
  emitTimer = setTimeout(() => {
    emitTimer = null;
    lastEmit = Date.now();
    const activity = snapshot();
    for (const listener of listeners) {
      try {
        listener(activity);
      } catch (err) {
        console.warn('[tessera] network activity listener threw:', err);
      }
    }
  }, wait);
}

/** Current network activity, without waiting for the next notification. */
export function getNetworkActivity(): NetworkActivity {
  return snapshot();
}

/**
 * Subscribe to network activity across every store in the process.
 *
 * @param listener - Called with a fresh snapshot when the counts change.
 * @returns Unsubscribe function.
 *
 * @remarks
 * The listener is called once immediately with the current state, so callers
 * do not need a separate priming read. Updates are throttled, so a burst of
 * tile requests produces a handful of notifications rather than hundreds.
 */
export function onNetworkActivity(listener: (activity: NetworkActivity) => void): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}

/** Reset counters and listeners. Test helper — not part of the public flow. */
export function _resetNetworkActivity(): void {
  inflight = 0;
  retrying = 0;
  listeners.clear();
  if (emitTimer) clearTimeout(emitTimer);
  emitTimer = null;
  lastEmit = 0;
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

function abortError(): DOMException {
  return new DOMException('Request aborted', 'AbortError');
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

/**
 * Decide whether a failure is worth another attempt.
 *
 * @remarks
 * Only transient network conditions qualify:
 *
 * - `TypeError` — how `fetch` reports a dropped or refused connection.
 * - HTTP 5xx, which zarrita's `FetchStore` surfaces as
 *   `Unexpected response status <code>`.
 *
 * Aborts are the caller getting what it asked for. A 404 never reaches here
 * at all — `FetchStore` resolves missing keys as `undefined`, which is how
 * sparse stores signal an empty chunk. Other 4xx responses will not change
 * on a second attempt.
 */
function isRetryable(err: unknown): boolean {
  if (isAbort(err)) return false;
  if (err instanceof TypeError) return true;
  const message = (err as { message?: string } | null)?.message ?? '';
  const status = /Unexpected response status (\d+)/.exec(message);
  if (status) {
    const code = Number(status[1]);
    return code >= 500 && code < 600;
  }
  return false;
}

/** Wait `ms`, rejecting early if `signal` aborts rather than sleeping it out. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wrap a store so transient network failures are re-attempted.
 *
 * @remarks
 * Both `get` and `getRange` are covered. Delays grow 4× per attempt from
 * `baseDelayMs` (250 ms, then 1 s by default), each randomised by `jitter` so
 * a batch of tiles that failed together does not re-fire in lockstep. The
 * wrapper also maintains the counters behind {@link onNetworkActivity}.
 */
export const withRetry = zarr.defineStoreExtension((store, opts: RetryOptions = {}) => {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const jitter = opts.jitter ?? DEFAULT_JITTER;

  const boundGet = store.get.bind(store);
  const boundGetRange = store.getRange?.bind(store);

  function delayFor(attempt: number): number {
    const base = baseDelayMs * 4 ** attempt;
    return base * (1 + jitter * (Math.random() * 2 - 1));
  }

  async function attempt<T>(
    run: () => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    inflight++;
    notifyActivity();
    try {
      for (let i = 0; ; i++) {
        try {
          return await run();
        } catch (err) {
          if (i >= retries || !isRetryable(err) || signal?.aborted) throw err;
          retrying++;
          notifyActivity();
          try {
            await sleep(delayFor(i), signal);
          } finally {
            retrying--;
            notifyActivity();
          }
        }
      }
    } finally {
      inflight--;
      notifyActivity();
    }
  }

  return {
    get(key: AbsolutePath, options?: GetOptions): Promise<Uint8Array | undefined> {
      return attempt(() => boundGet(key, options), options?.signal);
    },
    ...(boundGetRange && {
      getRange(
        key: AbsolutePath,
        range: RangeQuery,
        options?: GetOptions,
      ): Promise<Uint8Array | undefined> {
        return attempt(() => boundGetRange(key, range, options), options?.signal);
      },
    }),
  };
});
