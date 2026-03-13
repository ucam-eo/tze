// Display-specific types for the MapLibre plugin.
// Data types (StoreMetadata, EmbeddingRegion, etc.) come from @ucam-eo/tessera.

export type PreviewMode = 'rgb' | 'pca' | 'bands';

export interface MaplibreDisplayOptions {
  bands?: [number, number, number];
  opacity?: number;
  preview?: PreviewMode;
  maxCached?: number;
  maxLoadPerUpdate?: number;
  globalPreviewUrl?: string;
  globalPreviewBounds?: [number, number, number, number];
}

export interface CachedChunk {
  ci: number;
  cj: number;
  canvas: HTMLCanvasElement | null;
  sourceId: string | null;
  layerId: string | null;
  isPreview: boolean;
}
