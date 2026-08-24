<script lang="ts">
  /**
   * What each matryoshka depth adds to the selected shard.
   *
   * Stores that ship truncated embedding arrays (`geoemb:depths`) let a reader
   * trade dimensions for bytes. Reading one window at every depth shows the
   * refinement: the shallowest read already carries most of what distinguishes
   * one pixel from another, and each further tier adds dimensions that are
   * larger in magnitude but flatter across the scene.
   *
   * Independent of the loaded embedding region — it fetches its own window and
   * leaves the map's data path alone.
   */
  import { get } from 'svelte/store';
  import { sourceManager, metadata } from '../stores/zarr';
  import { explorerPinned } from '../stores/zarr-explorer';
  import { alignDepthWindow, type DepthWindow, type DepthWindowResult } from '@ucam-eo/tessera';
  import {
    blockNormMap, bandRanges, scalarRange, rgbaFromBands, rgbaFromScalar,
  } from '@ucam-eo/tessera-tasks';

  /** Comparison window in pixels: one whole chunk at the shallowest depth. */
  const WINDOW = 128;
  const RGB_BANDS: [number, number, number] = [0, 1, 2];
  const CYAN: [number, number, number] = [0, 229, 255];

  /** The dimensions one depth adds over the depth below it. */
  interface Tier {
    label: string;
    /** Dimensions this tier contributes. */
    dims: number;
    /** Decoded cost of reading the array that first carries them. */
    bytes: number;
    /** Per-pixel structure of just those dimensions. */
    rgba: Uint8ClampedArray;
    /** Ratio of the largest to smallest block length across the window. */
    spread: number;
  }

  let tiers = $state<Tier[]>([]);
  let preview = $state<Uint8ClampedArray | null>(null);
  let win = $state<DepthWindow | null>(null);
  let loading = $state(false);
  let error = $state('');
  let gen = 0;

  const depths = $derived($metadata?.geoemb_depths?.map(d => d.dimensions) ?? []);
  const selected = $derived($explorerPinned);
  // Identity of the selected shard. Dwelling on the map rewrites the selection
  // store with an equal value, which must not discard a finished comparison.
  const selectionKey = $derived(selected ? `${selected.zoneId}:${selected.ci}_${selected.cj}` : '');
  /** Ideal cost of one full sweep: every depth over the whole window. */
  const estimate = $derived(depths.reduce((sum, d) => sum + WINDOW * WINDOW * d, 0));

  // A new shard invalidates everything measured for the old one, cancels any
  // read still in flight, and starts reading the new one. Only an explicit
  // click repins, so this never fires while panning the map.
  $effect(() => {
    // Stores with one depth have nothing to compare — don't spend a read on them.
    if (!selectionKey || depths.length < 2) return;
    void compare();
  });

  async function compare() {
    const sel = selected;
    const mgr = get(sourceManager);
    if (!sel || !mgr) return;

    const myGen = ++gen;
    loading = true;
    win = null;
    error = '';
    tiers = [];
    preview = null;

    try {
      const src = mgr.getOpenSource(sel.zoneId) ?? await mgr.getSource(sel.zoneId);
      const meta = src?.metadata;
      if (!src || !meta) throw new Error('zone is not open');
      if (myGen !== gen) return;

      const { globalRow, globalCol } = src.pixelToGlobal(sel.ci, sel.cj, 0, 0);
      const w = alignDepthWindow(globalRow, globalCol, WINDOW, meta.shape[0], meta.shape[1]);
      const pixels = w.height * w.width;

      // Every depth is read, even though the deepest one contains all the
      // others: the point is what each array costs to fetch on its own.
      const reads: { depth: number; result: DepthWindowResult }[] = [];
      for (const depth of src.depths) {
        const result = await src.fetchDepthWindow({ depth, ...w });
        if (myGen !== gen) return;
        if (result) reads.push({ depth, result });
      }
      if (reads.length < 2) throw new Error('no depth arrays readable here');

      const full = reads[reads.length - 1].result;

      // One preview: bands 0-2 are stored identically at every depth, so the
      // picture is the same whichever array it came from.
      preview = rgbaFromBands(
        full.emb, pixels, full.nBands, RGB_BANDS,
        bandRanges([{ emb: full.emb, nBands: full.nBands, nPixels: pixels }], RGB_BANDS),
      );

      // What each tier adds: the block of dimensions the depth below lacks.
      tiers = reads.map((r, i) => {
        const from = i === 0 ? 0 : reads[i - 1].depth;
        const map = blockNormMap(full.emb, pixels, full.nBands, from, r.depth);
        const range = scalarRange([map]);
        return {
          label: i === 0 ? `d${r.depth}` : `+d${r.depth}`,
          dims: r.depth - from,
          bytes: r.result.bytes,
          rgba: rgbaFromScalar(map, range.min, range.max, CYAN),
          spread: range.min > 0 ? range.max / range.min : Infinity,
        };
      });

      win = w;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      error = (err as Error).message;
    } finally {
      if (myGen === gen) loading = false;
    }
  }

  /** Draw an RGBA buffer into a canvas, redrawing whenever it changes. */
  function paint(node: HTMLCanvasElement, data: { rgba: Uint8ClampedArray; w: number; h: number }) {
    const draw = (d: typeof data) => {
      node.width = d.w;
      node.height = d.h;
      const ctx = node.getContext('2d');
      if (!ctx) return;
      const img = ctx.createImageData(d.w, d.h);
      img.data.set(d.rgba);
      ctx.putImageData(img, 0, 0);
    };
    draw(data);
    return { update: draw };
  }

  function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  const gridStyle = $derived(`grid-template-columns: repeat(${depths.length + 1}, minmax(0, 1fr))`);
