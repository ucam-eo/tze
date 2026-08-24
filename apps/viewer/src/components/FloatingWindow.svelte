<script lang="ts">
  /**
   * A draggable window floating over the map.
   *
   * Deliberately not a modal: there is no backdrop and the map stays live
   * underneath, so the window can sit beside the tile it describes. Position
   * survives close/reopen within a session, and is clamped back into view on
   * resize so a window dragged to an edge cannot strand itself off-screen.
   */
  import { X } from 'lucide-svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    title: string;
    subtitle?: string;
    width?: number;
    onclose: () => void;
    children: Snippet;
  }

  let { open, title, subtitle, width = 340, onclose, children }: Props = $props();

  /** Keep the window on screen, leaving a grab-able strip of title bar. */
  const MARGIN = 8;
  const TITLE_H = 28;

  let x = $state(-1);
  let y = $state(-1);
  let viewportW = $state(typeof window === 'undefined' ? 1024 : window.innerWidth);
  /** Never wider than the viewport, however wide the caller asks for. */
  const shownWidth = $derived(Math.min(width, viewportW - 2 * MARGIN));
  let dragging = $state(false);
  let grabX = 0, grabY = 0;
  let el = $state<HTMLElement>();

  function clampX(v: number) {
    return Math.max(MARGIN - shownWidth + 60, Math.min(v, window.innerWidth - 60));
  }
  function clampY(v: number) {
    return Math.max(MARGIN, Math.min(v, window.innerHeight - TITLE_H));
  }

  // First open lands top-left: the tool sidebar owns the top-right corner.
  $effect(() => {
    if (open && x < 0) {
      x = MARGIN + 8;
      y = 56;
    }
  });

  function startDrag(ev: PointerEvent) {
    if (ev.button !== 0) return;
    dragging = true;
    grabX = ev.clientX - x;
    grabY = ev.clientY - y;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    ev.preventDefault();
  }

  function onDrag(ev: PointerEvent) {
    if (!dragging) return;
    x = clampX(ev.clientX - grabX);
    y = clampY(ev.clientY - grabY);
  }

  function endDrag(ev: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
  }

  function onResize() {
    viewportW = window.innerWidth;
    if (x < 0) return;
    x = clampX(x);
    y = clampY(y);
  }
</script>

<svelte:window onresize={onResize} />

{#if open}
  <div
    bind:this={el}
    class="fixed z-40 flex flex-col bg-gray-950/95 backdrop-blur-sm
           border border-gray-700/80 rounded-lg shadow-2xl shadow-black/50
           max-h-[calc(100vh-5rem)]"
    style="left: {x}px; top: {y}px; width: {shownWidth}px"
  >
    <!-- Title bar: drag handle -->
    <div
      role="toolbar"
      tabindex="-1"
      onpointerdown={startDrag}
      onpointermove={onDrag}
      onpointerup={endDrag}
      onpointercancel={endDrag}
      class="flex items-center gap-2 px-2.5 py-1.5 border-b border-gray-800/80
             rounded-t-lg select-none touch-none shrink-0"
      class:cursor-grab={!dragging}
      class:cursor-grabbing={dragging}
    >
      <span class="text-[10px] text-gray-300 font-medium truncate">{title}</span>
      {#if subtitle}
        <span class="text-[9px] text-gray-600 truncate">{subtitle}</span>
      {/if}
      <button
        onclick={onclose}
        onpointerdown={(e) => e.stopPropagation()}
        class="ml-auto shrink-0 text-gray-600 hover:text-gray-300 transition-colors"
        title="Close"
        aria-label="Close window"
      >
        <X size={12} />
      </button>
    </div>

    <div class="overflow-y-auto overscroll-contain px-2.5 py-2">
      {@render children()}
    </div>
  </div>
{/if}
