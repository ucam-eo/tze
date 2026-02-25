import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
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
 * embedding using GPU-batched matMul. Scores are normalised to 0..1 based
 * on the observed min/max across all tiles so the threshold slider gives
 * meaningful control even when raw cosine similarities are tightly clustered.
 */
export async function computeSimilarityScores(
  embeddingCache: Map<string, TileEmbeddings>,
  refEmbedding: Float32Array,
  onTileDone?: (t: TileSimilarity) => void,
): Promise<TileSimilarity[]> {
  await tf.ready();

  // Normalised reference vector [1, D]
  const refRaw = tf.tensor2d(refEmbedding, [1, refEmbedding.length]);
  const refNorm = tf.sqrt(tf.add(tf.sum(tf.square(refRaw), 1, true), 1e-12));
  const refNormed = tf.div(refRaw, refNorm);
  const refT = tf.transpose(refNormed);
  refRaw.dispose(); refNorm.dispose();

  // First pass: compute raw cosine similarities per tile
  interface RawTile {
    ci: number; cj: number; width: number; height: number;
    rawScores: Float32Array;
  }
  const rawTiles: RawTile[] = [];
  const GPU_CHUNK = 8192;

  let globalMin = Infinity;
  let globalMax = -Infinity;

  for (const [, tile] of embeddingCache) {
    const { ci, cj, emb, scales, width, height, nBands } = tile;
    const rawScores = new Float32Array(width * height);
    rawScores.fill(NaN);

    const validIndices: number[] = [];
    const queryFlat = new Float32Array(width * height * nBands);
    let nValid = 0;

    for (let i = 0; i < width * height; i++) {
      const s = scales[i];
      if (!s || isNaN(s) || s === 0) continue;
      const srcOff = i * nBands;
      const dstOff = nValid * nBands;
      for (let b = 0; b < nBands; b++) queryFlat[dstOff + b] = emb[srcOff + b];
      validIndices.push(i);
      nValid++;
    }

    for (let chunkStart = 0; chunkStart < nValid; chunkStart += GPU_CHUNK) {
      const chunkEnd = Math.min(chunkStart + GPU_CHUNK, nValid);
      const chunkSize = chunkEnd - chunkStart;

      const querySlice = queryFlat.subarray(chunkStart * nBands, chunkEnd * nBands);
      const queries = tf.tensor2d(querySlice, [chunkSize, nBands]);

      const qNorm = tf.sqrt(tf.add(tf.sum(tf.square(queries), 1, true), 1e-12));
      const qNormed = tf.div(queries, qNorm);

      const sim = tf.matMul(qNormed, refT);
      const simData = await sim.data();

      for (let i = 0; i < chunkSize; i++) {
        const v = simData[i];
        rawScores[validIndices[chunkStart + i]] = v;
        if (v < globalMin) globalMin = v;
        if (v > globalMax) globalMax = v;
      }

      queries.dispose(); qNorm.dispose(); qNormed.dispose(); sim.dispose();
    }

    rawTiles.push({ ci, cj, width, height, rawScores });
    await new Promise(r => setTimeout(r, 0));
  }

  refNormed.dispose(); refT.dispose();

  // Second pass: normalise scores to 0..1 based on observed range
  const range = globalMax - globalMin;
  const results: TileSimilarity[] = [];

  for (const raw of rawTiles) {
    const scores = new Float32Array(raw.rawScores.length);
    for (let i = 0; i < scores.length; i++) {
      const v = raw.rawScores[i];
      if (isNaN(v)) { scores[i] = NaN; continue; }
      scores[i] = range > 0 ? (v - globalMin) / range : 0.5;
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
