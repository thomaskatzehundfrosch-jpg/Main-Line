import type { GeneratorNode, GeneratorSettings } from '../types/generator';
import { normalizeGeneratorSettings } from '../types/generator';

export const GENERATOR_CHECKPOINT_KEY = 'main-line-generator-checkpoint-v1';
export interface GeneratorCheckpoint {
  version: 1;
  savedAt: string;
  settings: GeneratorSettings;
  tree: GeneratorNode;
}

export function readGeneratorCheckpoint(storage: Pick<Storage, 'getItem'> = localStorage): GeneratorCheckpoint | null {
  try {
    const value = JSON.parse(storage.getItem(GENERATOR_CHECKPOINT_KEY) || 'null');
    if (value?.version !== 1 || !value.tree?.isRoot || !Array.isArray(value.tree.children)
      || typeof value.savedAt !== 'string' || !Array.isArray(value.settings?.speeds)) return null;
    let nodes = 0;
    const valid = (node: GeneratorNode, depth = 0): boolean => ++nodes <= 20000 && depth <= 200
      && typeof node.id === 'string' && typeof node.fen === 'string'
      && Array.isArray(node.children) && node.children.every(child => valid(child, depth + 1));
    if (!valid(value.tree)) return null;
    return { ...value, settings: normalizeGeneratorSettings(value.settings) };
  } catch { return null; }
}

export function saveGeneratorCheckpoint(tree: GeneratorNode, settings: GeneratorSettings,
  storage: Pick<Storage, 'setItem'> = localStorage): GeneratorCheckpoint | null {
  const checkpoint: GeneratorCheckpoint = { version: 1, savedAt: new Date().toISOString(), tree, settings };
  try { storage.setItem(GENERATOR_CHECKPOINT_KEY, JSON.stringify(checkpoint)); return checkpoint; }
  catch { return null; }
}
