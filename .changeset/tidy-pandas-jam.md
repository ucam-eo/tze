---
"@ucam-eo/tessera": minor
---

Retry transient network failures, and expose what the network is doing

Browsers under connection pressure drop requests nobody asked to cancel:
Safari reports `TypeError: Load failed` (logging "The network connection was
lost") when it tears down a connection with requests still on it. A single
re-attempt turns most of those into a rendered tile.

The new `withRetry` store extension re-attempts failed reads twice, waiting
~250 ms then ~1 s, each randomised by ±25% so a batch of tiles that failed
together does not re-fire in lockstep. Only transient conditions qualify —
`TypeError` from `fetch`, and HTTP 5xx as reported by zarrita's
`Unexpected response status`. Aborts are left alone (the caller got what it
asked for), 4xx is not retried, and a 404 never reaches the retry path since
`FetchStore` resolves missing keys as `undefined` — that is how a sparse
store signals an empty chunk. Backoff is abort-aware: a caller that cancels
mid-wait rejects immediately rather than sleeping out the delay.

`withRetry` is applied innermost in `openStore`, `TesseraTileRenderer` and
the `zarr://` MapLibre protocol, so the single shared fetch behind a
coalesced group is what retries — one re-attempt serves every reader waiting
on it, instead of each reader retrying its own copy.

The extension also maintains a process-wide activity signal, exported as
`onNetworkActivity(listener)` and `getNetworkActivity()`. It reports
`{ inflight, retrying }` across every store, throttled to at most one update
per 80 ms so a burst of tile requests produces a handful of notifications
rather than hundreds — and so a request that settles within a microtask
never registers at all.
