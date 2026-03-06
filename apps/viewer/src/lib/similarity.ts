import type { EmbeddingRegion } from '@ucam-eo/maplibre-zarr-tessera';

/** Cached similarity data for the entire region. */
export interface SimilarityResult {
  /** Per-pixel normalised similarity in 0..1. NaN = invalid. Same layout as region.emb (tile-major). */
  scores: Float32Array;
  /** Region geometry for rendering. */
  gridRows: number;
  gridCols: number;
  tileW: number;
  tileH: number;
  /** Per-tile loaded bitmap (copy from region at compute time). */
  loaded: Uint8Array;
}

/**
 * Compute cosine similarity of every pixel in the region to a reference
 * embedding. Scores are normalised to 0..1 based on observed min/max.
 * Returns a single flat array covering the whole region grid.
 */
export function computeSimilarityScores(
  region: EmbeddingRegion,
  refEmbedding: Float32Array,
): SimilarityResult {
  const D = refEmbedding.length;
  const { tileW, tileH, nBands, emb, loaded, gridCols, gridRows } = region;
  const tilePixels = tileW * tileH;
  const totalTiles = loaded.length;

  // Pre-normalise reference vector
  let refNormSq = 0;
  for (let b = 0; b < D; b++) refNormSq += refEmbedding[b] * refEmbedding[b];
  const refScale = 1 / Math.sqrt(refNormSq + 1e-12);
  const ref = new Float32Array(D);
  for (let b = 0; b < D; b++) ref[b] = refEmbedding[b] * refScale;

  const scores = new Float32Array(totalTiles * tilePixels);
  scores.fill(NaN);

  let globalMin = Infinity;
  let globalMax = -Infinity;

  // First pass: compute raw cosine similarities
  for (let t = 0; t < totalTiles; t++) {
    if (!loaded[t]) continue;
    const embBase = t * tilePixels * nBands;
    const scoreBase = t * tilePixels;

    for (let i = 0; i < tilePixels; i++) {
      const off = embBase + i * nBands;
      if (isNaN(emb[off])) continue;

      let dot = 0, qSq = 0;
      for (let b = 0; b < D; b++) {
        const v = emb[off + b];
        dot += v * ref[b];
        qSq += v * v;
      }
      const cos = dot / Math.sqrt(qSq + 1e-12);
      scores[scoreBase + i] = cos;
      if (cos < globalMin) globalMin = cos;
      if (cos > globalMax) globalMax = cos;
    }
  }

  // Second pass: normalise to 0..1
  const range = globalMax - globalMin;
  if (range > 0) {
    for (let i = 0; i < scores.length; i++) {
      if (!isNaN(scores[i])) scores[i] = (scores[i] - globalMin) / range;
    }
  } else {
    for (let i = 0; i < scores.length; i++) {
      if (!isNaN(scores[i])) scores[i] = 0.5;
    }
  }

  return {
    scores,
    gridRows, gridCols,
    tileW, tileH,
    loaded: new Uint8Array(loaded),
  };
}

/**
 * Render similarity scores into a single canvas covering the whole region.
 * Returns the canvas — caller passes it to a single ImageSource overlay.
 */
export function renderSimilarityCanvas(
  result: SimilarityResult,
  threshold: number,
  canvas?: HTMLCanvasElement,
): HTMLCanvasElement {
  const { scores, gridRows, gridCols, tileW, tileH, loaded } = result;
  const W = gridCols * tileW;
  const H = gridRows * tileH;
  const tilePixels = tileW * tileH;

  if (!canvas) {
    canvas = document.createElement('canvas');
  }
  canvas.width = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(W, H);
  const rgba = imgData.data;

  for (let t = 0; t < loaded.length; t++) {
    if (!loaded[t]) continue;
    const tileRow = Math.floor(t / gridCols);
    const tileCol = t % gridCols;
    const scoreBase = t * tilePixels;
    const pixelY0 = tileRow * tileH;
    const pixelX0 = tileCol * tileW;

    for (let py = 0; py < tileH; py++) {
      for (let px = 0; px < tileW; px++) {
        const s = scores[scoreBase + py * tileW + px];
        if (isNaN(s) || s < threshold) continue;

        const outIdx = ((pixelY0 + py) * W + (pixelX0 + px)) * 4;
        rgba[outIdx]     = 0;
        rgba[outIdx + 1] = 229;
        rgba[outIdx + 2] = 255;
        rgba[outIdx + 3] = 180;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}
