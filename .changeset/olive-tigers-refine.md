---
"@ucam-eo/tessera-tasks": minor
"viewer": minor
---

Show what each matryoshka depth adds, and move the depth-vs-similarity check to the Similarity tool

The explorer's depth panel showed the same RGB preview three times, once per
depth, each labelled "identical" against an unnamed referent. It was identical
by construction — the preview reads only bands 0–2, which every depth stores
byte-for-byte the same — so the row asserted a certainty and taught nothing.

It now shows refinement instead. One preview, since no depth changes the
picture, then two rows: the detail each depth *adds* over the one below it
(per-pixel length of just that block of dimensions, via the new
`blockNormMap`), and the scene structure each depth resolves cumulatively.
Measured over Madrid at 2024, the first 4 dimensions vary 5.1× across the
window, the 12 that d16 adds vary 2.7×, and the 112 that d128 adds only 1.3×.
The deep dimensions are large but nearly flat across the scene, which is why
truncating them costs so much less than their share of the vector suggests —
prefix energy is only 6.5% at d4 and 18.8% at d16, yet the deviance map
already correlates r=0.64 and r=0.88 with the full-depth one.

Per-read wall-clock is no longer displayed. Reads run in sequence, so the first
pays connection setup and the last benefits from a warm connection and a warm
CDN — d128 routinely timed faster than d4, which invited exactly the wrong
conclusion. Decoded bytes are exact and are what the panel now reports.

The similarity comparison moves out of the explorer into the Similarity tool,
where a similarity search actually happens. After each search it reruns the
same reference at every shallower depth and reports how much of the full-depth
top-100 each one still surfaces. This costs no extra bandwidth: the loaded
embeddings already contain the shallow vectors, so truncating the reference is
all it takes. Over a Madrid window that reads 3% at d4 and 39% at d16 —
identical pictures, very different search results.
