/**
 * Store extensions that keep concurrent readers from trampling each other.
 *
 * @remarks
 * Two problems show up as soon as several map tiles read one Zarr store at
 * once, and both surface as spurious network errors when the user zooms:
 *
 * 1. **Duplicate chunk fetches.** Neighbouring tiles overlap the same Zarr
 *    chunk, and nothing dedupes them — a row of six MapLibre tiles issues
 *    twelve HTTP requests for four distinct chunks. The extra connections
 *    are pure waste, and under Safari's connection limits an abort storm on
 *    one of them can take unrelated in-flight requests down with it.
 *    {@link withRequestCoalescing} collapses concurrent reads of one key
 *    into a single fetch.
 *
 * 2. **Cancellation that spreads.** Once readers share a request, cancelling
 *    one must not cancel the rest. Both extensions here abort the shared
 *    fetch only after *every* participant has aborted; a participant that
 *    cancels early is rejected immediately with an `AbortError` so its
 *    caller settles at once, while the fetch continues for whoever is left.
 *
 * This is why {@link withRangeCoalescing} replaces zarrita's extension of
 * the same name rather than wrapping it: upstream merges participant signals
 * with `AbortSignal.any()`, which tears the shared fetch down as soon as any
 * one participant aborts.
 */
import * as zarr from 'zarrita';
import type { AbsolutePath, GetOptions, RangeQuery } from 'zarrita';

/** Default gap, in bytes, that two ranges may straddle and still coalesce. */
const DEFAULT_COALESCE_SIZE = 32768;

export interface RangeCoalescingOptions {
  /** Maximum byte gap to bridge when merging ranges. Default 32 KiB. */
  coalesceSize?: number;
}

interface PendingRequest {
  offset: number;
  length: number;
  signal?: AbortSignal;
  resolve: (value: Uint8Array | undefined) => void;
  reject: (err: unknown) => void;
  /** Set once the caller has been resolved or rejected. */
  settled: boolean;
}

interface RequestGroup {
  offset: number;
  length: number;
  requests: PendingRequest[];
}

function abortError(): DOMException {
  return new DOMException('Request aborted', 'AbortError');
}

/**
 * A reader waiting on a shared fetch.
 *
 * @remarks
 * `onSelfAbort` runs when this participant's own signal fires, so it can be
 * rejected without disturbing the others.
 */
interface Participant {
  signal?: AbortSignal;
  onSelfAbort(): void;
}

/**
 * Build the signal for a fetch shared by several participants.
 *
 * @param participants - Readers sharing the request.
 * @param cleanup - Aborting this detaches the listeners this call attaches.
 * @returns A signal that fires once every participant has aborted, or
 *   `undefined` when some participant cannot cancel and the fetch must
 *   therefore always run to completion.
 */
function sharedSignal(
  participants: Participant[],
  cleanup: AbortSignal,
): AbortSignal | undefined {
  if (participants.some(p => !p.signal)) {
    // An uncancellable reader keeps the fetch alive, but the others still
    // need to hear about their own cancellation.
    for (const p of participants) {
      if (p.signal) {
        p.signal.addEventListener('abort', () => p.onSelfAbort(), { once: true, signal: cleanup });
      }
    }
    return undefined;
  }

  const ctrl = new AbortController();
  let live = participants.length;
  for (const p of participants) {
    const onAbort = (): void => {
      p.onSelfAbort();
      if (--live === 0) ctrl.abort(abortError());
    };
    if (p.signal!.aborted) onAbort();
    else p.signal!.addEventListener('abort', onAbort, { once: true, signal: cleanup });
  }
  return ctrl.signal;
}

