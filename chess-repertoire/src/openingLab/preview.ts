import type { TreeNode } from '../types';
export type PreviewMove = { move: string; fen: string };
export function createLabPreview(tree: TreeNode, parentId: string, moves: PreviewMove[]) {
  if (!moves.length) return { tree, nodes: [] as TreeNode[] };
  const copy = structuredClone(tree);
  const find = (node: TreeNode): TreeNode | undefined => node.id === parentId ? node : node.children.map(find).find(Boolean);
  const found = find(copy);
  const nodes: TreeNode[] = [];
  if (!found) return { tree, nodes };
  let parent: TreeNode = found;
  for (const [index, move] of moves.entries()) {
    const node: TreeNode & { _labPreview: boolean } = { ...move, id: `lab-preview-${parentId}-${index}`, children: [], parentId: parent.id,
      gameCount: 0, whiteWins: 0, blackWins: 0, draws: 0, comment: 'Opening Lab preview — use Add to line to save.', nags: [], depth: parent.depth + 1, _labPreview: true };
    parent.children.push(node); nodes.push(node); parent = node;
  }
  return { tree: copy, nodes };
}
