---
"@ucam-eo/tessera": minor
"@ucam-eo/maplibre-tessera": minor
"viewer": minor
---

Animate the selected shard across years, and show the depth being loaded

`fetchDepthWindow()` takes a `timeIndex`, so a window can be read for any
year rather than only the store's active one.

The explorer's detail column gains a year-by-year animation of the selected
shard, on stores that ship shallow depth arrays. Frames come from the
shallowest array: the preview reads bands 0-2, which every depth stores
identically, so a frame costs 64 KB instead of the 2 MB a full-depth read
would. Years with no shard are skipped using the existing probe rather than
fetched, and the panel says how many of the store's years actually carry
data — over Madrid in v2-2B-L~beta1 that is 2 of 9. All frames share one
colour stretch, since normalising each year to its own range makes the scene
pulse and reads as change where there is none.

Every progress indicator now names the width being fetched — the top-bar
status, the tile-progress overlay, the regions dropdown, and the on-map
loading animation, which reports it beside the tile count. Upgrading a region
to full depth shows that animation too: display sources are now resolved
before the animation starts, since startRegionAnimation is a silent no-op for
a zone whose display source does not exist yet.
