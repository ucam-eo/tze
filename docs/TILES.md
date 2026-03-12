# Global Preview Tiles: End-to-End Pipeline

This documents how the global RGB preview layer works, from Zarr store
generation through to rendering on the map.

## Store Layout

The global preview is a Zarr v3 store with a multiscale pyramid:

```
global_rgb_{year}.zarr/
  zarr.json                  # root: multiscales + spatial:bbox
  0/
    rgb/  c/0/0/0 ...        # full resolution (lat, lon, band)
    band/ c/0               # coordinate array [0,1,2,3]
  1/
    rgb/  ...                # 2x coarsened
    band/
  ...
  6/
    rgb/  ...                # 64x coarsened
    band/
```

Each pyramid level halves the previous level's dimensions using mean
resampling. The `band` coordinate arrays are 1-D `int32` arrays
`[0, 1, 2, 3]` required by `@carbonplan/zarr-layer` for band selection.

## 1. Generation (`geotessera`)

### Zone Discovery

`build_global_preview()` in `zarr_zone.py` scans a directory for zone
stores matching `utm{ZZ}_{year}.zarr`. An optional `--zones` flag
filters to specific UTM zone numbers. The year in the filename matters:
`utm30_2025.zarr` and `utm19_2024.zarr` are different years and must not
be mixed.

### Bounds Computation

For each zone store, the code reads `proj:code`, `spatial:transform`
(affine parameters), and the preview array shape. It computes 8 sample points
in UTM coordinates (4 corners + 4 mid-edge points for accuracy at high
latitudes) and reprojects them from `EPSG:{zone}` to `EPSG:4326` via
`pyproj.Transformer(always_xy=True)`. The min/max lon/lat across all
reprojected points gives the zone's WGS84 bounding box. The union of
all zone boxes gives `global_bounds = (west, south, east, north)`.

### Array Dimensions

At `base_res = 0.0001` degrees (~10 m at the equator):

```python
level0_w = ceil((east - west) / base_res)
level0_h = ceil((north - south) / base_res)
```

The `ceil` means the pixel grid may extend a fraction of a pixel beyond
the south/east bounds. The pixel coordinate system is:

- Column `j` → longitude `west + j * base_res`
- Row `i` → latitude `north - i * base_res` (north-up, row 0 = north)

### Reprojection (Phase 1)

Creates a temporary Zarr v3 store with shape `(level0_h, level0_w, 4)`,
chunk size `512×512×4`, dtype `uint8`, Blosc/zstd compression, dimension
names `["lat", "lon", "band"]`.

For each zone, the code computes the zone's pixel extent in the global
array, divides it into tiles (strips of 2048 rows, max 65536 columns),
and processes tiles in parallel via `ThreadPoolExecutor`.

Each tile is reprojected using `rasterio.warp.reproject()` with
`Resampling.average`. The destination Affine transform is:

```python
Affine(base_res, 0, tile_west, 0, -base_res, dst_north)
```

This places pixel (0,0)'s top-left corner at `(tile_west, dst_north)`.

### Pyramid (Phase 2)

Level 0 is the full-resolution reprojected data. Each subsequent level
halves the dimensions by reading strips from the previous level,
reshaping into 2×2 blocks, and computing the mean.

### Metadata

The store root attributes contain:

```json
{
  "zarr_conventions": [
    {"name": "multiscales", "uuid": "d35379db-..."},
    {"name": "proj:", "uuid": "f17cb550-..."},
    {"name": "spatial:", "uuid": "689b58e2-..."}
  ],
  "proj:code": "EPSG:4326",
  "multiscales": {
    "layout": [
      {"asset": "0", "transform": {"scale": [1, 1], "translation": [0, 0]},
       "spatial:shape": [1800000, 3600000], "spatial:transform": [0.0001, 0, -180, 0, -0.0001, 90]},
      {"asset": "1", "transform": {"scale": [2, 2], "translation": [0.5, 0.5]},
       "derived_from": "0", "resampling_method": "mean",
       "spatial:shape": [900000, 1800000], "spatial:transform": [0.0002, 0, -180, 0, -0.0002, 90]},
      ...
    ]
  },
  "spatial:dimensions": ["lat", "lon"],
  "spatial:bbox": [west, south, east, north]
}
```

The `layout` format follows [zarr-conventions/multiscales v1](https://github.com/zarr-conventions/multiscales).
Metadata is consolidated via `zarr.consolidate_metadata()` so the viewer
can read all array shapes/codecs from a single `zarr.json` fetch.

### Critical Invariant

**`spatial:bbox` must match the array dimensions.** The bounds define
the geographic extent that `ceil(extent / resolution)` must equal the
array's pixel count. If the bounds are wrong (e.g. computed from a
different set of zones than were used to build the store), tiles will
render at the wrong location.

## 2. Post-Hoc Patching (`patch_global_bounds.py`)

The patch script adds band coordinate arrays and spatial bounds to
existing stores. It extracts the year from the store filename
(`global_rgb_2025.zarr` → 2025), finds matching zone stores
(`utm*_2025.zarr`), and recomputes bounds using the exact same UTM
corner reprojection algorithm as `build_global_preview`.

It validates the computed dimensions against the actual array shape. If
they don't match (store was built with `--zones` filter), pass `--zones`
to the patch script too.

```bash
python scripts/patch_global_bounds.py /path/to/zarr/v0/ --zones 29,30,31,32
```

