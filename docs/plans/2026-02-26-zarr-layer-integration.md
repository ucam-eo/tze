# Zarr-Layer Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace custom tile protocol rendering with @carbonplan/zarr-layer's GPU-accelerated UntiledMode, consuming a global EPSG:4326 preview zarr store.

**Architecture:** Two-repo change. In geotessera: new `global-preview` CLI command reprojects per-zone UTM `rgb` arrays into a single global WGS84 zarr store with zarr-conventions/multiscales levels. In tze: revert to 9a265a2, add zarr-layer as dependency, replace the custom MapLibre protocol + canvas + PNG pipeline with a single ZarrLayer custom layer instance.

**Tech Stack:** Python (xarray, rioxarray, zarr v3, pyproj) for server-side; TypeScript, Svelte 5, MapLibre GL 4.7, @carbonplan/zarr-layer for client-side.

---

## Part 1: Server Side (geotessera)

Working directory: `~/src/git/ucam-eo/geotessera`

### Task 1: Add `global-preview` command skeleton

**Files:**
- Modify: `geotessera/registry_cli.py` (add subcommand parser + handler)
- Modify: `geotessera/zarr_zone.py` (add `build_global_preview()` function)

**Step 1: Add CLI subcommand parser**

In `registry_cli.py`, after the existing `zarr-build` parser block (~line 3471), add:

```python
global_preview_parser = subparsers.add_parser(
    "global-preview",
    help="Build global EPSG:4326 preview store from per-zone UTM stores",
)
global_preview_parser.add_argument(
    "zarr_dir",
    type=Path,
    help="Directory containing utm*_YYYY.zarr stores",
)
global_preview_parser.add_argument(
    "--output",
    type=Path,
    required=True,
    help="Output path for global preview store (e.g. global_rgb_2025.zarr)",
)
global_preview_parser.add_argument(
    "--year",
    type=int,
    default=2025,
    help="Year to process (default: 2025)",
)
global_preview_parser.add_argument(
    "--zones",
    type=str,
    default=None,
    help="Comma-separated UTM zones to include (default: all)",
)
global_preview_parser.add_argument(
    "--levels",
    type=int,
    default=7,
    help="Number of multiscale levels (default: 7)",
)
global_preview_parser.add_argument(
    "--preview",
    type=str,
    default="rgb",
    choices=["rgb", "pca_rgb", "both"],
    help="Which preview arrays to include (default: rgb)",
)
global_preview_parser.set_defaults(func=global_preview_command)
```

**Step 2: Add command handler stub**

```python
def global_preview_command(args):
    """Build global EPSG:4326 preview store from per-zone UTM stores."""
    from geotessera.zarr_zone import build_global_preview
    from rich.console import Console

    console = Console()
    zones = [int(z) for z in args.zones.split(",")] if args.zones else None
    previews = ["rgb", "pca_rgb"] if args.preview == "both" else [args.preview]

    build_global_preview(
        zarr_dir=args.zarr_dir,
        output_path=args.output,
        year=args.year,
        zones=zones,
        num_levels=args.levels,
        preview_names=previews,
        console=console,
    )
```

**Step 3: Add function stub in zarr_zone.py**

At the end of `zarr_zone.py`:

```python
def build_global_preview(
    zarr_dir: Path,
    output_path: Path,
    year: int,
    zones: Optional[List[int]] = None,
    num_levels: int = 7,
    preview_names: Optional[List[str]] = None,
    console: Optional["rich.console.Console"] = None,
) -> Path:
    """Build global EPSG:4326 preview store from per-zone UTM stores.

    Reprojects each zone's rgb (and/or pca_rgb) array from UTM to WGS84,
    writes into a single global zarr store with zarr-conventions/multiscales
    metadata for use with @carbonplan/zarr-layer.
    """
    raise NotImplementedError("global-preview not yet implemented")
```

**Step 4: Verify CLI wiring**

Run: `cd ~/src/git/ucam-eo/geotessera && python -m geotessera.registry_cli global-preview --help`
Expected: Shows help text with zarr_dir, --output, --year, --zones, --levels, --preview arguments.

**Step 5: Commit**

```bash
git add geotessera/registry_cli.py geotessera/zarr_zone.py
git commit -m "feat: add global-preview command skeleton"
```

---

### Task 2: Discover zone stores and compute global extent