</script>

{#if selected && depths.length > 1}
  <div class="bg-gray-900/80 border border-gray-800/60 rounded px-2.5 py-2 space-y-2">
    {#if loading}
      <div class="flex items-center gap-1.5 text-[9px] text-term-cyan/80">
        <span class="w-1.5 h-1.5 rounded-full bg-term-cyan/70 animate-pulse"></span>
        Reading every depth… ≈{formatBytes(estimate)}
      </div>
    {/if}

    {#if error}
      <div class="text-[9px] text-red-400/80">{error}</div>
    {/if}

    {#if tiers.length > 0 && win}
      <!-- The picture first, then the dimensions each depth adds over the one
           below it. The picture reads only bands 0-2, so no depth changes it. -->
      <div class="space-y-1">
        <div class="text-[9px] text-gray-500">Detail each depth adds</div>
        <div class="grid gap-1" style={gridStyle}>
          {#if preview}
            <div class="space-y-0.5">
              <div class="w-full aspect-square rounded overflow-hidden border border-term-cyan/30">
                <canvas
                  use:paint={{ rgba: preview, w: win.width, h: win.height }}
                  class="w-full h-full block pixelated"
                ></canvas>
              </div>
              <div class="text-[9px] text-gray-400">bands 0–2</div>
              <div class="text-[8px] text-gray-500">the preview</div>
              <div class="text-[8px] text-gray-600">any depth</div>
            </div>
          {/if}
          {#each tiers as tier (tier.label)}
            <div class="space-y-0.5">
              <div class="w-full aspect-square rounded overflow-hidden border border-gray-800/60 bg-gray-950">
                <canvas
                  use:paint={{ rgba: tier.rgba, w: win.width, h: win.height }}
                  class="w-full h-full block pixelated"
                ></canvas>
              </div>
              <div class="text-[9px] text-gray-400 tabular-nums">{tier.label}</div>
              <div class="text-[8px] text-gray-500 tabular-nums">
                {tier.dims} dims · {formatBytes(tier.bytes)}
              </div>
              <div class="text-[8px] tabular-nums"
                   class:text-term-cyan={tier.spread >= 3}
                   class:text-gray-500={tier.spread < 3}>
                spread {tier.spread.toFixed(1)}×
              </div>
            </div>
          {/each}
        </div>
      </div>

    {/if}
  </div>
{/if}

<style>
  .pixelated {
    image-rendering: pixelated;
  }
</style>
