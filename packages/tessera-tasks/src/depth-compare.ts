/**
 * Comparing the same pixels read at different matryoshka depths.
 *
 * @remarks
 * Stores that ship truncated embedding arrays (`geoemb:depths`) let a reader
 * trade dimensions for bytes. These helpers quantify that trade on one window:
 * what a shallow read reproduces exactly (the leading bands, hence the RGB
 * preview), and what it only approximates (anything that consumes the whole
 * vector, such as a similarity or deviance map).
 *
 * All buffers are pixel-major — pixel `p` band `b` sits at `emb[p * nBands + b]`
 * — matching {@link TesseraSource.fetchDepthWindow}. Pixels with no data are
 * `NaN` in band 0 and skipped throughout.
 */

/** Inclusive value range used to stretch a band onto 0–255. */
export interface BandRange {
  min: number;
  max: number;
}

/** One depth's window, as accepted by {@link bandRanges}. */
export interface DepthBuffer {
  emb: Float32Array;
  nBands: number;
  nPixels: number;
}

/**
 * Mean embedding over the pixels that have data.
 *
 * @returns The mean vector, or `null` if no pixel has data.
 */
export function meanEmbedding(
  emb: Float32Array,
  nPixels: number,
  nBands: number,
): Float32Array | null {
  const mean = new Float32Array(nBands);
  let valid = 0;

  for (let p = 0; p < nPixels; p++) {
    const off = p * nBands;
    if (isNaN(emb[off])) continue;
    for (let b = 0; b < nBands; b++) mean[b] += emb[off + b];
    valid++;
  }

  if (valid === 0) return null;
  for (let b = 0; b < nBands; b++) mean[b] /= valid;
  return mean;
}

/**
 * Per-pixel length of one band block — the dimensions a depth tier adds.
 *
 * @param from - First band of the block.
 * @param to - One past the last band, clamped to what the buffer holds.
 * @returns Per-pixel L2 norm over `[from, to)`; `NaN` for pixels with no data.
 *
 * @remarks
 * Answers what stepping up a depth actually buys. A block whose length barely
 * varies across the window adds magnitude but little that distinguishes one
 * pixel from another, which is why truncating those dimensions costs less than
 * their share of the vector suggests.
 */
export function blockNormMap(
  emb: Float32Array,
  nPixels: number,
  nBands: number,
  from: number,
  to: number,
): Float32Array {
  const out = new Float32Array(nPixels).fill(NaN);
  const last = Math.min(to, nBands);

  for (let p = 0; p < nPixels; p++) {
    const off = p * nBands;
    if (isNaN(emb[off])) continue;
    let sum = 0;
    for (let b = from; b < last; b++) sum += emb[off + b] * emb[off + b];
    out[p] = Math.sqrt(sum);
  }

  return out;
}

/**
 * Per-pixel angular distance from the window's mean embedding.
 *
 * @returns `1 - cos(pixel, mean)` per pixel: 0 where a pixel points the same
 *   way as the scene average, 1 where it is orthogonal to it, up to 2 when
 *   opposed. `NaN` for pixels with no data or no direction (zero length).
 *
 * @remarks
 * This is the quantity that shows what truncation costs. The leading bands are
 * byte-identical across depths, so a shallow read reproduces the leading-band
 * picture exactly — but the deviance map consumes every dimension, so it
 * resolves less structure the shallower the read.
 */
