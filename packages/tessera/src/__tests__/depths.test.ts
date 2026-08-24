import { describe, it, expect } from 'vitest';
import { parseDepths, alignDepthWindow, depthWindowCost, groupTilesByChunk } from '../depths.js';

describe('parseDepths', () => {
  it('returns no depths when the store declares none', () => {
    expect(parseDepths({}, 128)).toEqual([]);
  });

  it('reads the declared depths in ascending order', () => {
    const attrs = {
      'geoemb:depths': [
        { dimensions: 128, array: 'embeddings' },
        { dimensions: 4, array: 'embeddings_d4' },
        { dimensions: 16, array: 'embeddings_d16' },
      ],
    };
    expect(parseDepths(attrs, 128)).toEqual([
      { dimensions: 4, array: 'embeddings_d4' },
      { dimensions: 16, array: 'embeddings_d16' },
      { dimensions: 128, array: 'embeddings' },
    ]);
  });

  it('drops depths deeper than the embeddings array', () => {
    const attrs = {
      'geoemb:depths': [
        { dimensions: 16, array: 'embeddings_d16' },
        { dimensions: 256, array: 'embeddings_d256' },
      ],
    };
    expect(parseDepths(attrs, 128)).toEqual([
      { dimensions: 16, array: 'embeddings_d16' },
    ]);
  });

  it('drops entries with no array name or a non-positive depth', () => {
    const attrs = {
      'geoemb:depths': [
        { dimensions: 4 },
        { dimensions: 0, array: 'embeddings_d0' },
        { dimensions: -8, array: 'embeddings_neg' },
        { array: 'embeddings' },
        { dimensions: 16, array: 'embeddings_d16' },
      ],
    };
    expect(parseDepths(attrs, 128)).toEqual([
      { dimensions: 16, array: 'embeddings_d16' },
    ]);
  });

  it('keeps the first entry when a depth is declared twice', () => {
    const attrs = {
      'geoemb:depths': [
        { dimensions: 4, array: 'embeddings_d4' },
        { dimensions: 4, array: 'embeddings_d4_alt' },
      ],
    };
    expect(parseDepths(attrs, 128)).toEqual([
      { dimensions: 4, array: 'embeddings_d4' },
    ]);
  });

  it('ignores a malformed geoemb:depths attribute', () => {
    expect(parseDepths({ 'geoemb:depths': 'embeddings_d4' }, 128)).toEqual([]);
  });
});

describe('alignDepthWindow', () => {
  it('snaps the window origin down onto the block grid', () => {
    expect(alignDepthWindow(200, 70, 128, 4096, 4096)).toEqual({
      r0: 128, c0: 0, height: 128, width: 128,
    });
  });

  it('leaves an already-aligned origin alone', () => {
    expect(alignDepthWindow(256, 128, 128, 4096, 4096)).toEqual({
      r0: 256, c0: 128, height: 128, width: 128,
    });
  });

  it('truncates the window at the array edge', () => {
    expect(alignDepthWindow(4000, 4000, 128, 4050, 4030)).toEqual({
      r0: 3968, c0: 3968, height: 82, width: 62,
    });
  });

  it('shrinks to the array when it is smaller than one block', () => {
    expect(alignDepthWindow(10, 10, 128, 40, 100)).toEqual({
      r0: 0, c0: 0, height: 40, width: 100,
    });
  });
});

describe('depthWindowCost', () => {
  const window = { r0: 0, c0: 0, height: 128, width: 128 };

  it('charges one chunk for a window that fits inside one', () => {
    expect(depthWindowCost(window, 128, 128, 4)).toEqual({
      chunks: 1, bytes: 128 * 128 * 4,
    });
  });

  it('charges every chunk the window touches', () => {
    // 128x128 px window over 32x32 px chunks = a 4x4 block of chunks.
    expect(depthWindowCost(window, 32, 32, 128)).toEqual({
      chunks: 16, bytes: 16 * 32 * 32 * 128,
    });
  });

  it('counts chunks straddled by an unaligned window', () => {
    // Rows 30..40 straddle the boundary at 32; columns 0..9 stay in one chunk.
    expect(depthWindowCost({ r0: 30, c0: 0, height: 10, width: 10 }, 32, 32, 1))
      .toEqual({ chunks: 2, bytes: 2 * 32 * 32 });
  });

  it('costs 32x less at d4 than at d128 over the same footprint', () => {
    const d4 = depthWindowCost(window, 128, 128, 4);
    const d128 = depthWindowCost(window, 32, 32, 128);
    expect(d128.bytes / d4.bytes).toBe(32);
  });
});

describe('groupTilesByChunk', () => {
  it('reads each tile on its own when the chunk is one tile', () => {
    // Full depth: the store's chunk IS the region's tile.
    const groups = groupTilesByChunk(
      [{ ci: 0, cj: 0 }, { ci: 0, cj: 1 }], 32, 32, 32, 32, 4096, 4096,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ r0: 0, c0: 0, height: 32, width: 32, tiles: [{ ci: 0, cj: 0 }] });
    expect(groups[1]).toEqual({ r0: 0, c0: 32, height: 32, width: 32, tiles: [{ ci: 0, cj: 1 }] });
  });

  it('reads tiles sharing a chunk in one go', () => {
    // d16: one 64x64 chunk covers a 2x2 block of 32x32 tiles.
    const tiles = [{ ci: 0, cj: 0 }, { ci: 0, cj: 1 }, { ci: 1, cj: 0 }, { ci: 1, cj: 1 }];
    const groups = groupTilesByChunk(tiles, 32, 32, 64, 64, 4096, 4096);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ r0: 0, c0: 0, height: 64, width: 64 });
    expect(groups[0].tiles).toHaveLength(4);
  });

  it('splits tiles that fall in different chunks', () => {
    const groups = groupTilesByChunk(
      [{ ci: 0, cj: 0 }, { ci: 2, cj: 0 }], 32, 32, 64, 64, 4096, 4096,
    );
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.r0)).toEqual([0, 64]);
  });

  it('carries only the tiles that were asked for', () => {
    // One tile of a 2x2 chunk: the read still covers the whole chunk, but the
    // group must not claim neighbours the caller never requested.
    const groups = groupTilesByChunk([{ ci: 1, cj: 1 }], 32, 32, 64, 64, 4096, 4096);
    expect(groups[0].tiles).toEqual([{ ci: 1, cj: 1 }]);
    expect(groups[0]).toMatchObject({ r0: 0, c0: 0, height: 64, width: 64 });
  });

  it('clips the read at the array edge', () => {
    const edge = groupTilesByChunk([{ ci: 2, cj: 2 }], 32, 32, 64, 64, 100, 80);
    expect(edge[0]).toMatchObject({ r0: 64, c0: 64, height: 36, width: 16 });
  });

  it('returns nothing for no tiles', () => {
    expect(groupTilesByChunk([], 32, 32, 64, 64, 4096, 4096)).toEqual([]);
  });
});
