import type { TileEmbeddings } from '@ucam-eo/maplibre-zarr-tessera';

/** Per-tile cached similarity data with normalised scores. */
export interface TileSimilarity {
  ci: number;
  cj: number;
  width: number;
  height: number;
  /** Per-pixel normalised similarity in 0..1, calibrated to the observed
   *  range across all tiles. Invalid pixels = NaN. */
  scores: Float32Array;
  /** Reusable canvas for flicker-free updates. */
  canvas: HTMLCanvasElement;
}

export interface SimilarityOverlay {
  ci: number;
  cj: number;
  canvas: HTMLCanvasElement;
}

/**
 * Compute cosine similarity of every pixel in loaded tiles to a reference
 * embedding using CPU dot products. For dim=128 this is fast enough (~256
 * FLOPs per pixel) and avoids GPU memory pressure that causes OOM on mobile.
 *
 * Scores are normalised to 0..1 based on the observed min/max across all
 * tiles so the threshold slider gives meaningful control even when raw
 * cosine similarities are tightly clustered.
 */
export async function computeSimilarityScores(
  embeddingCache: Map<string, TileEmbeddings>,
  refEmbedding: Float32Array,
  onTileDone?: (t: TileSimilarity) => void,
): Promise<TileSimilarity[]> {
  const D = refEmbedding.length;

  // Pre-normalise reference vector (CPU)
  let refNormSq = 0;
  for (let b = 0; b < D; b++) refNormSq += refEmbedding[b] * refEmbedding[b];
  const refScale = 1 / Math.sqrt(refNormSq + 1e-12);
  const ref = new Float32Array(D);
  for (let b = 0; b < D; b++) ref[b] = refEmbedding[b] * refScale;

  // First pass: compute raw cosine similarities per tile
  interface RawTile {
    ci: number; cj: number; width: number; height: number;
    scores: Float32Array;
  }
  const rawTiles: RawTile[] = [];

  let globalMin = Infinity;
  let globalMax = -Infinity;

  for (const [, tile] of embeddingCache) {
    const { ci, cj, emb, scales, width, height, nBands } = tile;
    const scores = new Float32Array(width * height);
    scores.fill(NaN);

    const npx = width * height;
    for (let i = 0; i < npx; i++) {
      const s = scales[i];
      if (!s || isNaN(s) || s === 0) continue;

      // Dot product and query norm in one pass over D dimensions
      const off = i * nBands;
      let dot = 0, qSq = 0;
      for (let b = 0; b < D; b++) {
        const v = emb[off + b];
        dot += v * ref[b];
        qSq += v * v;
      }
      const cos = dot / Math.sqrt(qSq + 1e-12);

      scores[i] = cos;
      if (cos < globalMin) globalMin = cos;
      if (cos > globalMax) globalMax = cos;
    }

    rawTiles.push({ ci, cj, width, height, scores });
  }

  // Second pass: normalise scores to 0..1 in-place, wrap as TileSimilarity
  const range = globalMax - globalMin;
  const results: TileSimilarity[] = [];

  for (const raw of rawTiles) {
    const { scores } = raw;
    if (range > 0) {
      for (let i = 0; i < scores.length; i++) {
        const v = scores[i];
        if (!isNaN(v)) scores[i] = (v - globalMin) / range;
      }
    } else {
      for (let i = 0; i < scores.length; i++) {
        if (!isNaN(scores[i])) scores[i] = 0.5;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = raw.width;
    canvas.height = raw.height;

    const result: TileSimilarity = {
      ci: raw.ci, cj: raw.cj,
      width: raw.width, height: raw.height,
      scores, canvas,
    };
    results.push(result);
    onTileDone?.(result);
  }

  return results;
}

/**
 * Render cached normalised similarity scores into overlay canvases, applying
 * a binary threshold (0..1). Updates canvases in-place for flicker-free
 * slider dragging.
 */
export function renderSimilarityOverlays(
  tiles: TileSimilarity[],
  threshold: number,
  onTileDone?: (r: SimilarityOverlay) => void,
): SimilarityOverlay[] {
  const results: SimilarityOverlay[] = [];

  for (const tile of tiles) {
    const { ci, cj, width, height, scores, canvas } = tile;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(width, height);
    const rgba = imgData.data;

    for (let i = 0; i < width * height; i++) {
      const s = scores[i];
      if (isNaN(s)) continue;

      if (s >= threshold) {
        const rgbaIdx = i * 4;
        rgba[rgbaIdx]     = 0;
        rgba[rgbaIdx + 1] = 229;
        rgba[rgbaIdx + 2] = 255;
        rgba[rgbaIdx + 3] = 180;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const result: SimilarityOverlay = { ci, cj, canvas };
    results.push(result);
    onTileDone?.(result);
  }

  return results;
}