/** Group sorted requests, bridging gaps no larger than `coalesceSize`. */
function groupRequests(sorted: PendingRequest[], coalesceSize: number): RequestGroup[] {
  if (sorted.length === 0) return [];
  const groups: RequestGroup[] = [];
  let current = [sorted[0]];
  let groupStart = sorted[0].offset;
  let groupEnd = sorted[0].offset + sorted[0].length;

  for (let i = 1; i < sorted.length; i++) {
    const req = sorted[i];
    const reqEnd = req.offset + req.length;
    if (req.offset <= groupEnd + coalesceSize) {
      current.push(req);
      groupEnd = Math.max(groupEnd, reqEnd);
    } else {
      groups.push({ offset: groupStart, length: groupEnd - groupStart, requests: current });
      current = [req];
      groupStart = req.offset;
      groupEnd = reqEnd;
    }
  }
  groups.push({ offset: groupStart, length: groupEnd - groupStart, requests: current });
  return groups;
}

/**
 * Wrap a range-capable store with microtask range batching.
 *
 * @remarks
 * Compose with {@link https://zarrita.dev | zarrita}'s `extendStore`:
 *
 * ```ts
 * const store = await zarr.extendStore(
 *   new zarr.FetchStore(url),
 *   withRangeCoalescing,
 * );
 * ```
 *
 * Suffix reads (shard index fetches) are passed straight through — the file
 * size is unknown until the response arrives, so they cannot be grouped.
 */
export const withRangeCoalescing = zarr.defineStoreExtension(
  (store, opts: RangeCoalescingOptions = {}) => {
    if (!store.getRange) {
      throw new Error('withRangeCoalescing requires a store with getRange');
    }
    const boundGetRange = store.getRange.bind(store);
    const coalesceSize = opts.coalesceSize ?? DEFAULT_COALESCE_SIZE;

    const pending = new Map<AbsolutePath, PendingRequest[]>();
    let scheduled = false;

    /** Signal for one group's shared fetch. */
    function groupSignal(requests: PendingRequest[], cleanup: AbortSignal): AbortSignal | undefined {
      return sharedSignal(
        requests.map(req => ({
          signal: req.signal,
          // Reject this caller as soon as *it* is cancelled, without waiting
          // for the shared fetch — the tile that asked to be dropped settles
          // immediately, the rest carry on.
          onSelfAbort: () => {
            if (req.settled) return;
            req.settled = true;
            req.reject(abortError());
          },
        })),
        cleanup,
      );
    }

    async function fetchGroup(path: AbsolutePath, group: RequestGroup): Promise<void> {
      // Aborting `cleanup` detaches every per-request abort listener once the
      // group settles, so long-lived caller signals don't accumulate them.
      const cleanup = new AbortController();
      const signal = groupSignal(group.requests, cleanup.signal);

      try {
        const data = await boundGetRange(
          path,
          { offset: group.offset, length: group.length },
          { signal },
        );
        if (data && data.length < group.length) {
          throw new Error(
            `Short read: expected ${group.length} bytes but received ${data.length}`,
          );
        }
        for (const req of group.requests) {
          if (req.settled) continue;
          req.settled = true;
          if (!data) {
            req.resolve(undefined);
            continue;
          }
          const start = req.offset - group.offset;
          req.resolve(data.slice(start, start + req.length));
        }
      } catch (err) {
        for (const req of group.requests) {
          if (req.settled) continue;
          req.settled = true;
          req.reject(err);
        }
      } finally {
        cleanup.abort();
      }
    }

    async function flush(): Promise<void> {
      const work = new Map(pending);
      pending.clear();
      scheduled = false;

      const all: Promise<void>[] = [];
      for (const [path, requests] of work) {
        requests.sort((a, b) => a.offset - b.offset);
        for (const group of groupRequests(requests, coalesceSize)) {
          all.push(fetchGroup(path, group));
        }
      }
      await Promise.all(all);
    }

    return {
      getRange(
        key: AbsolutePath,
        range: RangeQuery,
        options?: GetOptions,
      ): Promise<Uint8Array | undefined> {
        if ('suffixLength' in range) {
          return boundGetRange(key, range, options);
        }
        const { offset, length } = range;
        return new Promise<Uint8Array | undefined>((resolve, reject) => {
          let reqs = pending.get(key);
          if (!reqs) {
            reqs = [];
            pending.set(key, reqs);
          }
          reqs.push({ offset, length, signal: options?.signal, resolve, reject, settled: false });
          if (!scheduled) {
            scheduled = true;
            queueMicrotask(() => flush());
          }
        });
      },
    };
  },
);

