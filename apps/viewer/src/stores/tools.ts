import { writable } from 'svelte/store';

export type ToolId = 'similarity' | 'classifier' | 'segmenter' | 'explorer';

export const activeTool = writable<ToolId>('explorer');
