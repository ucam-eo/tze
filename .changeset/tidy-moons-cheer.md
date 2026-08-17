---
"@ucam-eo/maplibre-tessera": minor
"@ucam-eo/tessera": minor
---

Move to upstream zarrita 0.7 and drop the `avsm/zarrita.js` fork

The fork existed to carry an HTTP range-coalescing store and a couple of
browser-safety fixes. Upstream v0.7 ships `withRangeCoalescing` (a better
version of the same idea, with signal merging and an `onFlush` hook) and
reorganised its barrel so `FileSystemStore` no longer reaches browser
bundles, so the fork no longer earns its keep. `zarrita` is now a plain
npm dependency.

- `new zarr.CoalescingStore(store)` is replaced by
  `await zarr.extendStore(store, zarr.withRangeCoalescing)`.
- `fetchRegion()` swaps its `onProgress` option for `signal`, and
  `TesseraSource` now forwards its abort signal into the underlying fetches
  so cancelled region loads release their connections instead of being
  discarded after the fact.
- **Breaking**: `EmbeddingProgress` drops `bytesLoaded`, `chunksCompleted`,
  and `chunksTotal`. These came from a fork-only progress callback with no
  upstream equivalent; `stage` and `bytes` are unchanged. Byte-level
  progress can be reintroduced without a fork via a `defineStoreExtension`
  wrapper or a custom `fetch` handler on `FetchStore`.
