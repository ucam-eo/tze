import { describe, it, expect } from 'vitest';
import * as zarr from 'zarrita';
import type { AsyncReadable } from 'zarrita';
import { withRangeCoalescing, withRequestCoalescing } from '../coalescing.js';

/** Fake range-capable store: resolves after a tick, rejects on abort. */
function makeStore() {
  const fetches: { offset: number; length: number; aborted: boolean }[] = [];
  return {
    fetches,
    async get() { return undefined; },
    async getRange(_key: string, range: any, opts?: { signal?: AbortSignal }) {
      const record = { offset: range.offset, length: range.length, aborted: false };
      fetches.push(record);
      return new Promise<Uint8Array>((resolve, reject) => {
        const t = setTimeout(() => resolve(new Uint8Array(range.length)), 10);
        opts?.signal?.addEventListener('abort', () => {
          record.aborted = true;
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    },
  };
}

type FakeStore = ReturnType<typeof makeStore>;
/** `extendStore` needs an AsyncReadable; the fake satisfies it structurally. */
async function wrap(base: FakeStore) {
  return await zarr.extendStore(base as unknown as Required<AsyncReadable>, withRangeCoalescing);
}

describe('withRangeCoalescing', () => {
  it('merges adjacent ranges into a single fetch', async () => {
    const base = makeStore();
    const store = await wrap(base);
    await Promise.all([
      store.getRange('/tile', { offset: 0, length: 10 }),
      store.getRange('/tile', { offset: 10, length: 10 }),
    ]);
    expect(base.fetches).toEqual([{ offset: 0, length: 20, aborted: false }]);
  });

  it('slices the coalesced blob back into per-caller ranges', async () => {
    const base = makeStore();
    const store = await wrap(base);
    const [a, b] = await Promise.all([
      store.getRange('/tile', { offset: 0, length: 4 }),
      store.getRange('/tile', { offset: 8, length: 6 }),
    ]);
    expect(a).toHaveLength(4);
    expect(b).toHaveLength(6);
  });

  it('does not group ranges separated by more than coalesceSize', async () => {
    const base = makeStore();
    const store = await zarr.extendStore(
      base as unknown as Required<AsyncReadable>,
      s => withRangeCoalescing(s, { coalesceSize: 16 }),
    );
    await Promise.all([
      store.getRange('/tile', { offset: 0, length: 10 }),
      store.getRange('/tile', { offset: 1000, length: 10 }),
    ]);
    expect(base.fetches).toHaveLength(2);
  });

  it('keeps serving co-tenants when one participant is cancelled', async () => {
    const base = makeStore();
    const store = await wrap(base);
    const a = new AbortController();
    const b = new AbortController();
    const pa = store.getRange('/tile', { offset: 0, length: 10 }, { signal: a.signal });
    const pb = store.getRange('/tile', { offset: 10, length: 10 }, { signal: b.signal });
    pa.catch(() => { /* cancelled on purpose */ });

    await Promise.resolve();
    a.abort();

    await expect(pb).resolves.toBeInstanceOf(Uint8Array);
    expect(base.fetches[0].aborted).toBe(false);
  });

  it('rejects a cancelled participant immediately with AbortError', async () => {
    const base = makeStore();
    const store = await wrap(base);
    const a = new AbortController();
    const b = new AbortController();
    const pa = store.getRange('/tile', { offset: 0, length: 10 }, { signal: a.signal });
    const pb = store.getRange('/tile', { offset: 10, length: 10 }, { signal: b.signal });
    pb.catch(() => {});

    await Promise.resolve();
    a.abort();

    // Settles on the abort, not on the (still pending) shared fetch.
    await expect(pa).rejects.toMatchObject({ name: 'AbortError' });
    expect(base.fetches[0].aborted).toBe(false);
    await pb;
  });

  it('aborts the shared fetch once every participant has cancelled', async () => {
    const base = makeStore();
    const store = await wrap(base);
    const a = new AbortController();
    const b = new AbortController();
    const pa = store.getRange('/tile', { offset: 0, length: 10 }, { signal: a.signal });
    const pb = store.getRange('/tile', { offset: 10, length: 10 }, { signal: b.signal });
    pa.catch(() => {}); pb.catch(() => {});

    await Promise.resolve();
    a.abort();
    expect(base.fetches[0].aborted).toBe(false);
    b.abort();

    await expect(pa).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pb).rejects.toMatchObject({ name: 'AbortError' });
    expect(base.fetches[0].aborted).toBe(true);
  });

  it('never aborts a group containing an uncancellable participant', async () => {
    const base = makeStore();
    const store = await wrap(base);
    const a = new AbortController();
    const pa = store.getRange('/tile', { offset: 0, length: 10 }, { signal: a.signal });
    const pb = store.getRange('/tile', { offset: 10, length: 10 }); // no signal
    pa.catch(() => {});

    await Promise.resolve();
    a.abort();

    await expect(pb).resolves.toBeInstanceOf(Uint8Array);
    expect(base.fetches[0].aborted).toBe(false);
  });

  it('passes suffix reads straight through without batching', async () => {
    const base = makeStore();
    const store = await wrap(base);
    await store.getRange('/tile', { suffixLength: 32 });
    expect(base.fetches).toEqual([{ offset: undefined, length: undefined, aborted: false }]);
  });

  it('propagates a real fetch failure to every participant', async () => {
    const base = makeStore();
    base.getRange = async () => { throw new Error('boom'); };
    const store = await wrap(base);
    const pa = store.getRange('/tile', { offset: 0, length: 10 });
    const pb = store.getRange('/tile', { offset: 10, length: 10 });
    await expect(pa).rejects.toThrow('boom');
    await expect(pb).rejects.toThrow('boom');
  });
});

/** Fake store whose `get` resolves after a tick and rejects on abort. */
function makeGetStore() {
  const gets: { key: string; aborted: boolean }[] = [];
  return {
    gets,
    async get(key: string, opts?: { signal?: AbortSignal }) {
      const record = { key, aborted: false };
      gets.push(record);
      return new Promise<Uint8Array>((resolve, reject) => {
        const t = setTimeout(() => resolve(new Uint8Array([1, 2, 3])), 10);
        opts?.signal?.addEventListener('abort', () => {
          record.aborted = true;
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    },
  };
}

async function wrapGet(base: ReturnType<typeof makeGetStore>) {
  return await zarr.extendStore(base as unknown as AsyncReadable, withRequestCoalescing);
}

describe('withRequestCoalescing', () => {
  it('collapses concurrent reads of one key into a single fetch', async () => {
    const base = makeGetStore();
    const store = await wrapGet(base);
    const results = await Promise.all([
      store.get('/c/0/0'), store.get('/c/0/0'), store.get('/c/0/0'),
    ]);
    expect(base.gets).toHaveLength(1);
    for (const r of results) expect(r).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('does not collapse reads of different keys', async () => {
    const base = makeGetStore();
    const store = await wrapGet(base);
    await Promise.all([store.get('/c/0/0'), store.get('/c/0/1')]);
    expect(base.gets).toHaveLength(2);
  });

  it('starts a fresh fetch once the previous one has settled', async () => {
    const base = makeGetStore();
    const store = await wrapGet(base);
    await store.get('/c/0/0');
    await store.get('/c/0/0');
    expect(base.gets).toHaveLength(2);
  });

  it('keeps serving the other tiles when one is cancelled', async () => {
    const base = makeGetStore();
    const store = await wrapGet(base);
    const a = new AbortController();
    const b = new AbortController();
    const pa = store.get('/c/0/0', { signal: a.signal });
    const pb = store.get('/c/0/0', { signal: b.signal });
    pa.catch(() => {});

    a.abort();

    await expect(pa).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pb).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(base.gets).toHaveLength(1);
    expect(base.gets[0].aborted).toBe(false);
  });

  it('aborts the shared fetch once every tile has cancelled', async () => {
    const base = makeGetStore();
    const store = await wrapGet(base);
    const a = new AbortController();
    const b = new AbortController();
    const pa = store.get('/c/0/0', { signal: a.signal });
    const pb = store.get('/c/0/0', { signal: b.signal });
    pa.catch(() => {}); pb.catch(() => {});

    a.abort();
    expect(base.gets[0].aborted).toBe(false);
    b.abort();

    await expect(pa).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pb).rejects.toMatchObject({ name: 'AbortError' });
    expect(base.gets[0].aborted).toBe(true);
  });

  it('never aborts a read joined by an uncancellable caller', async () => {
    const base = makeGetStore();
    const store = await wrapGet(base);
    const a = new AbortController();
    const pa = store.get('/c/0/0', { signal: a.signal });
    const pb = store.get('/c/0/0'); // no signal
    pa.catch(() => {});

    a.abort();

    await expect(pb).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(base.gets[0].aborted).toBe(false);
  });

  it('lets a later caller start a new read after the shared one was abandoned', async () => {
    const base = makeGetStore();
    const store = await wrapGet(base);
    const a = new AbortController();
    const pa = store.get('/c/0/0', { signal: a.signal });
    pa.catch(() => {});
    a.abort();
    await expect(pa).rejects.toMatchObject({ name: 'AbortError' });

    await expect(store.get('/c/0/0')).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(base.gets).toHaveLength(2);
  });

  it('rejects immediately when the caller signal is already aborted', async () => {
    const base = makeGetStore();
    const store = await wrapGet(base);
    const a = new AbortController();
    a.abort();
    await expect(store.get('/c/0/0', { signal: a.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(base.gets).toHaveLength(0);
  });

  it('propagates a real failure to every participant', async () => {
    const base = makeGetStore();
    base.get = async () => { throw new Error('boom'); };
    const store = await wrapGet(base);
    const pa = store.get('/c/0/0');
    const pb = store.get('/c/0/0');
    await expect(pa).rejects.toThrow('boom');
    await expect(pb).rejects.toThrow('boom');
  });
});
