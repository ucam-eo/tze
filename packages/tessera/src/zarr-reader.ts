import * as zarr from 'zarrita';
import { withRangeCoalescing, withRequestCoalescing } from './coalescing.js';
import { withRetry } from './retry.js';
import type { StoreMetadata } from './types.js';
import { parseDepths } from './depths.js';

/**
 * Parse a geoemb:model URL into a human-readable name + version.
 * e.g. "https://geotessera.org/model/1.0" → "TESSERA 1.0"
 *      "https://huggingface.co/made-with-clay/Clay" → "CLAY"
 */
export function parseModelName(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean);
    let name: string;
    if (host.includes('geotessera')) {
      name = 'TESSERA';
    } else if (host.includes('huggingface')) {
      name = (parts[1] ?? parts[0] ?? host.split('.')[0]).toUpperCase();
    } else {
      name = host.split('.')[0].toUpperCase();
    }
    // Last path segment as version if it looks like a version (digits/dots)
    const last = parts[parts.length - 1] ?? '';
    const isVersion = /^[\d.]+$/.test(last);
    return isVersion ? `${name} ${last}` : name;
  } catch { return url; }
}

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

  /** Root location of the zone group, for opening further arrays lazily. */
  rootLoc: zarr.Location<zarr.Readable>;
}

const parentAttrsCache = new Map<string, Promise<Record<string, unknown>>>();

/**
 * Read `geoemb:` attributes from a store's parent root group, memoised per URL.
 *
 * @remarks
 * Every UTM zone under a store shares one parent group, so without the cache
 * each zone re-fetches the identical `zarr.json`.
 */
function getParentAttrs(parentUrl: string): Promise<Record<string, unknown>> {
  let p = parentAttrsCache.get(parentUrl);
  if (!p) {
    p = (async () => {
      const parentStore = await zarr.extendStore(
        new zarr.FetchStore(parentUrl),
        withRetry,
        withRequestCoalescing,
        withRangeCoalescing,
      );
      const parentGroup = await zarr.open.v3(zarr.root(parentStore), { kind: 'group' });
      return parentGroup.attrs as Record<string, unknown>;
    })().catch(() => ({}));
    parentAttrsCache.set(parentUrl, p);
  }
  return p;
}

/**
 * Open a TESSERA Zarr v3 store over HTTP.
 *
 * @param url - Store root URL.
 * @returns Opened store with array handles and metadata.
 *
 * @remarks
 * Uses zarrita's FetchStore with the `withRangeCoalescing` extension for
 * efficient HTTP range requests: concurrent `getRange` calls on the same
 * path within a microtask are merged into one fetch. Reads group attributes
 * for CRS, transform, and array discovery.
 *
 * Every node is opened with `zarr.open.v3`. zarrita's auto-detecting
 * `zarr.open` probes v2 first on a store it has not seen before (`.zattrs`,
 * then `.zgroup`/`.zarray`), costing two sequential 404 round-trips per node
 * before it reaches `zarr.json`. TESSERA stores are always v3.
 */
