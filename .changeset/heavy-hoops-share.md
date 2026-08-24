---
"@ucam-eo/maplibre-tessera": minor
"@ucam-eo/tessera": minor
---

Share concurrent chunk reads and stop cancellation spreading between tiles

Zooming produced a burst of `The network connection was lost` failures and
`[zarr-protocol] Tile load failed: … TypeError: Load failed` for tiles nobody
had cancelled. Two independent defects, both about readers sharing a request.

**Duplicate chunk fetches.** Neighbouring map tiles overlap the same Zarr
chunk and nothing deduplicated them, so each tile issued its own request for
the same bytes — the six zoom-13 tiles from the report were measured issuing
12 HTTP requests for 4 distinct chunks. Every duplicate consumes one of the
browser's few connections to the host, and when a zoom cancels a batch of
them Safari has been observed dropping the connection out from under the
requests that were *not* cancelled. The new `withRequestCoalescing` store
extension collapses concurrent `get()` calls for one key into a single fetch;
the same six tiles now issue 4 requests.

**Cancellation that spreads.** zarrita's `withRangeCoalescing` merges its
participants' abort signals with `AbortSignal.any()`, so the shared fetch is
torn down as soon as *any* participant aborts and every co-tenant rejects
with a network error it never asked for. `@ucam-eo/tessera` now ships its own
`withRangeCoalescing` with the same batching but correct abort semantics: the
shared fetch is aborted only once every participant has aborted, and a
participant that cancels early is rejected immediately with an `AbortError`
so its caller settles at once while the fetch continues for the rest.
`withRequestCoalescing` follows the same rule. A request joined by a caller
that passed no signal is never aborted, since nothing can speak for it.

Both are applied in `openStore`, `TesseraTileRenderer` and the `zarr://`
MapLibre protocol, and are exported for downstream use.

Also fixed: `getOrOpenPyramid` in both the `zarr://` protocol and
`TesseraTileRenderer` cached the pyramid *promise* without evicting it on
rejection, so a single transient failure left a permanently dead preview
layer. Failed opens are now evicted and retried on the next tile.
