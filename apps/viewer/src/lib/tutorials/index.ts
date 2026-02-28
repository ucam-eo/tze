import { registerTutorial } from '../../stores/tutorial';
import { understandingEmbeddings } from './understanding-embeddings';

export function registerAllTutorials() {
  registerTutorial(understandingEmbeddings);
}