## 3. STAC Catalog Discovery (`stac.ts`)

The viewer discovers stores by walking a STAC catalog:

```
catalog.json → collections → items → zarr assets
```

Each item yields a `ZoneDescriptor` with `utmZone`, `epsg`, `bbox`,
`geometry`, and `zarrUrl`.

After zone discovery, the viewer probes for the global preview store:

```typescript
const candidateUrl = `${baseUrl}global_rgb_${latestYear}.zarr`;
const resp = await fetch(`${candidateUrl}/zarr.json`);
// Read attributes["spatial:bbox"] from zarr.json
```

This gives `globalPreviewUrl` and `globalBounds` (format:
`[west, south, east, north]`). Falls back to the union of zone bboxes
if the store has no `spatial:bbox`.

## 4. Rendering (`zarr-source.ts` + `@carbonplan/zarr-layer`)

The preview layer is a `ZarrLayer` (from `@carbonplan/zarr-layer@^0.3.1`)
added as a MapLibre custom layer:

```typescript
new ZarrLayer({
  source: globalPreviewUrl,
  variable: 'rgb',
  selector: { band: [0, 1, 2, 3] },
  bounds: [west, south, east, north],
  zarrVersion: 3,
  spatialDimensions: { lat: 'lat', lon: 'lon' },
  latIsAscending: false,
  customFrag: `
    float r = band_0 / 255.0;
    float g = band_1 / 255.0;
    float b = band_2 / 255.0;
    float a = band_3 / 255.0;
    fragColor = vec4(r, g, b, a * opacity);
    fragColor.rgb *= fragColor.a;
  `,
})
```

### How zarr-layer Geolocates Tiles

1. **Bounds → xyLimits**: `[west, south, east, north]` is unpacked as
   `{xMin: west, xMax: east, yMin: south, yMax: north}`.

2. **Multiscale parsing**: The `layout` format is parsed by
   `_parseUntiledMultiscale`, which reads array shapes from consolidated
   metadata. This puts the layer in **UntiledMode** (arbitrary chunk
   grids, as opposed to TiledMode for power-of-2 tile grids).

3. **Level selection**: `selectLevelForZoom` picks the pyramid level
   whose pixel resolution best matches the current map zoom.

4. **Region bounds**: For each visible chunk at rows `[r1, r2]` and
   columns `[c1, c2]`, `getRegionBounds` maps pixel coordinates to
   geographic coordinates via linear interpolation:

   ```
   geoXMin = xMin + (c1 / width) * (xMax - xMin)
   geoYMax = yMax - (r1 / height) * (yMax - yMin)   // latIsAscending=false
   ```

5. **Mercator projection**: Geographic bounds are converted to Web
   Mercator normalised coordinates for GPU rendering.

6. **Fragment shader**: The custom GLSL reads the 4 band values as
   `band_0` through `band_3`, normalises from [0,255] to [0,1], and
   outputs premultiplied-alpha RGBA.

### Key Options

| Option | Value | Why |
|--------|-------|-----|
| `bounds` | `[W,S,E,N]` from zarr metadata | Avoids loading huge lat/lon coordinate arrays |
| `latIsAscending` | `false` | Row 0 = north (matches the Affine transform) |
| `zarrVersion` | `3` | Store uses Zarr v3 format |
| `selector.band` | `[0,1,2,3]` | Selects RGBA; requires `band` coordinate arrays in store |
| `spatialDimensions` | `{lat:'lat', lon:'lon'}` | Maps dimension names to spatial axes |

## 5. Data Flow Diagram

```
utm30_2025.zarr ─┐
utm31_2025.zarr ─┤ build_global_preview()
utm32_2025.zarr ─┤   UTM→WGS84 reproject
utm29_2025.zarr ─┘   pyramid coarsen
                      │
                      ▼
              global_rgb_2025.zarr
              (Zarr v3, EPSG:4326, 7 levels)
                      │
                      │ hosted at dl2.geotessera.org/zarr/v0/
                      ▼
              catalog.json (STAC)
                      │
                      │ loadCatalog() in stac.ts
                      │   fetch zarr.json, read spatial:bbox
                      ▼
              {globalPreviewUrl, globalBounds}
                      │
                      │ ZarrTesseraSource → addPreviewLayer()
                      ▼
              @carbonplan/zarr-layer (ZarrLayer)
                      │
                      │ UntiledMode: fetch chunks, map to geo bounds
                      │ WebGL: custom RGBA fragment shader
                      ▼
              MapLibre GL map (Web Mercator)
```

## 6. Common Pitfalls

**Bounds mismatch**: If `spatial:bbox` doesn't match the array
dimensions, tiles render at the wrong location. Always verify
`ceil(lon_extent / resolution) == array_width`.

**Year mixing**: Zone stores for different years have different
geographic extents. The global store filename encodes the year; only
zone stores for that year should contribute to bounds.

**Missing band arrays**: `@carbonplan/zarr-layer` derives coordinate
keys from `Object.keys(selector)`. With `selector: {band: [0,1,2,3]}`,
it expects a `band` coordinate array at each pyramid level. Without
them, initialisation fails with 404 errors.

**latIsAscending**: The global store has row 0 = north (standard
geographic raster convention). If `latIsAscending` is not set to
`false`, zarr-layer defaults to `true` and flips the image.
