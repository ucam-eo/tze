import { writable } from 'svelte/store';

export type ToolId = 'similarity' | 'classifier' | 'segmenter';

export const activeTool = writable<ToolId>('similarity');
