import { describe, it, expect } from 'vitest';
import { tileBounds, selectLevel } from '../tile-renderer.js';

describe('tileBounds', () => {
  it('computes correct bounds for tile 0/0/0', () => {
    const b = tileBounds(0, 0, 0);
    expect(b.west).toBeCloseTo(-180, 0);
    expect(b.south).toBeCloseTo(-85.05, 0);
    expect(b.east).toBeCloseTo(180, 0);
    expect(b.north).toBeCloseTo(85.05, 0);
  });

  it('computes correct bounds for tile 1/0/0', () => {
    const b = tileBounds(1, 0, 0);
    expect(b.west).toBeCloseTo(-180, 0);
    expect(b.east).toBeCloseTo(0, 0);
    expect(b.north).toBeCloseTo(85.05, 0);
  });

  it('tile 1/1/0 is the NE quadrant', () => {
    const b = tileBounds(1, 1, 0);
    expect(b.west).toBeCloseTo(0, 0);
    expect(b.east).toBeCloseTo(180, 0);
    expect(b.north).toBeCloseTo(85.05, 0);
  });

  it('tile 1/0/1 is the SW quadrant', () => {
    const b = tileBounds(1, 0, 1);
    expect(b.west).toBeCloseTo(-180, 0);
    expect(b.east).toBeCloseTo(0, 0);
    expect(b.south).toBeCloseTo(-85.05, 0);
  });
});

describe('selectLevel', () => {
  // Levels are ordered finest (index 0) to coarsest (index N-1),
  // matching the order produced by the Zarr multiscales layout.
  // selectLevel scans coarsest-to-finest (last→first) and returns
  // the coarsest level with sufficient resolution.

  it('selects coarsest level at low zoom', () => {
    // At zoom 0: neededPxPerDeg = 256/360 ≈ 0.711, threshold = 0.356
    // Level 1 (coarsest): 360px wide → 1.0 px/deg ≥ 0.356 → return 1
    const levels = [
      { shape: [360, 720, 3] as [number, number, number] },  // finest
      { shape: [180, 360, 3] as [number, number, number] },  // coarsest
    ];
    const idx = selectLevel(levels, 0);
    expect(idx).toBe(1); // picks coarsest that suffices
  });

  it('selects finer level at higher zoom when coarsest is insufficient', () => {
    // At zoom 4: neededPxPerDeg = 256*16/360 ≈ 11.38, threshold ≈ 5.69
    // Level 1 (coarsest): 1024px → 2.84 px/deg < 5.69 → NOT sufficient
    // Level 0 (finest):   4096px → 11.38 px/deg ≥ 5.69 → return 0
    const levels = [
      { shape: [2048, 4096, 3] as [number, number, number] },  // finest
      { shape: [512, 1024, 3] as [number, number, number] },   // coarsest
    ];
    const idx = selectLevel(levels, 4);
    expect(idx).toBe(0); // needs finest level
  });

  it('falls back to finest level (index 0) when none suffices', () => {
    const levels = [
      { shape: [10, 20, 3] as [number, number, number] },  // very coarse, only option
    ];
    const idx = selectLevel(levels, 10);
    expect(idx).toBe(0); // only level available
  });
});
