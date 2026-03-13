import { writable } from 'svelte/store';
import type { FeatureCollection } from 'geojson';

export const segmentPolygons = writable<FeatureCollection>({
  type: 'FeatureCollection',
  features: [],
});

export const segmentVisible = writable(true);
