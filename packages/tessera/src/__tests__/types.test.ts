import { describe, it, expect } from 'vitest';
import type {
  TesseraOptions, StoreMetadata, ChunkRef, ManagedChunk,
  EmbeddingRegion, EmbeddingAt, ZoneDescriptor, EmbeddingProgress,
  DebugLogEntry, UtmBounds, ChunkBounds, TesseraEvents,
  TileRendererOptions,
} from '../types.js';

describe('types', () => {
  it('StoreMetadata has correct tuple types', () => {
    const meta: StoreMetadata = {
      url: 'https://example.com/store.zarr',
      utmZone: 30,
      epsg: 32630,
      transform: [10, 0, 500000, 0, -10, 6000000],
      shape: [600, 600, 128],
      chunkShape: [4, 4, 128],
      nBands: 128,
      hasRgb: true,
      hasPca: false,
    };
    expect(meta.transform).toHaveLength(6);
    expect(meta.shape).toHaveLength(3);
    expect(meta.chunkShape).toHaveLength(3);
  });

  it('EmbeddingRegion layout is consistent', () => {
    const region: EmbeddingRegion = {
      ciMin: 0, ciMax: 1, cjMin: 0, cjMax: 1,
      gridRows: 2, gridCols: 2,
      tileW: 4, tileH: 4, nBands: 128,
      emb: new Float32Array(2 * 2 * 4 * 4 * 128),
      loaded: new Uint8Array(4),
    };
    expect(region.emb.length).toBe(
      region.gridRows * region.gridCols * region.tileH * region.tileW * region.nBands,
    );
    expect(region.loaded.length).toBe(region.gridRows * region.gridCols);
  });

  it('TesseraEvents keys match expected event names', () => {
    const events: TesseraEvents = {
      'metadata-loaded': {} as StoreMetadata,
      'chunk-loaded': { ci: 0, cj: 0 },
      'embeddings-loaded': { ci: 0, cj: 0 },
      'embedding-progress': { ci: 0, cj: 0, stage: 'fetching' },
      'error': new Error('test'),
      'loading': { total: 10, done: 5 },
      'debug': { time: 0, type: 'info', msg: 'test' },
    };
    expect(Object.keys(events)).toHaveLength(7);
  });
});
