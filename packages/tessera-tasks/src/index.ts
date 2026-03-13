// @ucam-eo/tessera-tasks — analysis algorithms for TESSERA embeddings
//
// Heavy deps (TensorFlow.js, ONNX Runtime) are isolated in separate
// entry points so they are only loaded when the consumer imports them:
//   - @ucam-eo/tessera-tasks/classify  → TensorFlow.js
//   - @ucam-eo/tessera-tasks/segment   → ONNX Runtime
//
// This main entry point is lightweight (no heavy deps).

export {
  computeSimilarityScores,
  renderSimilarityCanvas,
  type SimilarityResult,
} from './similarity.js';

// Re-export only types from heavy modules so they can be used without
// pulling in TensorFlow.js or ONNX Runtime at runtime.
export type {
  ClassDef,
  LabelSource,
  LabelPoint,
  ClassificationResult,
  ClassifyProgress,
  OnBatchUpdate,
} from './classify.js';

export type {
  SegmentationSessionOptions,
  SegmentResult,
} from './segment.js';
export type { SegmentationSession } from './segment.js';

export { ClassificationStore } from './classification-store.js';
