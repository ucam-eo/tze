/**
 * Dequantisation of stored int8 embeddings into float vectors.
 */

/**
 * Dequantise a band-major (NCHW) int8 block into pixel-major floats.
 *
 * @param int8 - Quantised values, band-major: band `b` of pixel `p` sits at
 *   `int8[b * height * width + p]`.
 * @param scales - Per-pixel scale factors, one per pixel, row-major.
 * @param height - Block height in pixels.
 * @param width - Block width in pixels.
 * @param nBands - Bands per pixel.
 * @param out - Destination buffer, written pixel-major.
 * @param outOffset - Index in `out` at which the block starts.
 *
 * @remarks
 * Pixels whose scale is zero, NaN, or infinite carry no data — the store
 * marks nodata with `+inf` — and are written as `NaN` across every band so
 * downstream code can skip them with a single check.
 */
export function dequantiseNCHW(
  int8: Int8Array,
  scales: Float32Array,
  height: number,
  width: number,
  nBands: number,
  out: Float32Array,
  outOffset: number,
): void {
  const pixels = height * width;
  for (let p = 0; p < pixels; p++) {
    const s = scales[p];
    const dst = outOffset + p * nBands;
    if (s && !isNaN(s) && isFinite(s)) {
      for (let b = 0; b < nBands; b++) out[dst + b] = int8[b * pixels + p] * s;
    } else {
      for (let b = 0; b < nBands; b++) out[dst + b] = NaN;
    }
  }
}
