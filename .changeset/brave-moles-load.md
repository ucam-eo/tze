---
"@ucam-eo/tessera": minor
"@ucam-eo/maplibre-tessera": minor
"viewer": minor
---

Load regions at a chosen embedding depth, and upgrade them on demand

Drawing a region fetched all 128 dimensions for every tile, which set both
the download and the ceiling on region size. Stores declaring `geoemb:depths`
carry byte-exact prefixes of the same vectors, so a region can now be loaded
at 16 dimensions by default and upgraded to full depth in one click.

`loadChunks({ depth })` allocates the region at that width, and a depth
differing from the live region discards and reallocates it — that single rule
is the upgrade. Reads are batched by the chunk grid of the array being read
rather than the region's tile grid: the shallow arrays are chunked coarser
(64x64 at 16-d against a 32x32 tile), so tile-at-a-time reading would decode a
whole chunk per tile and cut the saving from 8x to 2x. At full depth chunk and
tile coincide and the request pattern is unchanged.

Measured on the wire over a 16-tile region of `v2-2B-L~beta1`: 577 KB in 5
requests at d16 against 2094 KB in 25 at d128 — 3.6x less data and 5x fewer
requests. Short of the 8x the decoded-byte accounting predicts, because the
per-pixel `scales` array is depth-independent and was over half the d16
total. The memory saving is the full 8x regardless, since the region buffer is
exactly `nBands` wide.

Similarity, classification and UMAP already read `region.nBands` dynamically
and work unchanged at any depth. Segmentation cannot: its UNet declares
`in_channels: 128`, so the Segment panel now offers an upgrade instead of a
run button on a shallow region. Training labels and the similarity reference
cache their vectors, so both are re-extracted from their coordinates after an
upgrade before anything reruns. Band-mapper sliders clamp to the loaded width,
and the large-region warning is now a byte budget rather than a tile count.

Verified by `scripts/verify-depth-load.mjs`: a region loaded at d16 is
byte-identical to the d128 prefix across all 262144 compared values.
