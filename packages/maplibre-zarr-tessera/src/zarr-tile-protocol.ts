/**
 * Custom MapLibre tile protocol that serves Zarr v3 multiscale RGB stores
 * as standard raster tiles. Fixes 3D perspective rendering (unlike
 * @carbonplan/zarr-layer's CustomLayerInterface which doesn't handle pitch).
 *
 * Usage:
 *   registerZarrProtocol(maplibregl);
 *   map.addSource('preview', {
 *     type: 'raster',
 *     tiles: ['zarr://https://example.com/store.zarr/rgb/{z}/{x}/{y}'],
 *     tileSize: 256,
 *   });
 */
import * as zarr from 'zarrita';

interface PyramidLevel {
  arr: zarr.Array<zarr.DataType>;
  shape: [number, number, number]; // [lat, lon, band]
}

// Cache: storeUrl/variable → opened pyramid levels
const pyramidCache = new Map<string, Promise<PyramidLevel[]>>();

async function openPyramid(storeUrl: string, variable: string): Promise<PyramidLevel[]> {
  const fetchStore = new zarr.FetchStore(storeUrl);
  const store = new zarr.CoalescingStore(fetchStore);
  const rootLoc = zarr.root(store);
  const group = await zarr.open(rootLoc, { kind: 'group' });
  const attrs = group.attrs as Record<string, unknown>;

  // Read multiscales metadata to discover pyramid levels
  const ms = attrs.multiscales as { layout: { asset: string }[] } | undefined;
  if (!ms?.layout) {
    throw new Error('No multiscales metadata in store');
  }

  const levels: PyramidLevel[] = [];
  for (const entry of ms.layout) {
    const path = `${entry.asset}/${variable}`;
    const arr = await zarr.open(rootLoc.resolve(path), { kind: 'array' });
    levels.push({
      arr,
      shape: arr.shape as [number, number, number],
    });
  }
  return levels;
}

function getOrOpenPyramid(storeUrl: string, variable: string): Promise<PyramidLevel[]> {
  const key = `${storeUrl}/${variable}`;
  let p = pyramidCache.get(key);
  if (!p) {
    p = openPyramid(storeUrl, variable);
    pyramidCache.set(key, p);
  }
  return p;
}

/** Convert web-mercator tile {z,x,y} to WGS84 lat/lon bounds. */
function tileBounds(z: number, x: number, y: number) {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  const s = Math.PI - (2 * Math.PI * (y + 1)) / (1 << z);
  return {
    west: (x / (1 << z)) * 360 - 180,
    east: ((x + 1) / (1 << z)) * 360 - 180,
    north: (180 / Math.PI) * Math.atan(Math.sinh(n)),
    south: (180 / Math.PI) * Math.atan(Math.sinh(s)),
  };
}

/** Select the coarsest pyramid level that has enough resolution for this zoom. */
function selectLevel(levels: PyramidLevel[], z: number): PyramidLevel {
  // At zoom z, a tile covers 360/2^z degrees and renders at TILE_SIZE pixels.
  // We need at least TILE_SIZE / (360/2^z) = TILE_SIZE * 2^z / 360 pixels per degree.
  const neededPxPerDeg = (TILE_SIZE * (1 << z)) / 360;

  // Levels are ordered finest (0) to coarsest (N). Pick coarsest with enough resolution.
  for (let i = levels.length - 1; i >= 0; i--) {
    const pxPerDeg = levels[i].shape[1] / 360;
    if (pxPerDeg >= neededPxPerDeg * 0.5) return levels[i];
  }
  return levels[0];
}

const TILE_SIZE = 256;

/**
 * Register the `zarr://` tile protocol with MapLibre.
 *
 * Tile URL format: `zarr://STORE_URL/VARIABLE/{z}/{x}/{y}`
 * e.g. `zarr://https://example.com/global_rgb.zarr/rgb/{z}/{x}/{y}`
 */
export function registerZarrProtocol(maplibregl: { addProtocol: (name: string, handler: Function) => void }): void {
  maplibregl.addProtocol('zarr', async (params: { url: string }, _abortController: AbortController) => {
    // Parse: zarr://STORE_URL/VARIABLE/{z}/{x}/{y}
    const raw = params.url.replace('zarr://', '');
    const parts = raw.split('/');
    const y = parseInt(parts.pop()!);
    const x = parseInt(parts.pop()!);
    const z = parseInt(parts.pop()!);
    const variable = parts.pop()!; // e.g. "rgb" or "pca_rgb"
    const storeUrl = parts.join('/');

    const levels = await getOrOpenPyramid(storeUrl, variable);
    const level = selectLevel(levels, z);
    const bounds = tileBounds(z, x, y);

    // Map lat/lon bounds → pixel coordinates in this pyramid level
    // Longitude: [-180, 180] → [0, shape[1]]
    // Latitude: [90, -90] → [0, shape[0]]  (north at row 0, descending)
    const lonToPx = (lon: number) => ((lon + 180) / 360) * level.shape[1];
    const latToPx = (lat: number) => ((90 - lat) / 180) * level.shape[0];

    const px0 = Math.floor(lonToPx(bounds.west));
    const px1 = Math.ceil(lonToPx(bounds.east));
    const py0 = Math.floor(latToPx(bounds.north));
    const py1 = Math.ceil(latToPx(bounds.south));

    // Clamp to array bounds
    const r0 = Math.max(0, py0);
    const r1 = Math.min(level.shape[0], py1);
    const c0 = Math.max(0, px0);
    const c1 = Math.min(level.shape[1], px1);

    if (r1 <= r0 || c1 <= c0) {
      return { data: new Uint8Array(0) };
    }

    // Fetch the region from Zarr — dimensions are [lat, lon, band]
    const result = await zarr.get(level.arr, [
      zarr.slice(r0, r1),
      zarr.slice(c0, c1),
      null,
    ]);

    const rawData = result.data as Uint8Array;
    const src = new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength);
    const srcH = r1 - r0;
    const srcW = c1 - c0;
    const nBands = level.shape[2]; // typically 4 (RGBA)

    // Render to RGBA tile via canvas and encode as PNG
    const canvas = document.createElement('canvas');
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(TILE_SIZE, TILE_SIZE);
    const out = imgData.data;

    for (let ty = 0; ty < TILE_SIZE; ty++) {
      const srcY = Math.min(srcH - 1, Math.floor((ty / TILE_SIZE) * srcH));
      for (let tx = 0; tx < TILE_SIZE; tx++) {
        const srcX = Math.min(srcW - 1, Math.floor((tx / TILE_SIZE) * srcW));
        const srcIdx = (srcY * srcW + srcX) * nBands;
        const dstIdx = (ty * TILE_SIZE + tx) * 4;
        out[dstIdx]     = src[srcIdx];         // R
        out[dstIdx + 1] = src[srcIdx + 1];     // G
        out[dstIdx + 2] = src[srcIdx + 2];     // B
        out[dstIdx + 3] = nBands >= 4 ? src[srcIdx + 3] : 255; // A
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    const arrayBuf = await blob.arrayBuffer();
    return { data: new Uint8Array(arrayBuf) };
  });
}

/** Clear the pyramid cache (e.g. when switching preview variable). */
export function clearZarrProtocolCache(): void {
  pyramidCache.clear();
}
