import { writable } from 'svelte/store';

/** Set to true for ~4s after the welcome modal is dismissed — TopBar reads this to pulse UI hints. */
export const welcomeJustDismissed = writable(false);
