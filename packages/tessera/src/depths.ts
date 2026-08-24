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

import type { ChunkRef } from './types.js';

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

/** A single read covering one chunk, and the tiles it satisfies. */
export interface TileGroup extends DepthWindow {
  tiles: ChunkRef[];
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
 * Batch tile requests into whole chunks of the array being read.
 *
 * @param tiles - Region tiles wanted, in the region's own tile grid.
 * @param tileH - Region tile height in pixels.
 * @param tileW - Region tile width in pixels.
 * @param chunkH - Chunk height of the array being read.
 * @param chunkW - Chunk width of the array being read.
 * @param imageH - Array height, for clipping the last row.
 * @param imageW - Array width, for clipping the last column.
 * @returns One entry per chunk touched, each naming the tiles it satisfies.
 *
 * @remarks
 * The depth arrays trade bands for spatial extent, so a shallow array's chunk
 * spans several region tiles — 64x64 at 16-d, 128x128 at 4-d, against a 32x32
 * tile. Reading tile by tile would decode a whole chunk per tile and discard
 * most of it, cutting the saving at 16-d from 8x to 2x. Grouping first means
 * each chunk is decoded once. At full depth chunk and tile coincide, so every
 * group holds exactly one tile and the request pattern is unchanged.
 */
export function groupTilesByChunk(
  tiles: readonly ChunkRef[],
  tileH: number,
  tileW: number,
  chunkH: number,
  chunkW: number,
  imageH: number,
  imageW: number,
): TileGroup[] {
  const groups = new Map<string, TileGroup>();

  for (const tile of tiles) {
    const r0 = Math.floor((tile.ci * tileH) / chunkH) * chunkH;
    const c0 = Math.floor((tile.cj * tileW) / chunkW) * chunkW;
    const key = `${r0}_${c0}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        r0,
        c0,
        height: Math.min(chunkH, imageH - r0),
        width: Math.min(chunkW, imageW - c0),
        tiles: [],
      };
      groups.set(key, group);
    }
    group.tiles.push(tile);
  }

  return [...groups.values()];
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