interface InflightRead {
  key: AbsolutePath;
  /** The single underlying fetch every participant is waiting on. */
  promise: Promise<Uint8Array | undefined>;
  /** Aborts the underlying fetch once no participant wants it any more. */
  ctrl: AbortController;
  /** Detaches this read's abort listeners when it settles. */
  cleanup: AbortController;
  /** Participants that have neither resolved nor cancelled. */
  live: number;
  /** True once a participant with no signal joins — the fetch can't be cancelled. */
  uncancellable: boolean;
}

/**
 * Collapse concurrent `get()` calls for the same key into one fetch.
 *
 * @remarks
 * Adjacent map tiles routinely overlap the same Zarr chunk. Without this,
 * each tile issues its own request for those shared bytes: a row of six
 * MapLibre tiles was measured issuing twelve requests for four chunks. Every
 * duplicate burns one of the browser's few connections to the host, and when
 * a zoom cancels a batch of them, Safari has been observed dropping the
 * connection out from under the requests that were *not* cancelled.
 *
 * Callers arriving while a read is in flight join it instead of starting
 * their own. The shared fetch is aborted only once every participant has
 * aborted, so one cancelled tile never strands its neighbours. Participants
 * that pass no signal make the read uncancellable, since nothing can speak
 * for them.
 *
 * This is in-flight deduplication only — nothing is retained after a read
 * settles. Compose with zarrita's `withByteCaching` for a real cache.
 *
 * @remarks
 * Participants share one `Uint8Array` rather than a copy, matching the
 * convention that store responses are not mutated by their consumers.
 */
export const withRequestCoalescing = zarr.defineStoreExtension((store) => {
  const boundGet = store.get.bind(store);
  const inflight = new Map<AbsolutePath, InflightRead>();

  /** Attach `signal` to an in-flight read and hand back that caller's view of it. */
  function join(
    read: InflightRead,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array | undefined> {
    read.live++;
    if (!signal) {
      read.uncancellable = true;
      return read.promise;
    }

    return new Promise<Uint8Array | undefined>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(abortError());
        if (--read.live === 0 && !read.uncancellable) {
          // Last one out: drop the entry first so a late caller starts a
          // fresh read rather than joining one that is about to abort.
          if (inflight.get(read.key) === read) inflight.delete(read.key);
          read.ctrl.abort(abortError());
        }
      };
      signal.addEventListener('abort', onAbort, { once: true, signal: read.cleanup.signal });

      read.promise.then(
        (value) => { if (!settled) { settled = true; resolve(value); } },
        (err) => { if (!settled) { settled = true; reject(err); } },
      );
    });
  }

  return {
    get(key: AbsolutePath, options?: GetOptions): Promise<Uint8Array | undefined> {
      if (options?.signal?.aborted) return Promise.reject(abortError());

      let read = inflight.get(key);
      if (!read) {
        const ctrl = new AbortController();
        const entry: InflightRead = {
          key,
          ctrl,
          cleanup: new AbortController(),
          live: 0,
          uncancellable: false,
          promise: undefined as never,
        };
        entry.promise = boundGet(key, { ...options, signal: ctrl.signal }).finally(() => {
          if (inflight.get(key) === entry) inflight.delete(key);
          entry.cleanup.abort();
        });
        // Participants attach their own handlers; keep the shared promise from
        // counting as unhandled if every one of them cancels first.
        entry.promise.catch(() => { /* surfaced per participant */ });
        inflight.set(key, entry);
        read = entry;
      }
      return join(read, options?.signal);
    },
  };
});
