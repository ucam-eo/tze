/**
 * Matryoshka embedding depths.
 *
 * @remarks
 * Some TESSERA stores ship truncated copies of the embeddings array
 * alongside the full-depth one — `embeddings_d4` (4-d), `embeddings_d16`
 * (16-d), `embeddings` (128-d) — declared in the root group's
 * `geoemb:depths` attribute. The truncations are byte-exact prefixes of the
 * full vector sharing the same per-pixel `scales` array, so reading a
 * shallower depth costs proportionally fewer bytes for identical leading
 * dimensions.
 *
 * Stores without the attribute simply have no depths; callers fall back to
 * the full-depth `embeddings` array.
 */

/** One entry from a store's `geoemb:depths` attribute. */
export interface DepthDescriptor {
  /** Number of embedding dimensions this array carries. */
  dimensions: number;

  /** Name of the Zarr array holding them, relative to the zone group. */
  array: string;
}

/** A rectangular pixel window `[r0, r0+height) x [c0, c0+width)`. */
export interface DepthWindow {
  r0: number;
  c0: number;
  height: number;
  width: number;
}

/** Dequantised embeddings for one window at one depth, with what they cost. */
export interface DepthWindowResult extends DepthWindow {
  /** Dequantised values, pixel-major: `height * width * nBands` floats. */
  emb: Float32Array;

  /** Dimensions per pixel in this result. */
  nBands: number;

  /** Chunks the read touched. */
  chunks: number;

  /** Decoded size of those chunks in bytes. */
  bytes: number;
}

/**
 * Read the `geoemb:depths` attribute into validated descriptors.
 *
 * @param attrs - Attributes of the store's root group.
 * @param nBands - Band count of the full-depth embeddings array.
 * @returns Declared depths, ascending. Empty when the store declares none.
 *
 * @remarks
 * Entries without a positive integer `dimensions` or a non-empty `array`
 * name are dropped, as are depths exceeding `nBands` — a store cannot
 * offer more dimensions than its own embeddings array holds. Repeated
 * depths keep their first declaration.
 */
export function parseDepths(
  attrs: Record<string, unknown>,
  nBands: number,
): DepthDescriptor[] {
  const raw = attrs['geoemb:depths'];
  if (!Array.isArray(raw)) return [];

  const seen = new Set<number>();
  const depths: DepthDescriptor[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { dimensions, array } = entry as { dimensions?: unknown; array?: unknown };
    if (typeof dimensions !== 'number' || !Number.isInteger(dimensions) || dimensions <= 0) continue;
    if (typeof array !== 'string' || array === '') continue;
    if (dimensions > nBands) continue;
    if (seen.has(dimensions)) continue;
    seen.add(dimensions);
    depths.push({ dimensions, array });
  }

  return depths.sort((a, b) => a.dimensions - b.dimensions);
}

/**
 * Snap a pixel window onto a block grid, clipped to the array extent.
 *
 * @param r0 - Row anywhere inside the wanted window.
 * @param c0 - Column anywhere inside the wanted window.
 * @param block - Block size in pixels.
 * @param height - Array height in pixels.
 * @param width - Array width in pixels.
 * @returns The block-aligned window covering `(r0, c0)`.
 *
 * @remarks
 * Comparing depths is only fair on a window whose reads are whole chunks at
 * every depth: the depth arrays trade bands for spatial extent, so their
 * chunks cover different footprints (`32x32` at 128-d, `128x128` at 4-d for
 * TESSERA v2). Aligning to the coarsest block keeps every depth reading
 * complete chunks, so the byte counts reflect the depth rather than the
 * fraction of a chunk that happened to be wasted.
 */
export function alignDepthWindow(
  r0: number,
  c0: number,
  block: number,
  height: number,
  width: number,
): DepthWindow {
  const ar0 = Math.max(0, Math.floor(r0 / block) * block);
  const ac0 = Math.max(0, Math.floor(c0 / block) * block);
  return {
    r0: ar0,
    c0: ac0,
    height: Math.min(block, height - ar0),
    width: Math.min(block, width - ac0),
  };
}

/**
 * Count the chunks a window touches, and the bytes they decode to.
 *
 * @param window - The pixel window being read.
 * @param chunkH - Chunk height in pixels.
 * @param chunkW - Chunk width in pixels.
 * @param nBands - Bands per pixel in the array being read.
 * @returns Chunks touched and their total decoded size in bytes.
 *
 * @remarks
 * Zarr reads whole chunks, so this — not the window's own pixel count — is
 * what a depth actually costs. Embeddings are `int8`, one byte per element.
 */
export function depthWindowCost(
  window: DepthWindow,
  chunkH: number,
  chunkW: number,
  nBands: number,
): { chunks: number; bytes: number } {
  const rows = chunkSpan(window.r0, window.height, chunkH);
  const cols = chunkSpan(window.c0, window.width, chunkW);
  const chunks = rows * cols;
  return { chunks, bytes: chunks * chunkH * chunkW * nBands };
}

/** Number of chunks of `size` spanned by `[start, start + length)`. */
function chunkSpan(start: number, length: number, size: number): number {
  if (length <= 0) return 0;
  return Math.floor((start + length - 1) / size) - Math.floor(start / size) + 1;
}
