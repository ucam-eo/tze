import { UMAP } from 'umap-js';

export interface UmapWorkerInput {
  embeddings: Float32Array; // N * nBands flat
  count: number;
  nBands: number;
}

export interface UmapWorkerOutput {
  positions: Float32Array; // N * 3
}

self.onmessage = (e: MessageEvent<UmapWorkerInput>) => {
  const { embeddings, count, nBands } = e.data;

  // Convert flat Float32Array to number[][] for umap-js
  const data: number[][] = new Array(count);
  for (let i = 0; i < count; i++) {
    const offset = i * nBands;
    data[i] = Array.from(embeddings.subarray(offset, offset + nBands));
  }

  const umap = new UMAP({
    nComponents: 3,
    nNeighbors: Math.min(15, count - 1),
    minDist: 0.1,
    nEpochs: 200,
  });

  const result = umap.fit(data);

  // Normalize to [-1, 1] range
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (let i = 0; i < result.length; i++) {
    for (let j = 0; j < 3; j++) {
      const v = result[i][j];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
  }

  const range = maxVal - minVal || 1;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < result.length; i++) {
    for (let j = 0; j < 3; j++) {
      positions[i * 3 + j] = ((result[i][j] - minVal) / range) * 2 - 1;
    }
  }

  (self as unknown as Worker).postMessage(
    { positions } satisfies UmapWorkerOutput,
    { transfer: [positions.buffer] },
  );
};
