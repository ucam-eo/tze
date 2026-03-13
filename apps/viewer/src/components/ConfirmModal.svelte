<script lang="ts">
  import { AlertTriangle } from 'lucide-svelte';

  interface Props {
    open: boolean;
    title: string;
    message: string;
    detail?: string;
    confirmLabel?: string;
    onconfirm: () => void;
    oncancel: () => void;
  }

  let {
    open = $bindable(false),
    title,
    message,
    detail,
    confirmLabel = 'Continue',
    onconfirm,
    oncancel,
  }: Props = $props();
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
    <div class="bg-gray-950 border border-gray-700/80 rounded-lg shadow-2xl w-[380px] p-5 space-y-4">
      <div class="flex items-start gap-3">
        <div class="shrink-0 mt-0.5 text-amber-400">
          <AlertTriangle size={20} />
        </div>
        <div class="space-y-1.5">
          <h3 class="text-sm font-medium text-gray-200">{title}</h3>
          <p class="text-[11px] text-gray-400 leading-relaxed">{message}</p>
          {#if detail}
            <p class="text-[10px] text-gray-600 leading-relaxed">{detail}</p>
          {/if}
        </div>
      </div>
      <div class="flex justify-end gap-2">
        <button
          onclick={oncancel}
          class="text-[11px] text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded
                 border border-gray-700/60 hover:border-gray-600 transition-all"
        >Cancel</button>
        <button
          onclick={onconfirm}
          class="text-[11px] text-amber-400 hover:text-amber-300 px-3 py-1.5 rounded
                 border border-amber-500/40 hover:border-amber-400/60 hover:bg-amber-400/10 transition-all"
        >{confirmLabel}</button>
      </div>
    </div>
  </div>
{/if}
