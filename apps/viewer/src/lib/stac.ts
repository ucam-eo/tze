import create from 'stac-js';

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

/**
 * Fetch a STAC catalog and walk its children/items to discover all UTM zone zarr stores.
 * Returns an array of ZoneDescriptor sorted by utmZone.
 */
export interface CatalogResult {
  zones: ZoneDescriptor[];
  availableYears: string[];               // e.g. ["2024", "2025"]
  globalPreviewUrls: Record<string, string>;  // year → preview zarr URL
  globalPreviewUrl: string | null;         // keep for back-compat (latest year)
  /** Union of all zone bounding boxes [west, south, east, north] */
  globalBounds: [number, number, number, number] | null;
}

export async function loadCatalog(catalogUrl: string, signal?: AbortSignal): Promise<CatalogResult> {
  const zones: ZoneDescriptor[] = [];
  let globalBounds: [number, number, number, number] | null = null;

  // Resolve relative catalog URLs against the page origin so that
  // new URL(href, base) works for relative STAC link resolution,
  // and fetch() routes through the Vite/proxy server.
  const resolvedCatalogUrl = new URL(catalogUrl, window.location.href).href;

  // 1. Fetch and parse the root catalog
  //    Pass migrate=false: our catalog is already STAC 1.1 and stac-migrate
  //    mangles 1.1 catalogs (drops child links).
  const catalogData = await fetchJson(resolvedCatalogUrl, signal);
  const catalog = create(catalogData as Record<string, unknown>, false);

  // 2. Follow child links (rel=child → collections)
  const childLinks = catalog.getChildLinks();
  for (const link of childLinks) {
    const collectionUrl = new URL(link.href, resolvedCatalogUrl).href;
    const collectionData = await fetchJson(collectionUrl, signal);
    const collection = create(collectionData as Record<string, unknown>, false);

    // 3. Follow item links (rel=item → items)
    const itemLinks = collection.getItemLinks();
    for (const itemLink of itemLinks) {
      const itemUrl = new URL(itemLink.href, collectionUrl).href;
      const itemData = await fetchJson(itemUrl, signal) as Record<string, unknown>;
      const item = create(itemData, false);

      // 4. Extract zone info from item
      const props = item.properties as Record<string, unknown>;
      const assets = item.assets as Record<string, { href: string }>;
      const zarrAsset = assets?.zarr;
      if (!zarrAsset) continue;

      const zarrUrl = new URL(zarrAsset.href, itemUrl).href;

      zones.push({
        id: item.id as string,
        utmZone: props['tessera:utm_zone'] as number,
        epsg: parseInt((props['proj:code'] as string).split(':')[1], 10),
        bbox: item.bbox as [number, number, number, number],
        geometry: (item.geometry as GeoJSON.Polygon),
        zarrUrl,
        title: (item.title as string) ?? undefined,
      });
    }
  }

  // Sort by UTM zone number
  zones.sort((a, b) => a.utmZone - b.utmZone);

  // Probe for global preview stores (one per year)
  const baseUrl = resolvedCatalogUrl.replace(/\/[^/]*$/, '/');
  const years = [...new Set(
    zones.map(z => z.id.match(/_(\d{4})$/)?.[1]).filter(Boolean)
  )].sort() as string[];

  const globalPreviewUrls: Record<string, string> = {};
  for (const year of years) {
    const candidateUrl = `${baseUrl}${year}.zarr/global_rgb`;
    try {
      const resp = await fetch(`${candidateUrl}/zarr.json`, { signal });
      if (resp.ok) {
        globalPreviewUrls[year] = candidateUrl;
        if (!globalBounds) {
          const zarrMeta = await resp.json() as Record<string, unknown>;
          const attrs = zarrMeta.attributes as Record<string, unknown> | undefined;
          const spatialBbox = attrs?.['spatial:bbox'] as [number, number, number, number] | undefined;
          const spatial = attrs?.spatial as { bounds?: [number, number, number, number] } | undefined;
          if (spatialBbox) {
            globalBounds = spatialBbox;
          } else if (spatial?.bounds) {
            globalBounds = spatial.bounds;
          }
        }
      }
    } catch {
      // Preview not available for this year
    }
  }

  const latestYear = years[years.length - 1] ?? null;
  const globalPreviewUrl = latestYear ? (globalPreviewUrls[latestYear] ?? null) : null;

  // Fall back to computing bounds from zone bboxes
  if (!globalBounds && zones.length > 0) {
    globalBounds = [
      Math.min(...zones.map(z => z.bbox[0])),
      Math.min(...zones.map(z => z.bbox[1])),
      Math.max(...zones.map(z => z.bbox[2])),
      Math.max(...zones.map(z => z.bbox[3])),
    ];
  }

  return { zones, availableYears: years, globalPreviewUrls, globalPreviewUrl, globalBounds };
}

/**
 * Load a v2 tessera store directly (no STAC catalog).
 * Discovers zones from consolidated metadata in the root zarr.json.
 */
export async function loadV2Store(storeUrl: string, signal?: AbortSignal): Promise<CatalogResult> {
  const resolvedUrl = new URL(storeUrl, window.location.href).href;
  const rootUrl = resolvedUrl.endsWith('/') ? resolvedUrl : resolvedUrl + '/';

  // Fetch root zarr.json (includes consolidated metadata)
  const rootMeta = await fetchJson(`${rootUrl}zarr.json`, signal) as Record<string, unknown>;
  const rootAttrs = (rootMeta.attributes ?? {}) as Record<string, unknown>;

  const datasetVersion = rootAttrs['tessera:dataset_version'] as string;
  if (datasetVersion !== 'v2') {
    throw new Error(`Expected tessera:dataset_version="v2", got "${datasetVersion}"`);
  }

  const years = (rootAttrs['tessera:years'] as number[]) ?? [];

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
      const utmZone = attrs['tessera:utm_zone'] as number;
      const projCode = attrs['proj:code'] as string;
      if (!utmZone || !projCode) continue;

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
