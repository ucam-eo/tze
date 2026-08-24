/**
 * Load the same tiles at d16 and at d128 and confirm the shallow values are
 * exactly the prefix of the deep ones, pixel by pixel.
 *
 * This is the check unit tests cannot make: a misplaced offset in the scatter
 * path yields plausible-looking but wrong embeddings, which would surface as
 * quietly wrong analysis rather than a failure.
 *
 * Reads the built package, so build first:
 *   pnpm -F @ucam-eo/tessera build && node scripts/verify-depth-load.mjs
 */
import { TesseraSource } from '../packages/tessera/dist/index.js';

/** Count what actually crosses the network, so the saving is measured. */
const wire = { requests: 0, heads: 0, bytes: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const resp = await realFetch(input, init);
  // A HEAD reports the whole file's Content-Length but transfers no body:
  // zarrita uses one per shard to locate the index. Counting it would
  // massively overstate the transfer.
  const method = (typeof input === 'string' ? init?.method : input?.method) ?? 'GET';
  if (method === 'HEAD') wire.heads++;
  else {
    wire.requests++;
    wire.bytes += Number(resp.headers.get('content-length') ?? 0);
  }
  return resp;
};
const measure = () => { const m = { ...wire }; wire.requests = 0; wire.bytes = 0; return m; };

const URL = 'https://data.source.coop/tessera/tessera/zarr/v2-2B-L~beta1/utm30';

const src = new TesseraSource({ url: URL });
await src.open();
src.setTimeIndex(src.metadata.years.indexOf(2024));

// A 4x4 block of tiles over Madrid: spans several d16 chunks, so the grouping
// and the scatter both get exercised.
const tiles = [];
for (let ci = 7124; ci < 7128; ci++) for (let cj = 848; cj < 852; cj++) tiles.push({ ci, cj });

const t16 = Date.now();
await src.loadChunks(tiles, { depth: 16 });
const shallow = src.embeddingRegion;
const d16 = {
  emb: shallow.emb.slice(),
  nBands: shallow.nBands,
  loaded: shallow.loaded.slice(),
};
const w16 = measure();
console.log(`d16:  nBands ${d16.nBands}, ${[...d16.loaded].filter(Boolean).length}/${tiles.length} tiles, ${Date.now() - t16} ms, ${w16.requests} reads + ${w16.heads} HEAD, ${(w16.bytes / 1024).toFixed(0)} KB`);

const t128 = Date.now();
await src.loadChunks(tiles, { depth: 128 });
const full = src.embeddingRegion;
const w128 = measure();
console.log(`d128: nBands ${full.nBands}, ${[...full.loaded].filter(Boolean).length}/${tiles.length} tiles, ${Date.now() - t128} ms, ${w128.requests} reads + ${w128.heads} HEAD, ${(w128.bytes / 1024).toFixed(0)} KB`);
console.log(`d16 moved ${(w128.bytes / w16.bytes).toFixed(1)}x less data over the wire`);

if (full.emb.length === d16.emb.length) {
  console.error('FAIL: the region was not reallocated for the new depth');
  process.exit(1);
}

const tilePixels = full.tileW * full.tileH;
let compared = 0, mismatched = 0, validPixels = 0;
for (let t = 0; t < full.loaded.length; t++) {
  if (!full.loaded[t] || !d16.loaded[t]) continue;
  for (let p = 0; p < tilePixels; p++) {
    const deep = (t * tilePixels + p) * full.nBands;
    const shal = (t * tilePixels + p) * d16.nBands;
    if (Number.isNaN(full.emb[deep])) {
      if (!Number.isNaN(d16.emb[shal])) mismatched++;   // nodata must agree too
      continue;
    }
    validPixels++;
    for (let b = 0; b < d16.nBands; b++) {
      compared++;
      if (full.emb[deep + b] !== d16.emb[shal + b]) mismatched++;
    }
  }
}

console.log(`${validPixels} valid pixels, ${compared - mismatched}/${compared} values identical`);
if (mismatched > 0) {
  console.error('FAIL: d16 is not the prefix of d128 — scatter bug');
  process.exit(1);
}
console.log('OK: d16 load is exactly the d128 prefix');
