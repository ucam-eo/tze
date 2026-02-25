<script lang="ts">
  import { zarrSource } from '../stores/zarr';
  import { importOsmLabels } from '../stores/classifier';
  import { queryOverpass, type OsmCategory } from '../lib/overpass';
  import { sampleOsmCategories, type SampleProgress } from '../lib/osm-sampler';

  type Phase = 'idle' | 'querying' | 'selecting' | 'sampling' | 'done' | 'error';

  let phase = $state<Phase>('idle');
  let categories = $state<OsmCategory[]>([]);
  let selected = $state<Set<string>>(new Set());
  let errorMsg = $state('');
  let sampleProgress = $state<SampleProgress | null>(null);
  let resultMsg = $state('');
  let abortCtrl = $state<AbortController | null>(null);
  let embeddingTileCount = $state(0);

  // Track embedding loads
  $effect(() => {
    const src = $zarrSource;
    if (!src) { embeddingTileCount = 0; return; }
    embeddingTileCount = src.embeddingCache.size;
    const handler = () => { embeddingTileCount = src.embeddingCache.size; };
    src.on('embeddings-loaded', handler);
    return () => src.off('embeddings-loaded', handler);
  });

  const canQuery = $derived(embeddingTileCount > 0);

  async function handleQuery() {
    const src = $zarrSource;
    if (!src) return;
    const bbox = src.embeddingBoundsLngLat();
    if (!bbox) return;

    phase = 'querying';
    errorMsg = '';
    const ctrl = new AbortController();
    abortCtrl = ctrl;

    try {
      categories = await queryOverpass(bbox, ctrl.signal);
      if (categories.length === 0) {
        errorMsg = 'No OSM features found in the loaded tile area.';
        phase = 'error';
        return;
      }
      // Pre-select all
      selected = new Set(categories.map(c => c.tag));
      phase = 'selecting';
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        phase = 'idle';
      } else {
        errorMsg = (e as Error).message;
        phase = 'error';
      }
    } finally {
      abortCtrl = null;
    }
  }

  function toggleCategory(tag: string) {
    const next = new Set(selected);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    selected = next;
  }

  function selectAll() {
    selected = new Set(categories.map(c => c.tag));
  }

  function selectNone() {
    selected = new Set();
  }

  async function handleImport() {
    const src = $zarrSource;
    if (!src) return;

    const chosen = categories.filter(c => selected.has(c.tag));
    if (chosen.length === 0) return;

    phase = 'sampling';
    sampleProgress = null;

    try {
      const sampled = await sampleOsmCategories(src, chosen, (p) => {
        sampleProgress = p;
      });

      // Build class definitions and label map for import
      const newClasses = chosen
        .filter(c => sampled.has(c.tag))
        .map(c => ({ name: c.displayName, color: c.suggestedColor }));

      const newLabels = new Map<string, Array<{ lngLat: [number, number]; embeddingAt: import('@ucam-eo/maplibre-zarr-tessera').EmbeddingAt }>>();
      for (const c of chosen) {
        const s = sampled.get(c.tag);
        if (s && s.length > 0) {
          newLabels.set(c.displayName, s);
        }
      }

      const { classesCreated, labelsImported } = importOsmLabels(newClasses, newLabels);
      resultMsg = `Imported ${labelsImported} labels across ${classesCreated + (newClasses.length - classesCreated)} classes (${classesCreated} new)`;
      phase = 'done';
    } catch (e) {
      errorMsg = (e as Error).message;
      phase = 'error';
    } finally {
      sampleProgress = null;
    }
  }

  function handleCancel() {
    abortCtrl?.abort();
    phase = 'idle';
    categories = [];
    selected = new Set();
    sampleProgress = null;
  }

  function handleClose() {
    phase = 'idle';
    resultMsg = '';
  }

  function handleRetry() {
    phase = 'idle';
    errorMsg = '';
  }
</script>

