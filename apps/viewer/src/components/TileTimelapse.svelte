<script lang="ts">
  /**
   * The selected shard, year by year.
   *
   * @remarks
   * Reads the same window once per year that has data and cycles through the
   * frames. The preview uses bands 0–2, which every matryoshka depth stores
   * identically, so frames come from the shallowest array the store offers —
   * a ninth of the bytes a full-depth read would cost, for the same picture.
   *
   * All frames share one colour stretch. Normalising each year to its own
   * range would make the scene pulse between frames and read as change where
   * there is none.
   */
  import { get } from 'svelte/store';
  import { Play, Pause } from 'lucide-svelte';
  import { sourceManager, metadata } from '../stores/zarr';
  import { explorerPinned } from '../stores/zarr-explorer';
  import { alignDepthWindow, type DepthWindow } from '@ucam-eo/tessera';
  import { bandRanges, rgbaFromBands } from '@ucam-eo/tessera-tasks';

  /** Window side in pixels: one whole chunk at the shallowest depth. */
  const WINDOW = 128;
  const RGB_BANDS: [number, number, number] = [0, 1, 2];
  /** Frame duration, slow enough to read the year label. */
  const FRAME_MS = 900;

  interface Frame {
    year: number;
    rgba: Uint8ClampedArray;
  }

  let frames = $state<Frame[]>([]);
  let index = $state(0);
  let playing = $state(true);
  let loading = $state(false);
  let error = $state('');
  let win = $state<DepthWindow | null>(null);
  let emptyYears = $state(0);
  let gen = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const selected = $derived($explorerPinned);
  const years = $derived($metadata?.years ?? []);
  /**
   * Only offered where the store ships a shallow array. Without one, each
   * frame is a full-depth read — around 2 MB a year — which is far too much
   * to spend automatically on a preview.
   */
  const cheapFrames = $derived(($metadata?.geoemb_depths?.length ?? 0) > 1);
  const selectionKey = $derived(selected ? `${selected.zoneId}:${selected.ci}_${selected.cj}` : '');
  const current = $derived(frames[index] ?? null);

  $effect(() => {
    if (!selectionKey || years.length < 2 || !cheapFrames) return;
    void load();
  });

  // Advance only while there is more than one frame to advance between.
  $effect(() => {
    clearInterval(timer);
    if (playing && frames.length > 1) {
      timer = setInterval(() => { index = (index + 1) % frames.length; }, FRAME_MS);
    }
    return () => clearInterval(timer);
  });

  async function load() {
    const sel = selected;
    const mgr = get(sourceManager);
    if (!sel || !mgr) return;

    const myGen = ++gen;
    loading = true;
    error = '';
    frames = [];
    index = 0;
    emptyYears = 0;

    try {
      const src = mgr.getOpenSource(sel.zoneId) ?? await mgr.getSource(sel.zoneId);
      const meta = src?.metadata;
      if (!src || !meta?.years?.length) throw new Error('no time axis');
      if (myGen !== gen) return;

      const { globalRow, globalCol } = src.pixelToGlobal(sel.ci, sel.cj, 0, 0);
      const w = alignDepthWindow(globalRow, globalCol, WINDOW, meta.shape[0], meta.shape[1]);
      const pixels = w.height * w.width;

      // Bands 0-2 are identical at every depth, so read the cheapest array.
      const depth = src.depths[0] ?? meta.nBands;

      // Skip years the store has no shard for rather than fetching them.
      const available = await mgr.probeYearData(sel.zoneId, sel.ci, sel.cj);
      if (myGen !== gen) return;

      const reads: { year: number; emb: Float32Array; nBands: number }[] = [];
      for (const [i, year] of meta.years.entries()) {
        if (available.size > 0 && !available.get(year)) { emptyYears++; continue; }
        const r = await src.fetchDepthWindow({ depth, timeIndex: i, ...w });
        if (myGen !== gen) return;
        if (!r) continue;
        // A shard can be listed and still hold nothing here.
        if (isNaN(r.emb[0]) && !hasData(r.emb, pixels, r.nBands)) { emptyYears++; continue; }
        reads.push({ year, emb: r.emb, nBands: r.nBands });
      }
      if (reads.length === 0) throw new Error('no year has data for this shard');

      const ranges = bandRanges(
        reads.map(r => ({ emb: r.emb, nBands: r.nBands, nPixels: pixels })),
        RGB_BANDS,
      );
      frames = reads.map(r => ({
        year: r.year,
        rgba: rgbaFromBands(r.emb, pixels, r.nBands, RGB_BANDS, ranges),
      }));
      win = w;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      error = (err as Error).message;
    } finally {
      if (myGen === gen) loading = false;
    }
  }

  /** Does any pixel in this frame carry data? */
  function hasData(emb: Float32Array, pixels: number, nBands: number): boolean {
    for (let p = 0; p < pixels; p++) if (!isNaN(emb[p * nBands])) return true;
    return false;
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
</script>

{#if selected && years.length > 1 && cheapFrames}
  <div class="bg-gray-900/80 border border-gray-800/60 rounded px-2.5 py-2 space-y-1.5">
    <div class="flex items-center justify-between gap-2">
      <span class="text-[9px] text-gray-500">Across years</span>
      {#if frames.length > 1}
        <button
          onclick={() => { playing = !playing; }}
          class="text-gray-500 hover:text-term-cyan transition-colors"
          title={playing ? 'Pause' : 'Play'}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {#if playing}<Pause size={10} />{:else}<Play size={10} />{/if}
        </button>
      {/if}
    </div>

    {#if loading}
      <div class="flex items-center gap-1.5 text-[9px] text-term-cyan/80">
        <span class="w-1.5 h-1.5 rounded-full bg-term-cyan/70 animate-pulse"></span>
        Reading each year…
      </div>
    {:else if error}
      <div class="text-[9px] text-gray-600">{error}</div>
    {/if}

    {#if current && win}
      <div class="relative w-full aspect-square rounded overflow-hidden border border-gray-800/60 bg-gray-950">
        <canvas
          use:paint={{ rgba: current.rgba, w: win.width, h: win.height }}
          class="w-full h-full block pixelated"
        ></canvas>
        <span class="absolute bottom-1 right-1 px-1 rounded bg-black/70 text-[10px] text-term-cyan tabular-nums">
          {current.year}
        </span>
      </div>

      <div class="flex flex-wrap gap-0.5">
        {#each frames as frame, i (frame.year)}
          <button
            onclick={() => { index = i; playing = false; }}
            class="px-1 py-0.5 rounded text-[8px] tabular-nums transition-colors
                   {i === index
                     ? 'text-term-cyan bg-term-cyan/10 border border-term-cyan/40'
                     : 'text-gray-600 border border-transparent hover:text-gray-400'}"
          >{String(frame.year).slice(2)}</button>
        {/each}
      </div>

      <div class="text-[8px] text-gray-600">
        {frames.length} of {years.length} years
        {#if emptyYears > 0}· {emptyYears} with no data{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .pixelated {
    image-rendering: pixelated;
  }
</style>
