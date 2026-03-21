import { writable } from 'svelte/store';
import type { FeatureCollection } from 'geojson';

export const explorerGrid = writable<FeatureCollection>({
  type: 'FeatureCollection', features: [],
});
export const explorerVisible = writable(false);
export const explorerHover = writable<{
  zoneId: string;
  ci: number;
  cj: number;
  years: number[];
  utmBounds: [number, number, number, number];
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

/** Blend multiple year colours by averaging RGB channels. */
export function blendYearColors(years: number[]): string {
  if (years.length === 0) return '#444444';
  if (years.length === 1) return YEAR_COLORS[years[0]] ?? '#888888';
  let r = 0, g = 0, b = 0;
  for (const y of years) {
    const hex = YEAR_COLORS[y] ?? '#888888';
    r += parseInt(hex.slice(1, 3), 16);
    g += parseInt(hex.slice(3, 5), 16);
    b += parseInt(hex.slice(5, 7), 16);
  }
  const n = years.length;
  const toHex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
