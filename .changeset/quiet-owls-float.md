---
"viewer": minor
---

Open the shard inspector as a floating window, and drop the cursor fingerprint

Clicking a tile in Explorer mode now opens a draggable window over the map
holding everything about that shard — identity, CRS, provenance, tile stats,
the embedding fingerprint, year availability, temporal comparison, and the
matryoshka depth rows. The sidebar's 240px column could not show a
three-column depth grid; the window can, and it sits beside the tile it
describes rather than across the screen from it. Position survives close and
reopen, and is clamped back into view on resize.

The window pins to the clicked shard. `explorerHover` follows hover-dwell as
well as clicks, so a window bound to it would re-read every embedding depth
while panning; a new `explorerPinned` store is written only by the click
handler. Dwell still outlines tiles on the map and feeds the per-pixel
readout, which is now gated to the pinned shard so it cannot show a pixel
belonging to a different tile.

Everything for the shard loads on that click, the depth comparison included —
its "Compare depths" button is gone. Stores declaring a single depth skip the
read entirely.

The radial embedding fingerprint that tracked the cursor is removed, along
with its animation loop, loading state, and the effect that re-triggered it
when tile data arrived. The fingerprint canvas inside the inspector is a
different element and stays.
