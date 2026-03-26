import * as zarr from 'zarrita';
import type { StoreMetadata } from './types.js';

/**
 * Opened Zarr v3 store with discovered arrays and metadata.
 *
 * @remarks
 * Returned by {@link openStore}. Contains zarrita array handles
 * ready for slicing/fetching.
 *
 * @internal — Consumers should use TesseraSource rather than
 * accessing this directly.
 */
export interface ZarrStore {
  /** Parsed store metadata. */
  meta: StoreMetadata;

  /** The main embeddings array. v1: `[H, W, B]`, v2: `[T, B, H, W]`. */
  embArr: zarr.Array<zarr.DataType>;

  /** Per-pixel dequantisation scales. v1: `[H, W]`, v2: `[T, H, W]`. */
  scalesArr: zarr.Array<zarr.DataType>;

  /** Pre-rendered RGB preview array, if present. */
  rgbArr: zarr.Array<zarr.DataType> | null;

  /**
   * Set of existing chunk keys (e.g. `"3_7"`), loaded from
   * `_chunk_manifest.json` if available. Used to skip 404s for
   * sparse stores.
   */
  chunkManifest: Set<string> | null;
}

/**
 * Open a TESSERA Zarr v3 store over HTTP.
 *
 * @param url - Store root URL.
 * @returns Opened store with array handles and metadata.
 *
 * @remarks
 * Uses zarrita's FetchStore + CoalescingStore for efficient HTTP
 * range requests. Reads group attributes for CRS, transform, and
 * array discovery.
 */
