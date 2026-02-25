/** Overpass API client for querying OSM land use / natural features. */

export interface OsmCategory {
  tag: string;          // e.g. "landuse=forest"
  displayName: string;
  suggestedColor: string;
  polygons: [number, number][][];  // array of rings, each ring is [lng, lat][]
}

interface TagInfo {
  displayName: string;
  color: string;
}

const TAG_CONFIG: Record<string, Record<string, TagInfo>> = {
  landuse: {
    forest:       { displayName: 'Forest',       color: '#228b22' },
    farmland:     { displayName: 'Farmland',     color: '#c8b960' },
    residential:  { displayName: 'Residential',  color: '#d4a0a0' },
    industrial:   { displayName: 'Industrial',   color: '#a0a0c8' },
    meadow:       { displayName: 'Meadow',       color: '#7ec850' },
    grass:        { displayName: 'Grass',        color: '#90ee90' },
    orchard:      { displayName: 'Orchard',      color: '#6db36d' },
    vineyard:     { displayName: 'Vineyard',     color: '#9b7cb4' },
    quarry:       { displayName: 'Quarry',       color: '#9e9e9e' },
    retail:       { displayName: 'Retail',       color: '#e07878' },
    commercial:   { displayName: 'Commercial',   color: '#e8a0a0' },
  },
  natural: {
    water:     { displayName: 'Water',     color: '#4169e1' },
    wood:      { displayName: 'Wood',      color: '#2e8b57' },
    scrub:     { displayName: 'Scrub',     color: '#8fbc8f' },
    wetland:   { displayName: 'Wetland',   color: '#5f9ea0' },
    bare_rock: { displayName: 'Bare Rock', color: '#a9a9a9' },
    sand:      { displayName: 'Sand',      color: '#f4e1b0' },
    heath:     { displayName: 'Heath',     color: '#b8a040' },
    grassland: { displayName: 'Grassland', color: '#98fb98' },
  },
  leisure: {
    park:   { displayName: 'Park',   color: '#50c878' },
    garden: { displayName: 'Garden', color: '#77dd77' },
  },
};

/** Build Overpass QL query for all configured tags within a bbox.
 *  bbox: [south, west, north, east] */
function buildQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  const bb = `(${s},${w},${n},${e})`;
  const lines: string[] = ['[out:json][timeout:30];', '('];

  for (const [key, values] of Object.entries(TAG_CONFIG)) {
    for (const value of Object.keys(values)) {
      lines.push(`  way["${key}"="${value}"]${bb};`);
      lines.push(`  relation["${key}"="${value}"]${bb};`);
    }
  }

  lines.push(');', 'out geom;');
  return lines.join('\n');
}

/** Extract polygon rings from an Overpass element with inline geometry. */
function extractPolygons(element: Record<string, unknown>): [number, number][][] {
  const rings: [number, number][][] = [];

  if (element.type === 'way' && Array.isArray(element.geometry)) {
    const ring = (element.geometry as Array<{ lon: number; lat: number }>)
      .map(pt => [pt.lon, pt.lat] as [number, number]);
    if (ring.length >= 4) rings.push(ring);
  } else if (element.type === 'relation' && Array.isArray(element.members)) {
    for (const member of element.members as Array<Record<string, unknown>>) {
      if (member.role === 'outer' && Array.isArray(member.geometry)) {
        const ring = (member.geometry as Array<{ lon: number; lat: number }>)
          .map(pt => [pt.lon, pt.lat] as [number, number]);
        if (ring.length >= 4) rings.push(ring);
      }
    }
  }
  return rings;
}

/** Query the Overpass API and group results by tag.
 *  bbox: [south, west, north, east] */
export async function queryOverpass(
  bbox: [number, number, number, number],
  signal?: AbortSignal,
): Promise<OsmCategory[]> {
  const query = buildQuery(bbox);
  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal,
  });

  if (!resp.ok) {
    throw new Error(`Overpass API error: ${resp.status} ${resp.statusText}`);
  }

  const json = await resp.json() as { elements: Array<Record<string, unknown>> };

  // Group elements by matching tag
  const grouped = new Map<string, [number, number][][]>();

  for (const el of json.elements) {
    const tags = el.tags as Record<string, string> | undefined;
    if (!tags) continue;

    for (const [key, values] of Object.entries(TAG_CONFIG)) {
      const val = tags[key];
      if (val && val in values) {
        const tagKey = `${key}=${val}`;
        const polys = extractPolygons(el);
        if (polys.length > 0) {
          const existing = grouped.get(tagKey) ?? [];
          existing.push(...polys);
          grouped.set(tagKey, existing);
        }
        break;  // only match first tag per element
      }
    }
  }

  // Build OsmCategory array, sorted by polygon count desc
  const categories: OsmCategory[] = [];
  for (const [tagKey, polygons] of grouped) {
    const [key, value] = tagKey.split('=');
    const info = TAG_CONFIG[key]?.[value];
    if (!info) continue;
    categories.push({
      tag: tagKey,
      displayName: info.displayName,
      suggestedColor: info.color,
      polygons,
    });
  }

  categories.sort((a, b) => b.polygons.length - a.polygons.length);
  return categories;
}