**Files:**
- Modify: `geotessera/zarr_zone.py` (fill in `build_global_preview()`)

**Step 1: Implement zone discovery and extent computation**

Replace the stub with:

```python
def build_global_preview(
    zarr_dir: Path,
    output_path: Path,
    year: int,
    zones: Optional[List[int]] = None,
    num_levels: int = 7,
    preview_names: Optional[List[str]] = None,
    console: Optional["rich.console.Console"] = None,
) -> Path:
    """Build global EPSG:4326 preview store from per-zone UTM stores."""
    import re
    import zarr as zarr_lib
    from pyproj import Transformer

    if preview_names is None:
        preview_names = ["rgb"]
    if console is None:
        from rich.console import Console
        console = Console()

    # 1. Discover zone stores
    pattern = re.compile(rf"^utm(\d{{2}})_{year}\.zarr$")
    zone_stores = {}
    for p in sorted(zarr_dir.iterdir()):
        m = pattern.match(p.name)
        if m and p.is_dir():
            zone_num = int(m.group(1))
            if zones is None or zone_num in zones:
                zone_stores[zone_num] = p

    if not zone_stores:
        console.print(f"[red]No zone stores found in {zarr_dir} for year {year}")
        return output_path

    console.print(f"Found {len(zone_stores)} zone stores: {sorted(zone_stores.keys())}")

    # 2. Compute global WGS84 bounding box
    global_west, global_south = 180.0, 90.0
    global_east, global_north = -180.0, -90.0

    zone_infos = {}
    for zone_num, store_path in sorted(zone_stores.items()):
        store = zarr_lib.open_group(str(store_path), mode="r")
        attrs = dict(store.attrs)
        epsg = attrs["crs_epsg"]
        transform = attrs["transform"]
        pixel_size = transform[0]
        origin_e = transform[2]
        origin_n = transform[5]

        # Get array shape for each preview
        for pname in preview_names:
            if pname not in store:
                continue
            h, w = store[pname].shape[:2]

            # Compute UTM corner coordinates
            utm_west = origin_e
            utm_east = origin_e + w * pixel_size
            utm_north = origin_n
            utm_south = origin_n - h * pixel_size

            # Reproject corners to WGS84
            transformer = Transformer.from_crs(
                f"EPSG:{epsg}", "EPSG:4326", always_xy=True
            )
            xs = [utm_west, utm_east, utm_east, utm_west]
            ys = [utm_south, utm_south, utm_north, utm_north]
            lons, lats = transformer.transform(xs, ys)

            west, east = min(lons), max(lons)
            south, north = min(lats), max(lats)

            global_west = min(global_west, west)
            global_east = max(global_east, east)
            global_south = min(global_south, south)
            global_north = max(global_north, north)

            zone_infos[zone_num] = {
                "store_path": store_path,
                "epsg": epsg,
                "transform": transform,
                "previews": {pname: (h, w) for pname in preview_names if pname in store},
            }

    console.print(
        f"Global extent: W={global_west:.4f} S={global_south:.4f} "
        f"E={global_east:.4f} N={global_north:.4f}"
    )

    # 3. Compute finest resolution (degrees per pixel)
    #    10m at equator ≈ 0.0000898° lat, ~0.0001° lon
    #    Use ~0.0001° as base resolution
    base_res = 0.0001  # degrees per pixel at finest level

    # 4. Compute global array dimensions at finest level
    global_width = int(math.ceil((global_east - global_west) / base_res))
    global_height = int(math.ceil((global_north - global_south) / base_res))

    console.print(
        f"Level 0 dimensions: {global_height} x {global_width} "
        f"(res={base_res}°, ~{base_res * 111_000:.1f}m)"
    )

    # Continue to store creation and reprojection...
    _write_global_store(
        output_path=output_path,
        zone_infos=zone_infos,
        preview_names=preview_names,
        global_bounds=(global_west, global_south, global_east, global_north),
        base_res=base_res,
        num_levels=num_levels,
        console=console,
    )

    return output_path
```

**Step 2: Verify discovery works**

Run: `cd ~/src/git/ucam-eo/geotessera && python -c "from geotessera.zarr_zone import build_global_preview; print('import ok')"`
Expected: `import ok`

**Step 3: Commit**

```bash
git add geotessera/zarr_zone.py
git commit -m "feat: zone discovery and global extent computation"
```

