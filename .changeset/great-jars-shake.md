---
"viewer": patch
---

Fix the dev-server crash on component style blocks, and point v1.1 at source.coop

`pnpm dev` could fail with `Invalid declaration: onMount` from
`@tailwindcss/vite`, naming a component whose `<style>` block is perfectly
valid CSS. The browser was requesting a component's extracted style
sub-module (`Foo.svelte?svelte&type=style&lang.css`) before
vite-plugin-svelte had compiled its parent; with nothing cached for that
sub-module Vite fell back to reading the raw `.svelte` file off disk and
handed the whole thing — `<script>` included — to Tailwind, which parsed it
as CSS. Enabling `server.warmup.clientFiles` pre-transforms components at
startup so the parent is always compiled first. Verified against every
style-bearing component: all fail cold without warmup, all pass with it.

The v1.1 dataset now reads from `data.source.coop/tessera/tessera/zarr/v1.1`
instead of the interim S3 bucket. It carries the same 60 UTM zones as v1.0,
so its selector entry is relabelled from "Cambridge" to "global". It ships no
`global_rgb` pyramid yet, so it renders through the per-chunk embedding path
rather than the preview layer.
