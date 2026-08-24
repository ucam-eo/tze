---
"viewer": patch
---

Show live network activity on the dataset status dot

The dot beside the dataset version reported catalog status only, so there was
no sign of what the network was doing afterwards — including the retries now
happening under a flaky connection. It is now a small state machine over
catalog status and `onNetworkActivity` from `@ucam-eo/tessera`, where a hard
failure outranks a retry, which outranks routine traffic:

| state | colour | animation |
| --- | --- | --- |
| catalog unavailable | red | steady |
| retrying after a network drop | amber | pulse |
| requests in flight | cyan | pulse |
| idle | green | steady |

Only the colour and a soft opacity pulse change — the dot keeps its size and
position, so sustained tile loading stays quiet at the edge of vision. The
button tooltip names the state and the count ("Retrying 3 requests —
connection unstable"). The pulse is disabled under
`prefers-reduced-motion: reduce`.

The tile counter beside the version label is now an overlay rather than an
inline span. It used to appear and disappear inside the button, widening it
mid-load and reflowing the whole top bar; it now floats below the button,
absolutely positioned and `pointer-events-none`, so the bar keeps its layout
whether or not a load is running. It carries a hairline progress fill to match
the existing ROI progress bar, and is suppressed while a dropdown is open
since both anchor to `top-full`.

Nothing previously cleared that count — `loading` had a single writer and no
reset, so it stuck at `40/40` after a load finished, stranded at `12/40` when
a region was aborted mid-flight, and survived a dataset switch. Progress now
goes through `reportLoading()`/`clearLoading()`, which hide the indicator
~600 ms after it completes, after ~2 s with no progress for a load that
stopped short, and immediately on a dataset or year switch.
