import { describe, it, expect } from 'vitest';
import {
  meanEmbedding,
  devianceMap,
  similarityMap,
  pearson,
  topKOverlap,
  prefixMaxDiff,
  meanAbsDiff,
  blockNormMap,
  bandRanges,
  scalarRange,
  rgbaFromBands,
  rgbaFromScalar,
} from '../depth-compare.js';

/** Pixel-major embedding buffer from per-pixel vectors. */
function buf(...pixels: number[][]): Float32Array {
  return new Float32Array(pixels.flat());
}

/** A pixel with no data: NaN across every band. */
function nodata(nBands: number): number[] {
  return Array<number>(nBands).fill(NaN);
}

describe('meanEmbedding', () => {
  it('averages the valid pixels band by band', () => {
    const mean = meanEmbedding(buf([1, 10], [3, 20]), 2, 2);
    expect(Array.from(mean!)).toEqual([2, 15]);
  });

  it('leaves nodata pixels out of the average', () => {
    const mean = meanEmbedding(buf([1, 10], nodata(2), [3, 20]), 3, 2);
    expect(Array.from(mean!)).toEqual([2, 15]);
  });

  it('returns null when no pixel has data', () => {
    expect(meanEmbedding(buf(nodata(2), nodata(2)), 2, 2)).toBeNull();
  });
});

describe('devianceMap', () => {
  it('is zero where a pixel points the same way as the mean', () => {
    const dev = devianceMap(buf([1, 0], [2, 0]), 2, 2);
    expect(dev[0]).toBeCloseTo(0, 6);
    expect(dev[1]).toBeCloseTo(0, 6);
  });

  it('is one where a pixel is orthogonal to the mean', () => {
    // Mean of these three is [0, 1/3]; the first two are orthogonal to it.
    const dev = devianceMap(buf([1, 0], [-1, 0], [0, 1]), 3, 2);
    expect(dev[0]).toBeCloseTo(1, 6);
    expect(dev[1]).toBeCloseTo(1, 6);
    expect(dev[2]).toBeCloseTo(0, 6);
  });

  it('marks nodata pixels NaN', () => {
    const dev = devianceMap(buf([1, 0], nodata(2)), 2, 2);
    expect(dev[0]).toBeCloseTo(0, 6);
    expect(Number.isNaN(dev[1])).toBe(true);
  });

  it('marks zero-length pixels NaN, having no direction to compare', () => {
    const dev = devianceMap(buf([1, 0], [0, 0]), 2, 2);
    expect(Number.isNaN(dev[1])).toBe(true);
  });
});

describe('similarityMap', () => {
  it('scores the reference pixel itself 1', () => {
    const sim = similarityMap(buf([3, 4], [0, 1]), 2, 2, 0);
    expect(sim[0]).toBeCloseTo(1, 6);
  });

  it('scores an opposed pixel -1', () => {
    const sim = similarityMap(buf([1, 0], [-1, 0]), 2, 2, 0);
    expect(sim[1]).toBeCloseTo(-1, 6);
  });

  it('is all NaN when the reference pixel has no data', () => {
    const sim = similarityMap(buf(nodata(2), [1, 0]), 2, 2, 0);
    expect(Array.from(sim).every(Number.isNaN)).toBe(true);
  });
});

describe('pearson', () => {
  it('is 1 for two series that rise together', () => {
    const r = pearson(new Float32Array([1, 2, 3]), new Float32Array([10, 20, 30]));
    expect(r).toBeCloseTo(1, 6);
  });

  it('is -1 when one series falls as the other rises', () => {
    const r = pearson(new Float32Array([1, 2, 3]), new Float32Array([30, 20, 10]));
    expect(r).toBeCloseTo(-1, 6);
  });

  it('ignores positions where either series is NaN', () => {
    const r = pearson(
      new Float32Array([1, NaN, 2, 3]),
      new Float32Array([10, 99, 20, 30]),
    );
    expect(r).toBeCloseTo(1, 6);
  });

  it('is NaN when a series never varies', () => {
    const r = pearson(new Float32Array([5, 5, 5]), new Float32Array([1, 2, 3]));
    expect(Number.isNaN(r)).toBe(true);
  });
});

describe('topKOverlap', () => {
  it('is 1 when both rank the same pixels highest', () => {
    const a = new Float32Array([9, 8, 1, 0]);
    const b = new Float32Array([7, 9, 2, 1]);
    expect(topKOverlap(a, b, 2)).toBe(1);
  });

  it('is 0 when the top sets are disjoint', () => {
    const a = new Float32Array([9, 8, 1, 0]);
    const b = new Float32Array([0, 1, 8, 9]);
    expect(topKOverlap(a, b, 2)).toBe(0);
  });

  it('leaves NaN entries out of the ranking', () => {
    const a = new Float32Array([NaN, 8, 1, 0]);
    const b = new Float32Array([NaN, 9, 2, 1]);
    expect(topKOverlap(a, b, 2)).toBe(1);
  });

  it('is NaN when fewer than k pixels have scores', () => {
    const a = new Float32Array([1, NaN]);
    const b = new Float32Array([1, NaN]);
    expect(Number.isNaN(topKOverlap(a, b, 2))).toBe(true);
  });
});

