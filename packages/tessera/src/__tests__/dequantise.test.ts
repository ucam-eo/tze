import { describe, it, expect } from 'vitest';
import { dequantiseNCHW } from '../dequantise.js';

describe('dequantiseNCHW', () => {
  it('transposes band-major input into pixel-major output', () => {
    // 2x1 pixels, 3 bands. NCHW stores all of band 0, then band 1, then band 2.
    const int8 = new Int8Array([1, 2, 10, 20, 100, 120]);
    const scales = new Float32Array([1, 1]);
    const out = new Float32Array(2 * 3);

    dequantiseNCHW(int8, scales, 1, 2, 3, out, 0);

    expect(Array.from(out)).toEqual([1, 10, 100, 2, 20, 120]);
  });

  it('scales each pixel by its own scale factor', () => {
    const int8 = new Int8Array([4, 4]);
    const scales = new Float32Array([0.5, 0.25]);
    const out = new Float32Array(2);

    dequantiseNCHW(int8, scales, 1, 2, 1, out, 0);

    expect(Array.from(out)).toEqual([2, 1]);
  });

  it('writes NaN for every band of a pixel with no valid scale', () => {
    const int8 = new Int8Array([7, 7, 7, 7, 7, 7, 7, 7]);
    const scales = new Float32Array([2, 0, NaN, Infinity]);
    const out = new Float32Array(8);

    dequantiseNCHW(int8, scales, 2, 2, 2, out, 0);

    expect(Array.from(out.slice(0, 2))).toEqual([14, 14]);
    expect(Array.from(out.slice(2)).every(Number.isNaN)).toBe(true);
  });

  it('writes at the requested offset without disturbing earlier values', () => {
    const int8 = new Int8Array([3]);
    const scales = new Float32Array([1]);
    const out = new Float32Array([9, 9, 0]);

    dequantiseNCHW(int8, scales, 1, 1, 1, out, 2);

    expect(Array.from(out)).toEqual([9, 9, 3]);
  });
});
