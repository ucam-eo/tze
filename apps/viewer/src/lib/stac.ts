export interface ZoneDescriptor {
  id: string;                // e.g. "utm30_2025"
  utmZone: number;           // e.g. 30
  epsg: number;              // e.g. 32630
  bbox: [number, number, number, number]; // [w, s, e, n] WGS84
  geometry: GeoJSON.Polygon;
  zarrUrl: string;           // resolved absolute URL
  title?: string;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.json();
}

export interface CatalogResult {
  zones: ZoneDescriptor[];
  availableYears: string[];               // e.g. ["2024", "2025"]
  globalPreviewUrls: Record<string, string>;  // year → preview zarr URL
  globalPreviewUrl: string | null;         // keep for back-compat (latest year)
  /** Union of all zone bounding boxes [west, south, east, north] */
  globalBounds: [number, number, number, number] | null;
}

/**
 * Load a tessera store directly from a zarr URL.
 * Discovers zones from consolidated metadata in the root zarr.json.
 */
export async function loadStore(storeUrl: string, signal?: AbortSignal): Promise<CatalogResult> {
  const resolvedUrl = new URL(storeUrl, window.location.href).href;
  const rootUrl = resolvedUrl.endsWith('/') ? resolvedUrl : resolvedUrl + '/';

  // Fetch root zarr.json (includes consolidated metadata)
  const rootMeta = await fetchJson(`${rootUrl}zarr.json`, signal) as Record<string, unknown>;
  const rootAttrs = (rootMeta.attributes ?? {}) as Record<string, unknown>;

  // Detect tessera store from geoemb:model URL
  const geoemModel = (rootAttrs['geoemb:model'] as string) ?? '';
  if (!geoemModel.includes('geotessera.org')) {
    throw new Error(`Expected a tessera store (geoemb:model containing "geotessera.org"), got "${geoemModel}"`);
  }

  // Derive years from the first zone's time coordinate array (via consolidated metadata)
  let years: number[] = [];

  // Extract zones from consolidated metadata
  const consolidated = (rootMeta as Record<string, unknown>).consolidated_metadata as {
    metadata?: Record<string, Record<string, unknown>>
  } | undefined;

  const zones: ZoneDescriptor[] = [];
  const zonePattern = /^utm(\d{2})$/;

  if (consolidated?.metadata) {
    for (const [name, groupMeta] of Object.entries(consolidated.metadata)) {
      const m = zonePattern.exec(name);
      if (!m) continue;

      const attrs = (groupMeta.attributes ?? {}) as Record<string, unknown>;
      const projCode = attrs['proj:code'] as string;
      if (!projCode) continue;
      // Derive UTM zone from EPSG code
      const epsgNum = parseInt(projCode.split(':')[1], 10);
      const utmZone = epsgNum > 32600 && epsgNum <= 32660 ? epsgNum - 32600
                     : epsgNum > 32700 && epsgNum <= 32760 ? epsgNum - 32700
                     : parseInt(m[1], 10);  // fallback: parse from group name

      const epsg = parseInt(projCode.split(':')[1], 10);
      const transform = attrs['spatial:transform'] as number[];
      const shape = attrs['spatial:shape'] as number[];
      if (!transform || !shape) continue;

      // Compute WGS84 bbox from UTM extent
      const originE = transform[2];
      const originN = transform[5];
      const pixelSize = transform[0];
      const [H, W] = shape;
      const westLon = (utmZone - 1) * 6 - 180;
      const eastLon = utmZone * 6 - 180;
      // Approximate lat bounds from northing
      const maxN = originN;
      const minN = originN - H * pixelSize;
      const approxLatN = Math.min(84, maxN / 111320);
      const approxLatS = Math.max(-80, minN / 111320);

      zones.push({
        id: name,
        utmZone,
        epsg,
        bbox: [westLon, approxLatS, eastLon, approxLatN],
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [westLon, approxLatS],
            [eastLon, approxLatS],
            [eastLon, approxLatN],
            [westLon, approxLatN],
            [westLon, approxLatS],
          ]],
        },
        zarrUrl: `${rootUrl}${name}`,
      });
    }
  }

  zones.sort((a, b) => a.utmZone - b.utmZone);

  // Derive years from the time array of the first zone
  if (years.length === 0 && consolidated?.metadata && zones.length > 0) {
    const firstZone = zones[0].id;
    const timeKey = `${firstZone}/time`;
    const timeMeta = consolidated.metadata[timeKey] as Record<string, unknown> | undefined;
    if (timeMeta) {
      // The time array shape tells us how many years; actual values need a fetch
      const shape = timeMeta.shape as number[] | undefined;
      if (shape && shape[0] > 0) {
        // Fetch the actual time values from the zarr
        try {
          const timeUrl = `${rootUrl}${firstZone}/time/c/0`;
          const resp = await fetch(timeUrl, { signal });
          if (resp.ok) {
            const buf = await resp.arrayBuffer();
            const int32s = new Int32Array(buf);
            years = Array.from(int32s).filter(v => v >= 1970 && v <= 2100);
          }
        } catch { /* fall back to empty years */ }
      }
    }
  }

  // Check for global preview
  let globalPreviewUrl: string | null = null;
  const globalPreviewUrls: Record<string, string> = {};
  let globalBounds: [number, number, number, number] | null = null;

  try {
    const gpUrl = `${rootUrl}global_rgb`;
    const resp = await fetch(`${gpUrl}/zarr.json`, { signal });
    if (resp.ok) {
      globalPreviewUrl = gpUrl;
      const latestYear = years[years.length - 1];
      if (latestYear) globalPreviewUrls[String(latestYear)] = gpUrl;
      globalBounds = [-180, -90, 180, 90];
    }
  } catch { /* no global preview */ }

  if (!globalBounds && zones.length > 0) {
    globalBounds = [
      Math.min(...zones.map(z => z.bbox[0])),
      Math.min(...zones.map(z => z.bbox[1])),
      Math.max(...zones.map(z => z.bbox[2])),
      Math.max(...zones.map(z => z.bbox[3])),
    ];
  }

  return {
    zones,
    availableYears: years.map(String),
    globalPreviewUrls,
    globalPreviewUrl,
    globalBounds,
  };
}

/** Simple point-in-bbox test (WGS84). */
export function pointInBbox(lng: number, lat: number, bbox: [number, number, number, number]): boolean {
  const [w, s, e, n] = bbox;
  return lng >= w && lng <= e && lat >= s && lat <= n;
}