---

### Task 3: Create global store and reproject zones into it

**Files:**
- Modify: `geotessera/zarr_zone.py` (add `_write_global_store()`)

**Step 1: Implement store creation and per-zone reprojection**

```python
def _write_global_store(
    output_path: Path,
    zone_infos: dict,
    preview_names: List[str],
    global_bounds: Tuple[float, float, float, float],
    base_res: float,
    num_levels: int,
    console: "rich.console.Console",
) -> None:
    """Create global 4326 zarr store and reproject each zone into it."""
    import zarr as zarr_lib
    import numpy as np
    import xarray as xr
    import rioxarray  # noqa: F401
    from rasterio.enums import Resampling
    from affine import Affine

    west, south, east, north = global_bounds
    chunk_size = 512

    # Create output store
    root = zarr_lib.open_group(str(output_path), mode="w", zarr_format=3)

    # Build each level
    level_metas = []
    for level in range(num_levels):
        scale_factor = 2 ** level
        level_res = base_res * scale_factor
        level_w = int(math.ceil((east - west) / level_res))
        level_h = int(math.ceil((north - south) / level_res))

        console.print(
            f"Level {level}: {level_h} x {level_w} "
            f"(res={level_res:.6f}°, scale={scale_factor}x)"
        )

        level_metas.append({
            "asset": str(level),
            "transform": {
                "scale": [level_res, level_res],
                "translation": [west, south],
            },
        })

        # Create level group
        level_group = root.require_group(str(level))

        for pname in preview_names:
            # Create array for this preview at this level
            arr = level_group.create_array(
                pname,
                shape=(level_h, level_w, 4),
                chunks=(chunk_size, chunk_size, 4),
                dtype=np.uint8,
                fill_value=0,
            )
            arr.attrs["_ARRAY_DIMENSIONS"] = ["lat", "lon", "band"]

            # Reproject each zone into this level
            for zone_num, zinfo in sorted(zone_infos.items()):
                if pname not in zinfo["previews"]:
                    continue

                console.print(
                    f"  Reprojecting zone {zone_num} {pname} into level {level}..."
                )

                # Open zone's preview as georeferenced xarray
                zone_store = zarr_lib.open_group(
                    str(zinfo["store_path"]), mode="r"
                )
                src_da = _utm_array_to_xarray(zone_store, pname)

                # Target transform for this level
                dst_transform = Affine(
                    level_res, 0, west,
                    0, -level_res, north,
                )

                # Reproject to EPSG:4326
                reprojected = src_da.rio.reproject(
                    "EPSG:4326",
                    resampling=Resampling.average,
                    shape=(4, level_h, level_w),
                    transform=dst_transform,
                    nodata=0,
                )

                # Convert (band, y, x) -> (y, x, band) and write
                data = reprojected.values  # (4, H, W)
                data = np.nan_to_num(data, nan=0.0)
                data = np.clip(data, 0, 255).astype(np.uint8)
                data = np.transpose(data, (1, 2, 0))  # (H, W, 4)

                # Find non-zero region to avoid writing empty chunks
                mask = data.any(axis=2)
                rows = np.any(mask, axis=1)
                cols = np.any(mask, axis=0)
                if not rows.any():
                    continue

                r_min, r_max = np.where(rows)[0][[0, -1]]
                c_min, c_max = np.where(cols)[0][[0, -1]]

                # Snap to chunk boundaries for efficient writes
                r_min = (r_min // chunk_size) * chunk_size
                c_min = (c_min // chunk_size) * chunk_size
                r_max = min(((r_max // chunk_size) + 1) * chunk_size, level_h)
                c_max = min(((c_max // chunk_size) + 1) * chunk_size, level_w)

                arr[r_min:r_max, c_min:c_max, :] = data[r_min:r_max, c_min:c_max, :]

    # Write multiscales metadata
    root.attrs.update({
        "multiscales": {
            "layout": level_metas,
            "resampling_method": "average",
            "crs": "EPSG:4326",
        },
    })

    console.print(f"[green]Global preview store written to {output_path}")
```

**Step 2: Test with a single zone**

Run:
```bash
cd ~/src/git/ucam-eo/geotessera
python -m geotessera.registry_cli global-preview \
    /path/to/zarr/v0/ \
    --output /tmp/test_global_rgb.zarr \
    --year 2025 \
    --zones 31 \
    --levels 3
```
Expected: Creates store with 3 levels, prints extent and level dimensions.

