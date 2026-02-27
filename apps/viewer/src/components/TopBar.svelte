<script lang="ts">
  import { ChevronDown, Database, MapPin } from 'lucide-svelte';
  import { zones, activeZoneId, catalogStatus, switchZone } from '../stores/stac';
  import { metadata, loading } from '../stores/zarr';

  interface Props {
    onOpenCatalog: () => void;
  }

  let { onOpenCatalog }: Props = $props();
  let zoneDropdownOpen = $state(false);

  const activeZone = $derived($zones.find(z => z.id === $activeZoneId));

  const healthColor = $derived(
    $catalogStatus === 'loaded' ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.6)]'
    : $catalogStatus === 'loading' ? 'bg-yellow-400 shadow-[0_0_4px_rgba(250,204,21,0.6)]'
    : $catalogStatus === 'error' ? 'bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.6)]'
    : 'bg-gray-500'
  );

  const healthLabel = $derived(
    $catalogStatus === 'loaded' ? 'Connected'
    : $catalogStatus === 'loading' ? 'Loading...'
    : $catalogStatus === 'error' ? 'Error'
    : 'Idle'
  );

  function handleZoneClick(zoneId: string) {
    switchZone(zoneId);
    zoneDropdownOpen = false;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="absolute top-0 left-0 right-0 h-9 z-20
            bg-black/85 backdrop-blur-xl border-b border-gray-800/60
            flex items-center px-4 gap-3 font-mono text-xs select-none">

  <!-- TZE branding -->
  <div class="flex items-center gap-2 shrink-0">
    <div class="w-2 h-2 rounded-full bg-term-cyan shadow-[0_0_6px_rgba(0,229,255,0.6)]"></div>
    <span class="text-term-cyan text-[11px] font-bold tracking-[0.2em] uppercase">TZE</span>
  </div>

  <!-- Zone dropdown -->
  <div class="relative">
    <button
      onclick={() => { zoneDropdownOpen = !zoneDropdownOpen; }}
      disabled={$zones.length === 0}
      class="flex items-center gap-1.5 px-2 py-1 rounded
             text-gray-300 hover:bg-gray-800/60 transition-colors
             disabled:opacity-40 disabled:cursor-default"
    >
      <MapPin size={12} class="text-term-cyan" />
      <span class="text-[11px]">
        {activeZone ? `UTM ${activeZone.utmZone}` : 'No zone'}
      </span>
      <ChevronDown size={12} class="text-gray-500" />
    </button>

    {#if zoneDropdownOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="fixed inset-0 z-30" onclick={() => { zoneDropdownOpen = false; }}></div>
      <div class="absolute top-full left-0 mt-1 z-40
                  bg-gray-950 border border-gray-700/80 rounded shadow-xl
                  min-w-[140px] py-1">
        {#each $zones as zone}
          <button
            onclick={() => handleZoneClick(zone.id)}
            class="flex items-center gap-2 w-full text-left px-3 py-1.5
                   text-[11px] transition-colors
                   {zone.id === $activeZoneId
                     ? 'text-term-cyan bg-term-cyan/10'
                     : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}"
          >
            <span class="w-1.5 h-1.5 rounded-full shrink-0
                         {zone.id === $activeZoneId ? 'bg-term-cyan' : 'bg-gray-600'}"></span>
            UTM {zone.utmZone}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Metadata pills (visible when a zone is loaded) -->
  {#if $metadata}
    <div class="flex items-center gap-2 text-[10px] text-gray-500">
      <span class="text-gray-600">EPSG:{$metadata.epsg}</span>
      <span class="text-gray-700">|</span>
      <span class="text-gray-600">{$metadata.shape[1]}x{$metadata.shape[0]}px</span>
      <span class="text-gray-700">|</span>
      <span class="text-gray-600">{$metadata.nBands}b</span>
      {#if $loading.total > 0}
        <span class="text-gray-700">|</span>
        <span class="text-term-cyan/60 tabular-nums">{$loading.done}/{$loading.total}</span>
      {/if}
    </div>
  {/if}

  <!-- Spacer -->
  <div class="flex-1"></div>

  <!-- Health indicator -->
  <div class="flex items-center gap-1.5">
    <div class="w-2 h-2 rounded-full {healthColor}"></div>
    <span class="text-[10px] text-gray-500">{healthLabel}</span>
  </div>

  <!-- Catalog button -->
  <button
    onclick={onOpenCatalog}
    class="flex items-center gap-1.5 px-2 py-1 rounded
           text-gray-400 hover:text-term-cyan hover:bg-gray-800/60 transition-colors"
    title="Open catalog connection"
  >
    <Database size={13} />
  </button>
</div>