describe('meanAbsDiff', () => {
  it('averages the gap between two maps', () => {
    const d = meanAbsDiff(new Float32Array([1, 2]), new Float32Array([2, 4]));
    expect(d).toBeCloseTo(1.5, 6);
  });

  it('ignores positions where either map is NaN', () => {
    const d = meanAbsDiff(
      new Float32Array([1, NaN, 3]),
      new Float32Array([2, 99, 4]),
    );
    expect(d).toBeCloseTo(1, 6);
  });

  it('is NaN when the maps share no scored position', () => {
    const d = meanAbsDiff(new Float32Array([NaN]), new Float32Array([1]));
    expect(Number.isNaN(d)).toBe(true);
  });
});

describe('prefixMaxDiff', () => {
  it('is 0 when the short buffer is an exact prefix of the wide one', () => {
    const shallow = buf([1, 2], [5, 6]);
    const full = buf([1, 2, 3, 4], [5, 6, 7, 8]);
    expect(prefixMaxDiff(shallow, 2, full, 4, 2, 2)).toBe(0);
  });

  it('reports the largest difference across the compared bands', () => {
    const shallow = buf([1, 2], [5, 9]);
    const full = buf([1, 2, 3, 4], [5, 6, 7, 8]);
    expect(prefixMaxDiff(shallow, 2, full, 4, 2, 2)).toBe(3);
  });

  it('skips pixels that are nodata in either buffer', () => {
    const shallow = buf([1, 2], nodata(2));
    const full = buf([1, 2, 3, 4], nodata(4));
    expect(prefixMaxDiff(shallow, 2, full, 4, 2, 2)).toBe(0);
  });
});

describe('blockNormMap', () => {
  it('measures the length of just the requested band block', () => {
    // Pixel [3, 4, 5, 12]: bands 0-1 have length 5, bands 2-3 have length 13.
    const map = blockNormMap(buf([3, 4, 5, 12]), 1, 4, 0, 2);
    expect(map[0]).toBeCloseTo(5, 6);
    expect(blockNormMap(buf([3, 4, 5, 12]), 1, 4, 2, 4)[0]).toBeCloseTo(13, 6);
  });

  it('marks nodata pixels NaN', () => {
    const map = blockNormMap(buf([3, 4], nodata(2)), 2, 2, 0, 2);
    expect(map[0]).toBeCloseTo(5, 6);
    expect(Number.isNaN(map[1])).toBe(true);
  });

  it('stops at the last band the buffer actually has', () => {
    const map = blockNormMap(buf([3, 4]), 1, 2, 0, 99);
    expect(map[0]).toBeCloseTo(5, 6);
  });

  it('is zero-length when the block is empty', () => {
    const map = blockNormMap(buf([3, 4]), 1, 2, 2, 2);
    expect(map[0]).toBe(0);
  });
});

describe('bandRanges', () => {
  it('spans the values contributed by every depth', () => {
    const ranges = bandRanges(
      [
        { emb: buf([0, 5, 2]), nBands: 3, nPixels: 1 },
        { emb: buf([-4, 7, 2]), nBands: 3, nPixels: 1 },
      ],
      [0, 1, 2],
    );
    expect(ranges).toEqual([
      { min: -4, max: 0 },
      { min: 5, max: 7 },
      { min: 2, max: 2 },
    ]);
  });
});

describe('scalarRange', () => {
  it('spans every map, ignoring NaN', () => {
    const range = scalarRange([
      new Float32Array([0.2, NaN, 0.5]),
      new Float32Array([0.1, 0.9]),
    ]);
    expect(range.min).toBeCloseTo(0.1, 6);
    expect(range.max).toBeCloseTo(0.9, 6);
  });
});

describe('rgbaFromBands', () => {
  it('stretches each band across its own range', () => {
    const rgba = rgbaFromBands(
      buf([0, 5, 10], [10, 5, 0]), 2, 3, [0, 1, 2],
      [{ min: 0, max: 10 }, { min: 0, max: 10 }, { min: 0, max: 10 }],
    );
    expect(Array.from(rgba.slice(0, 4))).toEqual([0, 128, 255, 255]);
    expect(Array.from(rgba.slice(4, 8))).toEqual([255, 128, 0, 255]);
  });

  it('makes nodata pixels transparent', () => {
    const rgba = rgbaFromBands(
      buf(nodata(3)), 1, 3, [0, 1, 2],
      [{ min: 0, max: 1 }, { min: 0, max: 1 }, { min: 0, max: 1 }],
    );
    expect(rgba[3]).toBe(0);
  });
});

describe('rgbaFromScalar', () => {
  it('ramps opacity from the low end of the range to the high end', () => {
    const rgba = rgbaFromScalar(new Float32Array([0, 1]), 0, 1, [0, 229, 255]);
    expect(Array.from(rgba.slice(0, 4))).toEqual([0, 229, 255, 0]);
    expect(Array.from(rgba.slice(4, 8))).toEqual([0, 229, 255, 255]);
  });

  it('makes NaN pixels transparent', () => {
    const rgba = rgbaFromScalar(new Float32Array([NaN]), 0, 1, [0, 229, 255]);
    expect(rgba[3]).toBe(0);
  });
});