**Step 3: Verify store structure**

```bash
python -c "
import zarr
store = zarr.open_group('/tmp/test_global_rgb.zarr', mode='r')
print('attrs:', dict(store.attrs))
for level in ['0', '1', '2']:
    arr = store[level]['rgb']
    print(f'level {level}: shape={arr.shape}, chunks={arr.chunks}')
"
```

**Step 4: Commit**

```bash
git add geotessera/zarr_zone.py
git commit -m "feat: global 4326 store creation with per-zone reprojection"
```

---

### Task 4: Optimize with chunked reprojection

The naive approach reprojects the entire zone array at full global dimensions
for each level, which uses too much memory. Refactor to process in strips.

**Files:**
- Modify: `geotessera/zarr_zone.py` (refactor `_write_global_store()`)

**Step 1: Replace full-array reprojection with strip-based processing**

Instead of reprojecting to the full (level_h × level_w) target at once,
process in lat strips of ~2048 rows. For each strip:

```python
# In _write_global_store, replace the per-zone reprojection block:

strip_height = 2048  # rows per strip
for strip_start in range(0, level_h, strip_height):
    strip_end = min(strip_start + strip_height, level_h)
    strip_h = strip_end - strip_start

    # Compute lat bounds for this strip
    strip_north = north - strip_start * level_res
    strip_south = north - strip_end * level_res

    strip_transform = Affine(
        level_res, 0, west,
        0, -level_res, strip_north,
    )

    # Reproject zone into strip
    reprojected = src_da.rio.reproject(
        "EPSG:4326",
        resampling=Resampling.average,
        shape=(4, strip_h, level_w),
        transform=strip_transform,
        nodata=0,
    )

    data = reprojected.values
    data = np.nan_to_num(data, nan=0.0)
    data = np.clip(data, 0, 255).astype(np.uint8)
    data = np.transpose(data, (1, 2, 0))

    # Only write non-empty chunks
    mask = data.any(axis=2)
    if not mask.any():
        continue

    cols = np.any(mask, axis=0)
    c_min, c_max = np.where(cols)[0][[0, -1]]
    c_min = (c_min // chunk_size) * chunk_size
    c_max = min(((c_max // chunk_size) + 1) * chunk_size, level_w)

    arr[strip_start:strip_end, c_min:c_max, :] = data[:, c_min:c_max, :]
```

**Step 2: For coarser levels, coarsen the source first**

Before reprojecting at coarser levels, downsample the source array to
reduce work. Add before the strip loop:

```python
if level > 0:
    coarsen_factor = min(scale_factor, 8)  # cap to avoid tiny arrays
    if coarsen_factor > 1:
        src_coarsened = src_da.coarsen(
            y=coarsen_factor, x=coarsen_factor, boundary="trim"
        ).mean()
        # Reattach CRS (coarsen drops it)
        src_coarsened = src_coarsened.rio.write_crs(src_da.rio.crs)
        src_coarsened = src_coarsened.rio.write_transform(
            src_da.rio.transform() * Affine.scale(coarsen_factor)
        )
        src_for_level = src_coarsened
    else:
        src_for_level = src_da
else:
    src_for_level = src_da
```

**Step 3: Test memory usage**

Run on a single zone and verify peak memory stays under ~4 GB:
```bash
/usr/bin/time -l python -m geotessera.registry_cli global-preview \
    /path/to/zarr/v0/ --output /tmp/test_global_rgb.zarr \
    --year 2025 --zones 31 --levels 5
```

**Step 4: Commit**

```bash
git add geotessera/zarr_zone.py
git commit -m "feat: chunked strip reprojection for memory efficiency"
```

---

## Part 2: Client Side (tze)

Working directory: `~/src/git/ucam-eo/tze`

### Task 5: Revert to 9a265a2

**Step 1: Revert the 4 post-target commits**

```bash
cd ~/src/git/ucam-eo/tze
git revert --no-commit 9a532ec 3f23a5c 51ded31 a0935af
git commit -m "revert: remove mercator pyramid tile handling

Revert commits 9a532ec, 3f23a5c, 51ded31, a0935af to return to the
STAC catalog integration baseline (9a265a2) before adding zarr-layer."
```