export async function openStore(url: string): Promise<ZarrStore> {
  const fetchStore = new zarr.FetchStore(url);
  const store = new zarr.CoalescingStore(fetchStore);
  const rootLoc = zarr.root(store);
  const group = await zarr.open(rootLoc, { kind: 'group' });
  const attrs = group.attrs as Record<string, unknown>;

  const embArr = await zarr.open(rootLoc.resolve('embeddings'), { kind: 'array' });
  const scalesArr = await zarr.open(rootLoc.resolve('scales'), { kind: 'array' });

  // --- Validate geoemb: convention (required fields) ---
  const geoemType = attrs['geoemb:type'] as string | undefined;
  const geoemDimensions = attrs['geoemb:dimensions'] as number | undefined;
  const geoemModel = attrs['geoemb:model'] as string | undefined;
  const geoemDataType = attrs['geoemb:data_type'] as string | undefined;

  if (!geoemType || !geoemDimensions || !geoemModel || !geoemDataType) {
    const missing = [
      !geoemType && 'geoemb:type',
      !geoemDimensions && 'geoemb:dimensions',
      !geoemModel && 'geoemb:model',
      !geoemDataType && 'geoemb:data_type',
    ].filter(Boolean).join(', ');
    console.warn(`[tessera] Missing geoemb convention fields: ${missing} — provenance metadata will be incomplete`);
  }

  // --- Read proj: and spatial: conventions ---
  const projCode = attrs['proj:code'] as string;
  const epsg = parseInt(projCode.split(':')[1], 10);
  // Derive UTM zone from EPSG code (326xx → zone xx)
  const utmZone = epsg > 32600 && epsg <= 32660 ? epsg - 32600
                : epsg > 32700 && epsg <= 32760 ? epsg - 32700
                : 0;
  const transform = attrs['spatial:transform'] as [number, number, number, number, number, number];

  if (!utmZone || !transform || !embArr.shape) {
    throw new Error('Missing required store metadata (proj:code, spatial:transform, shape)');
  }

  // --- Validate geoemb:quantization if present ---
  const quantization = attrs['geoemb:quantization'] as
    { method?: string; original_dtype?: string; scale_array?: string } | undefined;
  if (quantization) {
    if (quantization.method !== 'per_pixel_scale') {
      console.warn(`[tessera] Unsupported quantization method "${quantization.method}" — only per_pixel_scale is implemented`);
    }
    if (quantization.scale_array && quantization.scale_array !== 'scales') {
      console.warn(`[tessera] Unexpected scale_array "${quantization.scale_array}" — expected "scales"`);
    }
  }

  // --- Read optional geoemb: convention fields for provenance ---
  const geoemGsd = attrs['geoemb:gsd'] as number | undefined;
  const geoemSpatialLayout = attrs['geoemb:spatial_layout'] as string | undefined;
  const geoemBuildVersion = attrs['geoemb:build_version'] as string | undefined;
  const geoemSourceData = attrs['geoemb:source_data'] as string | string[] | undefined;

  // Shared provenance fields injected into StoreMetadata
  const provenance = {
    geoemb_type: geoemType,
    geoemb_model: geoemModel,
    geoemb_sourceData: geoemSourceData,
    geoemb_dataType: geoemDataType,
    geoemb_gsd: geoemGsd,
    geoemb_spatialLayout: geoemSpatialLayout,
    geoemb_buildVersion: geoemBuildVersion,
    geoemb_quantMethod: quantization?.method,
  };

  // NCHW layout: 4D array with time dimension
  const isV2 = embArr.shape.length === 4;

  // Try optional preview arrays
  let rgbArr: zarr.Array<zarr.DataType> | null = null;
  let hasRgb = false;

  try {
    rgbArr = await zarr.open(rootLoc.resolve('rgb'), { kind: 'array' });
    hasRgb = true;
  } catch { /* no rgb preview */ }

  // Try chunk manifest
  let chunkManifest: Set<string> | null = null;
  try {
    const resp = await fetch(`${url}/_chunk_manifest.json`);
    if (resp.ok) {
      const data = await resp.json();
      if (data?.chunks) {
        chunkManifest = new Set(
          (data.chunks as [number, number][]).map(([ci, cj]) => `${ci}_${cj}`)
        );
      }
      if (data?.has_rgb !== undefined) hasRgb = data.has_rgb;

      // Re-open rgb array if manifest says it exists but we didn't find it
      if (hasRgb && !rgbArr) {
        try { rgbArr = await zarr.open(rootLoc.resolve('rgb'), { kind: 'array' }); } catch { hasRgb = false; }
      }
    }
  } catch { /* no manifest */ }

  let meta: StoreMetadata;

  if (isV2) {
    // NCHW layout — embArr.shape is [T, B, H, W]
    const [T, nBands, H, W] = embArr.shape as [number, number, number, number];
    const chunks = embArr.chunks as [number, number, number, number];

    // Derive years: try reading the time coordinate array
    let years: number[] = [];
    try {
      const timeArr = await zarr.open(rootLoc.resolve('time'), { kind: 'array' });
      const timeData = await zarr.get(timeArr, [null]);
      years = Array.from(timeData.data as Int32Array);
    } catch {
      // Fallback: generate [0, 1, ..., T-1] if time array not readable
      years = Array.from({ length: T }, (_, i) => i);
    }

    meta = {
      url,
      utmZone,
      epsg,
      transform,
      shape: [H, W, nBands],
      chunkShape: [chunks[2], chunks[3], chunks[1]],
      nBands,
      hasRgb,
      version: 'v2',
      years,
      timeIndex: years.length > 0 ? years.length - 1 : 0,
      ...provenance,
    };
  } else {
    // HWB layout — embArr.shape is [H, W, B]
    meta = {
      url,
      utmZone,
      epsg,
      transform,
      shape: embArr.shape as [number, number, number],
      chunkShape: embArr.chunks as [number, number, number],
      nBands: (embArr.shape[2] as number) || 128,
      hasRgb,
      version: 'v1',
      ...provenance,
    };
  }

  // --- Cross-validate geoemb:dimensions against array shape ---
  if (meta.nBands !== geoemDimensions) {
    console.warn(`[tessera] geoemb:dimensions (${geoemDimensions}) does not match array nBands (${meta.nBands})`);
  }

  return { meta, embArr, scalesArr, rgbArr, chunkManifest };
}

/**
 * Fetch a sliced region from a Zarr array.
 *
 * @param arr - A zarrita array handle.
 * @param slices - Per-axis slice: `[start, end]` or `null` for full axis.
 * @param opts - Optional configuration.
 * @param opts.onProgress - Optional progress callback (bytes loaded).
 * @returns Raw typed array and shape.
 */
export async function fetchRegion(
  arr: zarr.Array<zarr.DataType>,
  slices: (null | [number, number])[],
  opts?: { onProgress?: zarr.ProgressCallback },
): Promise<{ data: ArrayBufferView; shape: number[] }> {
  const sel = slices.map(s =>
    s === null ? null : zarr.slice(s[0], s[1])
  );
  const chunk = await zarr.get(arr, sel, {
    onProgress: opts?.onProgress,
  });
  return chunk as { data: ArrayBufferView; shape: number[] };
}
