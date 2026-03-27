import { writable } from 'svelte/store';

/** Cached tile embedding buffer for per-pixel fingerprint lookups on mousemove. */
export const explorerTileEmb = writable<{
  zoneId: string;
  ci: number;
  cj: number;
  emb: Float32Array;
  nBands: number;
  tileW: number;
  tileH: number;
} | null>(null);

export const explorerHover = writable<{
  zoneId: string;
  ci: number;
  cj: number;
  years: number[];
  utmBounds: [number, number, number, number];
} | null>(null);

/** Current pixel under the cursor in explorer mode. */
export const explorerPixel = writable<{
  lng: number; lat: number;
  ci: number; cj: number; row: number; col: number;
} | null>(null);

/** Year → colour mapping */
export const YEAR_COLORS: Record<number, string> = {
  2017: '#e6194b',
  2018: '#f58231',
  2019: '#ffe119',
  2020: '#3cb44b',
  2021: '#42d4f4',
  2022: '#4363d8',
  2023: '#911eb4',
  2024: '#f032e6',
  2025: '#00e5ff',
};