**Step 2: Verify build**

Run: `pnpm build`
Expected: Clean build with no errors.

**Step 3: Verify dev server starts**

Run: `pnpm dev`
Expected: Vite dev server starts on port 5173.

---

### Task 6: Add @carbonplan/zarr-layer dependency

**Files:**
- Modify: `packages/maplibre-zarr-tessera/package.json`
- Modify: `apps/viewer/package.json` (if needed)

**Step 1: Install zarr-layer**

```bash
cd ~/src/git/ucam-eo/tze
pnpm add @carbonplan/zarr-layer --filter @ucam-eo/maplibre-zarr-tessera
```

**Step 2: Verify import works**

```bash
cd packages/maplibre-zarr-tessera
node -e "import('@carbonplan/zarr-layer').then(m => console.log('ok', Object.keys(m)))"
```

**Step 3: Commit**

```bash
git add packages/maplibre-zarr-tessera/package.json pnpm-lock.yaml
git commit -m "deps: add @carbonplan/zarr-layer"
```

---

### Task 7: Add ZarrLayer preview to ZarrTesseraSource

This is the core integration. Replace the custom protocol tile handler
with a ZarrLayer instance for the RGB/PCA preview.

**Files:**
- Modify: `packages/maplibre-zarr-tessera/src/zarr-source.ts`
- Modify: `packages/maplibre-zarr-tessera/src/types.ts`

**Step 1: Add ZarrLayer import and preview field**

In `zarr-source.ts`, add import:

```typescript
import { ZarrLayer } from '@carbonplan/zarr-layer';
```

Add field to the class:

```typescript
private previewLayer: ZarrLayer | null = null;
```

Add to `ZarrTesseraOptions` in `types.ts`:

```typescript
/** URL for the global 4326 preview store (used by zarr-layer) */
globalPreviewUrl?: string;
```

**Step 2: Create preview layer in addTo()**

After `this.emit('metadata-loaded', ...)` in `addTo()`, add:

```typescript
// Add zarr-layer preview if global preview URL is configured
if (this.opts.globalPreviewUrl) {
    this.addPreviewLayer();
}
```

Add the method:

```typescript
private addPreviewLayer(): void {
    if (!this.map || !this.opts.globalPreviewUrl) return;

    const previewVar = this.opts.preview === 'pca' ? 'pca_rgb' : 'rgb';

    this.previewLayer = new ZarrLayer({
        id: `zarr-preview-${this.instanceId}`,
        source: this.opts.globalPreviewUrl,
        variable: previewVar,
        selector: { band: [0, 1, 2, 3] },
        clim: [0, 255],
        colormap: ['#000000', '#ffffff'],
        customFrag: `
            float r = band_0 / 255.0;
            float g = band_1 / 255.0;
            float b = band_2 / 255.0;
            float a = band_3 / 255.0;
            fragColor = vec4(r, g, b, a * opacity);
            fragColor.rgb *= fragColor.a;
        `,
        opacity: this.opts.opacity,
        zarrVersion: 3,
        spatialDimensions: { lat: 'lat', lon: 'lon' },
    });

    this.map.addLayer(this.previewLayer);
    this.debug('info', `Preview layer added via zarr-layer (${previewVar})`);
}
```

**Step 3: Remove preview layer in remove()**

In the `remove()` method, before existing cleanup:

```typescript
if (this.previewLayer && this.map) {
    this.map.removeLayer(this.previewLayer.id);
    this.previewLayer = null;
}
```

**Step 4: Wire up opacity changes**

In `setOpacity()`:

```typescript
if (this.previewLayer) {
    this.previewLayer.setOpacity(opacity);
}
```

**Step 5: Wire up preview mode switching**

In `setPreview()`:

```typescript
if (this.previewLayer && this.map && this.opts.globalPreviewUrl) {
    const newVar = mode === 'pca' ? 'pca_rgb' : 'rgb';
    this.previewLayer.setVariable(newVar);
}
```

**Step 6: Build and verify**

Run: `pnpm build`
Expected: Clean build.

**Step 7: Commit**

```bash
git add packages/maplibre-zarr-tessera/src/zarr-source.ts \
       packages/maplibre-zarr-tessera/src/types.ts
git commit -m "feat: integrate zarr-layer for GPU-rendered preview tiles"
```

