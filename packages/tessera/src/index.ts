// @ucam-eo/tessera — core TESSERA embedding access library

export { TesseraSource } from './tessera-source.js';
export { SourceManager } from './source-manager.js';
export { EventEmitter } from './event-emitter.js';
export type { EventCallback } from './event-emitter.js';
export { UtmProjection } from './projection.js';
export { TesseraTileRenderer } from './tile-renderer.js';

// @internal — used by map plugins, not intended for public consumption
export { openStore, openArray, fetchRegion, parseModelName } from './zarr-reader.js';
export { withRangeCoalescing, withRequestCoalescing } from './coalescing.js';
export type { RangeCoalescingOptions } from './coalescing.js';
export { withRetry, onNetworkActivity, getNetworkActivity } from './retry.js';
export type { RetryOptions, NetworkActivity } from './retry.js';
export type { ZarrStore } from './zarr-reader.js';

export type { LoadChunksOptions } from './tessera-source.js';

export { parseDepths, alignDepthWindow, depthWindowCost, groupTilesByChunk } from './depths.js';
export type { DepthDescriptor, DepthWindow, DepthWindowResult, TileGroup } from './depths.js';
export { dequantiseNCHW } from './dequantise.js';

export type {
  TesseraOptions,
  StoreMetadata,
  TileStatistics,
  ChunkRef,
  ChunkBounds,
  ManagedChunk,
  EmbeddingRegion,
  EmbeddingAt,
  ZoneDescriptor,
  EmbeddingProgress,
  DebugLogEntry,
  UtmBounds,
  TesseraEvents,
  TileRendererOptions,
} from './types.js';
