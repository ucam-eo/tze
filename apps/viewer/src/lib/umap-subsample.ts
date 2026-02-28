import type { TileEmbeddings } from '@ucam-eo/maplibre-zarr-tessera';
import type { TileSimilarity } from './similarity';

export interface SubsampleResult {
  embeddings: Float32Array; // N * nBands flat
  scores: Float32Array;     // N scores
  refIndex: number;         // index of reference pixel in the subsample
  count: number;            // N
  nBands: number;
}

const MAX_POINTS = 5000;
const NUM_BINS = 10;

/**
 * Stratified subsample of embeddings, weighted by similarity score bins.
 * Always includes the reference pixel.
 */
export function subsampleEmbeddings(
  embeddingCache: Map<string, TileEmbeddings>,
  cachedScores: TileSimilarity[],
  refEmbedding: Float32Array,
  refPixel: { ci: number; cj: number; row: number; col: number },
): SubsampleResult {
  // Build a lookup of scores by tile key
  const scoreMap = new Map<string, TileSimilarity>();
  for (const ts of cachedScores) {
    scoreMap.set(`${ts.ci}_${ts.cj}`, ts);
  }

  // Collect all valid points into bins by score
  interface PointRef {
    tileKey: string;
    pixelIdx: number;
    score: number;
  }

  const bins: PointRef[][] = Array.from({ length: NUM_BINS }, () => []);
  let refPoint: PointRef | null = null;
  let nBands = refEmbedding.length;

  for (const [key, tile] of embeddingCache) {
    const ts = scoreMap.get(key);
    if (!ts) continue;
    nBands = tile.nBands;

    for (let i = 0; i < tile.width * tile.height; i++) {
      const score = ts.scores[i];
      if (Number.isNaN(score)) continue;

      const row = Math.floor(i / tile.width);
      const col = i % tile.width;

      // Check if this is the reference pixel
      if (tile.ci === refPixel.ci && tile.cj === refPixel.cj &&
          row === refPixel.row && col === refPixel.col) {
        refPoint = { tileKey: key, pixelIdx: i, score };
        continue; // reserve slot for ref pixel
      }

      const bin = Math.min(Math.floor(score * NUM_BINS), NUM_BINS - 1);
      bins[bin].push({ tileKey: key, pixelIdx: i, score });
    }
  }

  // Budget: MAX_POINTS - 1 (reserve one for ref pixel)
  const budget = MAX_POINTS - 1;
  const totalAvailable = bins.reduce((s, b) => s + b.length, 0);
  const sampleCount = Math.min(budget, totalAvailable);

  // Proportional allocation per bin
  const selected: PointRef[] = [];

  if (totalAvailable <= budget) {
    // Take all points
    for (const bin of bins) selected.push(...bin);
  } else {
    // Stratified sampling
    const allocations = bins.map(b =>
      Math.floor((b.length / totalAvailable) * sampleCount)
    );
    // Distribute remainder
    let remainder = sampleCount - allocations.reduce((a, b) => a + b, 0);
    for (let i = 0; remainder > 0 && i < NUM_BINS; i++) {
      if (allocations[i] < bins[i].length) {
        allocations[i]++;
        remainder--;
      }
    }

    for (let b = 0; b < NUM_BINS; b++) {
      const bin = bins[b];
      const n = allocations[b];
      if (n >= bin.length) {
        selected.push(...bin);
      } else {
        // Fisher-Yates partial shuffle
        for (let i = bin.length - 1; i >= bin.length - n; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [bin[i], bin[j]] = [bin[j], bin[i]];
        }
        selected.push(...bin.slice(bin.length - n));
      }
    }
  }

  // Add ref pixel at the end
  const N = selected.length + (refPoint ? 1 : 0);
  const embeddings = new Float32Array(N * nBands);
  const scores = new Float32Array(N);
  let refIndex = -1;

  for (let i = 0; i < selected.length; i++) {
    const p = selected[i];
    const tile = embeddingCache.get(p.tileKey)!;
    const offset = p.pixelIdx * nBands;
    embeddings.set(tile.emb.subarray(offset, offset + nBands), i * nBands);
    scores[i] = p.score;
  }

  if (refPoint) {
    refIndex = selected.length;
    const tile = embeddingCache.get(refPoint.tileKey)!;
    const offset = refPoint.pixelIdx * nBands;
    embeddings.set(tile.emb.subarray(offset, offset + nBands), refIndex * nBands);
    scores[refIndex] = refPoint.score;
  } else {
    // Fallback: use the refEmbedding directly
    refIndex = selected.length > 0 ? N - 1 : 0;
    // Re-allocate if needed
    if (selected.length === 0) {
      const e = new Float32Array(nBands);
      e.set(refEmbedding);
      return { embeddings: e, scores: new Float32Array([1.0]), refIndex: 0, count: 1, nBands };
    }
  }

  return { embeddings, scores, refIndex, count: N, nBands };
}

/**
 * Uniform random subsample of embeddings (no similarity scores needed).
 * Used for auto-UMAP before any reference pixel is selected.
 */
export function subsampleUniform(
  embeddingCache: Map<string, TileEmbeddings>,
): SubsampleResult {
  // Collect all valid pixel indices across tiles
  interface PointRef { tileKey: string; pixelIdx: number; }
  const all: PointRef[] = [];
  let nBands = 0;

  for (const [key, tile] of embeddingCache) {
    nBands = tile.nBands;
    for (let i = 0; i < tile.width * tile.height; i++) {
      const s = tile.scales[i];
      if (s && !isNaN(s) && s !== 0) {
        all.push({ tileKey: key, pixelIdx: i });
      }
    }
  }

  if (all.length === 0 || nBands === 0) {
    return { embeddings: new Float32Array(0), scores: new Float32Array(0), refIndex: -1, count: 0, nBands: nBands || 128 };
  }

  // Fisher-Yates partial shuffle to select up to MAX_POINTS
  const n = Math.min(MAX_POINTS, all.length);
  for (let i = all.length - 1; i >= all.length - n; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const selected = all.slice(all.length - n);

  const embeddings = new Float32Array(n * nBands);
  const scores = new Float32Array(n); // all zeros — no similarity info

  for (let i = 0; i < n; i++) {
    const p = selected[i];
    const tile = embeddingCache.get(p.tileKey)!;
    const offset = p.pixelIdx * nBands;
    embeddings.set(tile.emb.subarray(offset, offset + nBands), i * nBands);
  }

  return { embeddings, scores, refIndex: -1, count: n, nBands };
}