---

### Task 8: Remove old preview chunk rendering when zarr-layer is active

**Files:**
- Modify: `packages/maplibre-zarr-tessera/src/zarr-source.ts`

**Step 1: Gate old chunk loading on zarr-layer presence**

In `updateVisibleChunks()`, add early return when zarr-layer handles preview:

```typescript
private updateVisibleChunks(): void {
    // When zarr-layer handles preview, only load chunks on double-click
    if (this.previewLayer) return;

    // ... existing chunk loading logic unchanged ...
}
```

The double-click handler (`loadFullChunk`) remains unchanged — it loads
full-resolution 128-d embeddings from the per-zone UTM store regardless.

**Step 2: Skip overlay chunk grid when zarr-layer active**

In `addOverlays()`, conditionally skip chunk grid lines when zarr-layer
is handling the preview:

```typescript
if (!this.opts.globalPreviewUrl) {
    // Only add chunk grid overlay when using legacy chunk rendering
    // ... existing chunk grid overlay code ...
}
```

**Step 3: Build and verify**

Run: `pnpm build`

**Step 4: Commit**

```bash
git add packages/maplibre-zarr-tessera/src/zarr-source.ts
git commit -m "feat: disable legacy chunk loading when zarr-layer active"
```

---

### Task 9: Update viewer to pass global preview URL

**Files:**
- Modify: `apps/viewer/src/stores/stac.ts`
- Modify: `apps/viewer/src/stores/zarr.ts`
- Modify: `apps/viewer/vite.config.ts` (proxy config if needed)

**Step 1: Add global preview URL to zone switching**

In `apps/viewer/src/stores/stac.ts`, update `switchZone()` to pass the
global preview URL when creating a new ZarrTesseraSource:

```typescript
const source = new ZarrTesseraSource({
    url: zone.zarrUrl,
    bands: get(bands),
    opacity: get(opacity),
    preview: get(preview),
    globalPreviewUrl: 'https://dl2.geotessera.org/zarr/v0/global_rgb_2025.zarr',
});
```

Alternatively, make this configurable via an environment variable or store:

```typescript
// In stores/zarr.ts, add:
export const globalPreviewUrl = writable<string>(
    'https://dl2.geotessera.org/zarr/v0/global_rgb_2025.zarr'
);
```

**Step 2: Update vite proxy if needed**

If the global preview store is served from the same origin, add a proxy
rule in `vite.config.ts`:

```typescript
proxy: {
    '/zarr': {
        target: 'https://dl2.geotessera.org',
        changeOrigin: true,
    },
},
```

(This likely already exists from the current config.)

**Step 3: Build and test**

Run: `pnpm build && pnpm dev`
Open browser, verify zarr-layer loads the global preview.

**Step 4: Commit**

```bash
git add apps/viewer/src/stores/stac.ts apps/viewer/src/stores/zarr.ts
git commit -m "feat: pass global preview URL to zarr-layer integration"
```

---

### Task 10: End-to-end testing

**Step 1: Generate test global store (geotessera)**

```bash
cd ~/src/git/ucam-eo/geotessera
python -m geotessera.registry_cli global-preview \
    /path/to/zarr/v0/ \
    --output /path/to/zarr/v0/global_rgb_2025.zarr \
    --year 2025 \
    --zones 31 \
    --levels 5
```

**Step 2: Serve locally and test viewer**

If needed, serve the zarr store locally:
```bash
cd /path/to/zarr/v0/
python -m http.server 8080 --bind 0.0.0.0
```

Update `globalPreviewUrl` to `http://localhost:8080/global_rgb_2025.zarr`
and test in the viewer.

**Step 3: Verify checklist**

- [ ] Preview tiles render at all zoom levels
- [ ] Smooth zoom transitions (zarr-layer auto-selects level)
- [ ] Panning across zone boundaries shows continuous imagery
- [ ] Opacity slider affects preview layer
- [ ] RGB ↔ PCA mode switching works
- [ ] Double-click still loads full-res embeddings from UTM store
- [ ] Similarity search still works on double-clicked chunks
- [ ] Classification still works on double-clicked chunks
- [ ] No zone-switching artifacts or flicker

**Step 4: Commit any fixes**

```bash
git commit -m "fix: end-to-end testing fixes for zarr-layer integration"
```
