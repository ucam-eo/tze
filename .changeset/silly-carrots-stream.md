---
"viewer": patch
---

Add the v2 beta dataset (`v2-2B-L~beta1`) to the top-bar version selector

The 2B-parameter model preview at
`data.source.coop/tessera/tessera/zarr/v2-2B-L~beta1` is surfaced as `v2b1`
in the selector and in the shareable `?store=v2b1` query param, keeping the
full release name confined to the URL.

The store is byte-compatible with the existing read path: same 60 UTM zones,
same `embeddings`/`scales`/`time` arrays, same int8 per-pixel-scale
quantisation and `[1, 128, 4096, 4096]` shards with `[1, 128, 32, 32]` inner
chunks, so no reader changes were needed. It adds `embeddings_d4`/
`embeddings_d16` truncated-depth arrays, which the viewer ignores. Unlike
v1.1 it ships a `global_rgb` multiscale pyramid with the same `multiscales.
layout` as v1.0, so the `zarr://` preview layer works at low zoom.

It covers 2017–2025 (v1.x starts at 2015) and is still being filled: 2024 is
the most complete year, while 2025 is populated only in patches. The viewer
defaults to the latest available year, so on v2b1 that may land on sparse
coverage — switch to 2024 in the year selector for a fully populated view.
