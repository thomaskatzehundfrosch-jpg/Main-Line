import type { TreeNode } from '../types';
import type { ImportedGame } from './game';

export interface RepertoireFile {
  id: string;
  name: string;
  createdAt: string;    // ISO timestamp
  updatedAt: string;    // ISO timestamp
  nodeCount: number;
  tree: TreeNode;
  importedGames?: ImportedGame[];  // games scoped to this folder
}

export function generateFileId(): string {
  return `rep_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
