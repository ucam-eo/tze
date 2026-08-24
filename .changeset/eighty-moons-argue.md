---
"@ucam-eo/tessera": minor
"@ucam-eo/tessera-tasks": minor
"viewer": minor
---

Read matryoshka embedding depths, and compare them in the explorer

Stores may declare truncated copies of their embeddings array in
`geoemb:depths` — TESSERA v2 ships `embeddings_d4` (4-d), `embeddings_d16`
(16-d), and the full `embeddings` (128-d). The truncations are byte-exact
prefixes of the full vector sharing one `scales` array, verified against
`v2-2B-L~beta1`: every one of 65,536 values in a 128×128 window matched the
d128 prefix exactly.

`@ucam-eo/tessera` parses the attribute into `StoreMetadata.geoemb_depths` and
exposes `TesseraSource.depths` plus `fetchDepthWindow()`, which reads one pixel
window at one depth and reports the chunks and bytes it decoded. Stores without
the attribute report no depths, and the older HWB layout never has them. The
NCHW dequantise-with-transpose loop now lives in one place (`dequantiseNCHW`),
shared by chunk loading and depth reads.

`@ucam-eo/tessera-tasks` adds `depth-compare`: mean embedding, deviance and
similarity maps, Pearson correlation, top-k rank overlap, prefix difference,
and shared-range rasterisers.

The viewer's Explorer tool gains a Matryoshka panel for the selected shard.
It reads a 128×128 px window — aligned to the shallowest depth's chunk grid so
every depth reads whole chunks and the byte counts mean something — at each
depth on request, then shows three rows: the RGB preview from bands 0–2, the
deviance from the window mean, and, once a reference pixel is picked,
similarity across the window. Measured over Madrid at 2024, the RGB row is
identical at every depth for 64 KB against 2 MB, while deviance correlates
r=0.64 (d4) and r=0.88 (d16) with the full-depth map, and top-100 similarity
overlap falls to 39% (d16) and 3% (d4) — cheap to look at, costly to search.

The panel reads its own window and leaves the map's data path untouched. It
appears only for stores declaring more than one depth, and the read is on a
button rather than automatic, since the full-depth column alone costs ~2 MB.