export function devianceMap(
  emb: Float32Array,
  nPixels: number,
  nBands: number,
): Float32Array {
  const out = new Float32Array(nPixels).fill(NaN);
  const mean = meanEmbedding(emb, nPixels, nBands);
  if (!mean) return out;

  let meanNorm = 0;
  for (let b = 0; b < nBands; b++) meanNorm += mean[b] * mean[b];
  meanNorm = Math.sqrt(meanNorm);
  if (meanNorm === 0) return out;

  for (let p = 0; p < nPixels; p++) {
    const off = p * nBands;
    if (isNaN(emb[off])) continue;
    let dot = 0, norm = 0;
    for (let b = 0; b < nBands; b++) {
      dot += emb[off + b] * mean[b];
      norm += emb[off + b] * emb[off + b];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    out[p] = 1 - dot / (norm * meanNorm);
  }

  return out;
}

/**
 * Per-pixel cosine similarity against one reference pixel in the same window.
 *
 * @param refPixel - Index of the reference pixel.
 * @returns Similarity per pixel in `[-1, 1]`; `NaN` where either pixel has no
 *   data, and `NaN` throughout when the reference itself has none.
 */
export function similarityMap(
  emb: Float32Array,
  nPixels: number,
  nBands: number,
  refPixel: number,
): Float32Array {
  const out = new Float32Array(nPixels).fill(NaN);
  const refOff = refPixel * nBands;
  if (refPixel < 0 || refPixel >= nPixels || isNaN(emb[refOff])) return out;

  let refNorm = 0;
  for (let b = 0; b < nBands; b++) refNorm += emb[refOff + b] * emb[refOff + b];
  refNorm = Math.sqrt(refNorm);
  if (refNorm === 0) return out;

  for (let p = 0; p < nPixels; p++) {
    const off = p * nBands;
    if (isNaN(emb[off])) continue;
    let dot = 0, norm = 0;
    for (let b = 0; b < nBands; b++) {
      dot += emb[off + b] * emb[refOff + b];
      norm += emb[off + b] * emb[off + b];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    out[p] = dot / (norm * refNorm);
  }

  return out;
}

/**
 * Pearson correlation between two maps, over positions where both have values.
 *
 * @returns `r` in `[-1, 1]`, or `NaN` if fewer than two positions are shared
 *   or either series never varies.
 */
export function pearson(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let count = 0, sumA = 0, sumB = 0;

  for (let i = 0; i < n; i++) {
    if (isNaN(a[i]) || isNaN(b[i])) continue;
    sumA += a[i];
    sumB += b[i];
    count++;
  }
  if (count < 2) return NaN;

  const meanA = sumA / count;
  const meanB = sumB / count;
  let cov = 0, varA = 0, varB = 0;

  for (let i = 0; i < n; i++) {
    if (isNaN(a[i]) || isNaN(b[i])) continue;
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  if (varA === 0 || varB === 0) return NaN;
  return cov / Math.sqrt(varA * varB);
}

/**
 * Fraction of the top-`k` positions in one map that are also top-`k` in another.
 *
 * @returns Overlap in `[0, 1]`, or `NaN` if either map has fewer than `k`
 *   scored positions.
 *
 * @remarks
 * Ranking agreement, not value agreement: it answers whether a shallower read
 * would have surfaced the same pixels, which is what a similarity search
 * actually returns.
 */
export function topKOverlap(a: Float32Array, b: Float32Array, k: number): number {
  const topA = topIndices(a, k);
  const topB = topIndices(b, k);
  if (topA === null || topB === null) return NaN;

  const inB = new Set(topB);
  let shared = 0;
  for (const i of topA) if (inB.has(i)) shared++;
  return shared / k;
}

/** Indices of the `k` highest scores, or `null` if fewer than `k` are scored. */
function topIndices(values: Float32Array, k: number): number[] | null {
  const scored: number[] = [];
  for (let i = 0; i < values.length; i++) if (!isNaN(values[i])) scored.push(i);
  if (k <= 0 || scored.length < k) return null;
  scored.sort((i, j) => values[j] - values[i]);
  return scored.slice(0, k);
}

/**
 * Mean absolute gap between two maps, over positions where both have values.
 *
 * @returns The mean gap, or `NaN` if the maps share no scored position.
 */
export function meanAbsDiff(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0, count = 0;

  for (let i = 0; i < n; i++) {
    if (isNaN(a[i]) || isNaN(b[i])) continue;
    sum += Math.abs(a[i] - b[i]);
    count++;
  }

  return count === 0 ? NaN : sum / count;
}

/**
 * Largest difference between two depths over their shared leading bands.
 *
 * @param k - Number of leading bands to compare.
 * @returns The maximum absolute difference — 0 when the shallow buffer is an
 *   exact prefix of the wide one, which is what the store's depth arrays
 *   promise. Pixels with no data in either buffer are skipped.
 */
export function prefixMaxDiff(
  a: Float32Array,
  aBands: number,
  b: Float32Array,
  bBands: number,
  nPixels: number,
  k: number,
): number {
  let maxDiff = 0;
  for (let p = 0; p < nPixels; p++) {
    const offA = p * aBands;
    const offB = p * bBands;
    if (isNaN(a[offA]) || isNaN(b[offB])) continue;
    for (let i = 0; i < k; i++) {
      const diff = Math.abs(a[offA + i] - b[offB + i]);
      if (diff > maxDiff) maxDiff = diff;
    }
  }
  return maxDiff;
}

/**
 * Per-band value range spanning every depth, for a shared colour stretch.
 *
 * @remarks
 * Stretching each depth independently would normalise away the very thing
 * being compared: one shared range means identical inputs render as identical
 * pixels, and differences stay visible.
 */
export function bandRanges(
  sources: DepthBuffer[],
  bands: [number, number, number],
): BandRange[] {
  return bands.map(band => {
    let min = Infinity, max = -Infinity;
    for (const { emb, nBands, nPixels } of sources) {
      if (band >= nBands) continue;
      for (let p = 0; p < nPixels; p++) {
        const v = emb[p * nBands + band];
        if (isNaN(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return isFinite(min) ? { min, max } : { min: 0, max: 1 };
  });
}

/**
 * Value range between two percentiles, ignoring NaN.
 *
 * @param loPct - Lower percentile, 0–100.
 * @param hiPct - Upper percentile, 0–100.
 * @returns The trimmed range, or `{ min: 0, max: 1 }` if nothing is scored.
 *
 * @remarks
 * Comparing how much a map varies is easily wrecked by a single extreme
 * pixel — a zero-length vector puts the minimum at 0 and makes any ratio
 * infinite. Trimming the tails describes the bulk of the window instead.
 */
export function percentileRange(
  values: Float32Array,
  loPct: number,
  hiPct: number,
): BandRange {
  const scored: number[] = [];
  for (let i = 0; i < values.length; i++) if (!isNaN(values[i])) scored.push(values[i]);
  if (scored.length === 0) return { min: 0, max: 1 };

  scored.sort((a, b) => a - b);
  const at = (pct: number) => {
    const idx = Math.round((pct / 100) * (scored.length - 1));
    return scored[Math.max(0, Math.min(scored.length - 1, idx))];
  };
  return { min: at(loPct), max: at(hiPct) };
}

/** Value range spanning several scalar maps, ignoring NaN. */
export function scalarRange(maps: Float32Array[]): BandRange {
  let min = Infinity, max = -Infinity;
  for (const map of maps) {
    for (let i = 0; i < map.length; i++) {
      const v = map[i];
      if (isNaN(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return isFinite(min) ? { min, max } : { min: 0, max: 1 };
}

/**
 * Rasterise three embedding bands to RGBA, one band per channel.
 *
 * @param ranges - Per-channel stretch, typically from {@link bandRanges}.
 * @returns RGBA bytes, `nPixels * 4` long. Pixels with no data are transparent.
 */
export function rgbaFromBands(
  emb: Float32Array,
  nPixels: number,
  nBands: number,
  bands: [number, number, number],
  ranges: BandRange[],
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(nPixels * 4);

  for (let p = 0; p < nPixels; p++) {
    const off = p * nBands;
    const out = p * 4;
    if (isNaN(emb[off])) continue;
    for (let c = 0; c < 3; c++) {
      const band = bands[c];
      const { min, max } = ranges[c];
      const span = max - min || 1;
      rgba[out + c] = band < nBands ? ((emb[off + band] - min) / span) * 255 : 0;
    }
    rgba[out + 3] = 255;
  }

  return rgba;
}

/**
 * Rasterise a scalar map as one hue whose opacity tracks the value.
 *
 * @param colour - RGB triple held constant across the map.
 * @returns RGBA bytes, `values.length * 4` long. NaN values are transparent.
 */
export function rgbaFromScalar(
  values: Float32Array,
  min: number,
  max: number,
  colour: [number, number, number],
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(values.length * 4);
  const span = max - min || 1;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const out = i * 4;
    if (isNaN(v)) continue;
    rgba[out] = colour[0];
    rgba[out + 1] = colour[1];
    rgba[out + 2] = colour[2];
    rgba[out + 3] = ((v - min) / span) * 255;
  }

  return rgba;
}
