// @ucam-eo/maplibre-tessera — MapLibre display plugin for TESSERA embeddings

export { MaplibreTesseraSource } from './maplibre-source.js';
export type { MaplibreTesseraOptions } from './maplibre-source.js';
export { MaplibreTesseraManager } from './maplibre-manager.js';
export { registerZarrProtocol, clearZarrProtocolCache } from './zarr-tile-protocol.js';

// Display-only types
export type { PreviewMode, MaplibreDisplayOptions, CachedChunk } from './types.js';