<div class="space-y-2">
  {#if phase === 'idle'}
    <button
      onclick={handleQuery}
      disabled={!canQuery}
      class="w-full text-[10px] font-bold py-1.5 rounded border transition-all
             {canQuery
               ? 'bg-gray-900 text-gray-300 border-gray-600 hover:border-term-cyan/50 hover:text-term-cyan'
               : 'bg-gray-950 text-gray-700 border-gray-800 cursor-not-allowed'}"
    >QUERY OSM</button>
    {#if !canQuery}
      <div class="text-[9px] text-gray-700">Double-click tiles to load embeddings first</div>
    {/if}

  {:else if phase === 'querying'}
    <div class="flex items-center gap-2">
      <div class="w-3 h-3 border-2 border-term-cyan/60 border-t-transparent rounded-full animate-spin"></div>
      <span class="text-[10px] text-gray-400">Querying Overpass API...</span>
      <button
        onclick={handleCancel}
        class="ml-auto text-[9px] text-gray-600 hover:text-red-400 transition-colors"
      >CANCEL</button>
    </div>

  {:else if phase === 'selecting'}
    <div class="flex items-center justify-between mb-1">
      <span class="text-[10px] text-gray-500">{categories.length} categories found</span>
      <div class="flex gap-2">
        <button onclick={selectAll}
          class="text-[9px] text-gray-600 hover:text-gray-400 transition-colors">All</button>
        <button onclick={selectNone}
          class="text-[9px] text-gray-600 hover:text-gray-400 transition-colors">None</button>
      </div>
    </div>
    <div class="max-h-40 overflow-y-auto space-y-0.5 pr-1 scrollbar-thin">
      {#each categories as cat}
        <label class="flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer
                      hover:bg-gray-900/50 transition-colors">
          <input
            type="checkbox"
            checked={selected.has(cat.tag)}
            onchange={() => toggleCategory(cat.tag)}
            class="w-3 h-3 accent-[var(--accent)]"
            style="--accent: {cat.suggestedColor}"
          />
          <span class="w-2.5 h-2.5 rounded-sm shrink-0" style="background: {cat.suggestedColor}"></span>
          <span class="text-[10px] text-gray-300 flex-1 truncate">{cat.displayName}</span>
          <span class="text-[9px] text-gray-600 tabular-nums">{cat.polygons.length}</span>
        </label>
      {/each}
    </div>
    <div class="flex gap-1.5">
      <button
        onclick={handleImport}
        disabled={selected.size === 0}
        class="flex-1 bg-term-cyan/90 hover:bg-term-cyan text-black font-bold text-[10px]
               px-3 py-1.5 rounded tracking-wider transition-all
               hover:shadow-[0_0_12px_rgba(0,229,255,0.4)] active:scale-95
               disabled:opacity-40 disabled:pointer-events-none"
      >IMPORT ({selected.size})</button>
      <button
        onclick={handleCancel}
        class="text-[10px] text-gray-500 hover:text-red-400 px-2 py-1.5 rounded
               border border-gray-700/60 hover:border-red-400/40 transition-all"
      >CANCEL</button>
    </div>

  {:else if phase === 'sampling'}
    <div class="space-y-1.5">
      <div class="flex items-center gap-2">
        <div class="w-3 h-3 border-2 border-term-cyan/60 border-t-transparent rounded-full animate-spin"></div>
        <span class="text-[10px] text-gray-400">Sampling embeddings...</span>
      </div>
      {#if sampleProgress}
        <div class="text-[9px] text-gray-500 tabular-nums">
          {sampleProgress.categoryName}: {sampleProgress.samplesCollected} samples
          ({sampleProgress.categoryIndex}/{sampleProgress.categoryTotal})
        </div>
        <div class="h-1.5 bg-gray-900 rounded-full overflow-hidden">
          <div class="h-full bg-term-cyan rounded-full transition-all duration-150"
               style="width: {Math.round((sampleProgress.categoryIndex / sampleProgress.categoryTotal) * 100)}%"></div>
        </div>
      {/if}
    </div>

  {:else if phase === 'done'}
    <div class="space-y-1.5">
      <div class="text-[10px] text-green-400">{resultMsg}</div>
      <button
        onclick={handleClose}
        class="w-full text-[10px] text-gray-500 hover:text-gray-300 py-1 rounded
               border border-gray-700/60 hover:border-gray-500 transition-all"
      >CLOSE</button>
    </div>

  {:else if phase === 'error'}
    <div class="space-y-1.5">
      <div class="text-[10px] text-red-400">{errorMsg}</div>
      <button
        onclick={handleRetry}
        class="w-full text-[10px] text-gray-500 hover:text-gray-300 py-1 rounded
               border border-gray-700/60 hover:border-gray-500 transition-all"
      >RETRY</button>
    </div>
  {/if}
</div>