export async function openStore(url: string): Promise<ZarrStore> {
  const store = await zarr.extendStore(
    new zarr.FetchStore(url),
    withRetry,
    withRequestCoalescing,
    withRangeCoalescing,
  );
  const rootLoc = zarr.root(store);

  const [group, embArr, scalesArr] = await Promise.all([
    zarr.open.v3(rootLoc, { kind: 'group' }),
    zarr.open.v3(rootLoc.resolve('embeddings'), { kind: 'array' }),
    zarr.open.v3(rootLoc.resolve('scales'), { kind: 'array' }),
  ]);
  const attrs = group.attrs as Record<string, unknown>;

  // --- Read geoemb: convention fields from parent root group ---
  // geoemb attributes live on the root store (e.g. store.zarr), not the
  // per-zone subgroup (e.g. store.zarr/utm30).
  const parentUrl = url.replace(/\/[^/]+\/?$/, '');
  const geoemAttrs: Record<string, unknown> =
    parentUrl !== url ? await getParentAttrs(parentUrl) : {};

  const geoemType = geoemAttrs['geoemb:type'] as string | undefined;
  const geoemDimensions = geoemAttrs['geoemb:dimensions'] as number | undefined;
  const geoemModel = geoemAttrs['geoemb:model'] as string | undefined;
  const geoemDataType = geoemAttrs['geoemb:data_type'] as string | undefined;

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
  const quantization = geoemAttrs['geoemb:quantization'] as
    { method?: string; original_dtype?: string; quantized_dtype?: string;
      scale?: { type: string; array_name?: string; nodata?: string; scale?: number; offset?: number };
      link?: string } | undefined;
  if (quantization) {
    if (quantization.method !== 'per_pixel_scale') {
      console.warn(`[tessera] Unsupported quantization method "${quantization.method}" — only per_pixel_scale is implemented`);
    }
    if (quantization.scale?.type === 'array' && quantization.scale.array_name && quantization.scale.array_name !== 'scales') {
      console.warn(`[tessera] Unexpected scale array_name "${quantization.scale.array_name}" — expected "scales"`);
    }
  }

  // --- Read optional geoemb: convention fields for provenance ---
  const geoemGsd = geoemAttrs['geoemb:gsd'] as number | undefined;
  const geoemSpatialLayout = geoemAttrs['geoemb:spatial_layout'] as string | undefined;
  const geoemBuildVersion = geoemAttrs['geoemb:build_version'] as string | undefined;
  const geoemSourceData = geoemAttrs['geoemb:source_data'] as string[] | undefined;
  const geoemBenchmark = geoemAttrs['geoemb:benchmark'] as string[] | undefined;
  const geoemChipLayout = geoemAttrs['geoemb:chip_layout'] as StoreMetadata['geoemb_chipLayout'];

  // Validate: chip_layout is required when type is "chip"
  if (geoemType === 'chip' && !geoemChipLayout) {
    console.warn('[tessera] geoemb:type is "chip" but geoemb:chip_layout is missing');
  }

  // Shared provenance fields injected into StoreMetadata
  const provenance = {
    geoemb_type: geoemType,
    geoemb_model: geoemModel,
    geoemb_modelName: geoemModel ? parseModelName(geoemModel) : undefined,
    geoemb_sourceData: geoemSourceData,
    geoemb_dataType: geoemDataType,
    geoemb_gsd: geoemGsd,
    geoemb_spatialLayout: geoemSpatialLayout,
    geoemb_buildVersion: geoemBuildVersion,
    geoemb_quantMethod: quantization?.method,
    geoemb_quantization: quantization ? {
      method: quantization.method ?? 'unknown',
      quantized_dtype: quantization.quantized_dtype,
      original_dtype: quantization.original_dtype,
      scale: quantization.scale ? {
        ...quantization.scale,
        type: quantization.scale.type as 'scalar' | 'array',
      } : undefined,
      link: quantization.link,
    } : undefined,
    geoemb_chipLayout: geoemChipLayout,
    geoemb_benchmark: geoemBenchmark,
  };

  // NCHW layout: 4D array with time dimension
  const isV2 = embArr.shape.length === 4;

  // Matryoshka depths. The truncated arrays are NCHW-only, so a store using
  // the older HWB layout is treated as having none regardless of the attribute.
  const depths = isV2
    ? parseDepths(geoemAttrs, (embArr.shape[1] as number) ?? 0)
    : [];

  let meta: StoreMetadata;

  if (isV2) {
    // NCHW layout — embArr.shape is [T, B, H, W]
    const [T, nBands, H, W] = embArr.shape as [number, number, number, number];
    const chunks = embArr.chunks as [number, number, number, number];

    // Derive years: try reading the time coordinate array
    let years: number[] = [];
    try {
      const timeArr = await zarr.open.v3(rootLoc.resolve('time'), { kind: 'array' });
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
      version: 'v2',
      years,
      timeIndex: years.length > 0 ? years.length - 1 : 0,
      ...provenance,
      geoemb_depths: depths,
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
      version: 'v1',
      ...provenance,
    };
  }

  // --- Cross-validate geoemb:dimensions against array shape ---
  if (meta.nBands !== geoemDimensions) {
    console.warn(`[tessera] geoemb:dimensions (${geoemDimensions}) does not match array nBands (${meta.nBands})`);
  }

  return { meta, embArr, scalesArr, rootLoc };
}

/**
 * Fetch a sliced region from a Zarr array.
 *
 * @param arr - A zarrita array handle.
 * @param slices - Per-axis slice: `[start, end]` or `null` for full axis.
 * @param opts - Optional configuration.
 * @param opts.signal - Optional abort signal, forwarded to the store.
 * @returns Raw typed array and shape.
 */
export async function fetchRegion(
  arr: zarr.Array<zarr.DataType>,
  slices: (null | [number, number])[],
  opts?: { signal?: AbortSignal },
): Promise<{ data: ArrayBufferView; shape: number[] }> {
  const sel = slices.map(s =>
    s === null ? null : zarr.slice(s[0], s[1])
  );
  const chunk = await zarr.get(arr, sel, { signal: opts?.signal });
  return chunk as { data: ArrayBufferView; shape: number[] };
}

/**
 * Open a further array under an already-open store.
 *
 * @param store - The opened store, whose root location and HTTP handle are reused.
 * @param name - Array name relative to the zone group (e.g. `embeddings_d4`).
 * @returns The opened zarrita array handle.
 *
 * @remarks
 * Reuses the store's extended handle, so these reads share its retry,
 * request-coalescing, and range-coalescing behaviour.
 */
export function openArray(store: ZarrStore, name: string): Promise<zarr.Array<zarr.DataType>> {
  return zarr.open.v3(store.rootLoc.resolve(name), { kind: 'array' });
}
