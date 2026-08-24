import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as zarr from 'zarrita';
import type { AsyncReadable } from 'zarrita';
import {
  withRetry,
  onNetworkActivity,
  getNetworkActivity,
  _resetNetworkActivity,
  type NetworkActivity,
} from '../retry.js';

/**
 * Store whose `get` replays a scripted sequence of outcomes.
 *
 * `delayMs` models a request that is genuinely in flight for a while; the
 * default of 0 settles within a microtask, which the activity throttle is
 * designed to render invisible.
 */
function scriptedStore(outcomes: (Uint8Array | undefined | Error)[], delayMs = 0) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async get(_key: string, opts?: { signal?: AbortSignal }) {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
      calls++;
      if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    async getRange(_key: string, _range: unknown, opts?: { signal?: AbortSignal }) {
      return this.get(_key, opts);
    },
  };
}

/** No jitter and no real delay, so tests assert behaviour rather than timing. */
async function wrap(base: unknown, opts = {}) {
  return await zarr.extendStore(
    base as AsyncReadable,
    s => withRetry(s, { baseDelayMs: 1, jitter: 0, ...opts }),
  );
}

function status(code: number): Error {
  return new Error(`Unexpected response status ${code} Server Error`);
}

beforeEach(() => { _resetNetworkActivity(); });

describe('withRetry', () => {
  it('returns the value without retrying when the first attempt succeeds', async () => {
    const base = scriptedStore([new Uint8Array([1])]);
    const store = await wrap(base);
    await expect(store.get('/c/0')).resolves.toEqual(new Uint8Array([1]));
    expect(base.calls).toBe(1);
  });

  it('retries a dropped connection and succeeds on the second attempt', async () => {
    const base = scriptedStore([new TypeError('Load failed'), new Uint8Array([7])]);
    const store = await wrap(base);
    await expect(store.get('/c/0')).resolves.toEqual(new Uint8Array([7]));
    expect(base.calls).toBe(2);
  });

  it('retries a 5xx response', async () => {
    const base = scriptedStore([status(503), new Uint8Array([1])]);
    const store = await wrap(base);
    await expect(store.get('/c/0')).resolves.toEqual(new Uint8Array([1]));
    expect(base.calls).toBe(2);
  });

  it('gives up after the configured number of retries and surfaces the last error', async () => {
    const base = scriptedStore([new TypeError('Load failed')]);
    const store = await wrap(base, { retries: 2 });
    await expect(store.get('/c/0')).rejects.toThrow('Load failed');
    expect(base.calls).toBe(3); // initial attempt + 2 retries
  });

  it('does not retry an abort', async () => {
    const base = scriptedStore([new DOMException('Aborted', 'AbortError')]);
    const store = await wrap(base);
    await expect(store.get('/c/0')).rejects.toMatchObject({ name: 'AbortError' });
    expect(base.calls).toBe(1);
  });

  it('does not retry a 4xx response', async () => {
    const base = scriptedStore([status(403)]);
    const store = await wrap(base);
    await expect(store.get('/c/0')).rejects.toThrow('403');
    expect(base.calls).toBe(1);
  });

  it('does not treat a missing chunk as a failure', async () => {
    // FetchStore resolves 404 as undefined — a sparse store's empty chunk.
    const base = scriptedStore([undefined]);
    const store = await wrap(base);
    await expect(store.get('/c/0')).resolves.toBeUndefined();
    expect(base.calls).toBe(1);
  });

  it('stops retrying once the caller aborts during backoff', async () => {
    const base = scriptedStore([new TypeError('Load failed')]);
    const store = await wrap(base, { baseDelayMs: 5000 });
    const ctrl = new AbortController();
    const p = store.get('/c/0', { signal: ctrl.signal });
    p.catch(() => {});
    await new Promise(r => setTimeout(r, 10));
    ctrl.abort();
    // Rejects on the abort rather than sleeping out the 5s backoff.
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(base.calls).toBe(1);
  });

  it('retries range reads too', async () => {
    const base = scriptedStore([new TypeError('Load failed'), new Uint8Array([9])]);
    const store = await wrap(base);
    await expect(store.getRange!('/c/0', { offset: 0, length: 1 }))
      .resolves.toEqual(new Uint8Array([9]));
    expect(base.calls).toBe(2);
  });
});

describe('network activity', () => {
  it('reports in-flight requests and returns to idle on success', async () => {
    const base = scriptedStore([new Uint8Array([1])], 60);
    const store = await wrap(base);
    const seen: NetworkActivity[] = [];
    const off = onNetworkActivity(a => seen.push({ ...a }));

    const p = store.get('/c/0');
    await new Promise(r => setTimeout(r, 100));
    expect(seen.some(a => a.inflight > 0)).toBe(true);

    await p;
    await new Promise(r => setTimeout(r, 100));
    expect(getNetworkActivity()).toEqual({ inflight: 0, retrying: 0 });
    off();
  });

  it('reports a retry in progress', async () => {
    const base = scriptedStore([new TypeError('Load failed'), new Uint8Array([1])]);
    const store = await wrap(base, { baseDelayMs: 120 });
    const seen: NetworkActivity[] = [];
    const off = onNetworkActivity(a => seen.push({ ...a }));

    await store.get('/c/0');
    await new Promise(r => setTimeout(r, 120));

    expect(seen.some(a => a.retrying > 0)).toBe(true);
    expect(getNetworkActivity()).toEqual({ inflight: 0, retrying: 0 });
    off();
  });

  it('returns to idle when a request fails outright', async () => {
    const base = scriptedStore([status(403)]);
    const store = await wrap(base);
    await expect(store.get('/c/0')).rejects.toThrow();
    await new Promise(r => setTimeout(r, 100));
    expect(getNetworkActivity()).toEqual({ inflight: 0, retrying: 0 });
  });

  it('throttles notifications during a burst', async () => {
    const base = scriptedStore([new Uint8Array([1])], 5);
    const store = await wrap(base);
    const listener = vi.fn();
    const off = onNetworkActivity(listener);
    listener.mockClear(); // ignore the priming call

    await Promise.all(Array.from({ length: 50 }, () => store.get('/c/0')));
    await new Promise(r => setTimeout(r, 200));

    // 100 counter changes; throttling keeps notifications to a handful.
    expect(listener.mock.calls.length).toBeLessThan(10);
    expect(listener.mock.calls.some(([a]) => a.inflight > 0)).toBe(true);
    expect(getNetworkActivity()).toEqual({ inflight: 0, retrying: 0 });
    off();
  });

  it('does not flicker for a request that settles immediately', async () => {
    const base = scriptedStore([new Uint8Array([1])]);
    const store = await wrap(base);
    const listener = vi.fn();
    const off = onNetworkActivity(listener);
    listener.mockClear();

    await store.get('/c/0');
    await new Promise(r => setTimeout(r, 150));

    expect(listener.mock.calls.every(([a]) => a.inflight === 0)).toBe(true);
    off();
  });

  it('stops notifying after unsubscribe', async () => {
    const base = scriptedStore([new Uint8Array([1])], 30);
    const store = await wrap(base);
    const listener = vi.fn();
    onNetworkActivity(listener)();
    listener.mockClear();
    await store.get('/c/0');
    await new Promise(r => setTimeout(r, 150));
    expect(listener).not.toHaveBeenCalled();
  });
});
