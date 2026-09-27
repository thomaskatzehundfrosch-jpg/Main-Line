import { Chess } from 'chess.js';
import type { GeneratorNode } from '../types/generator';

export function cloneGeneratorTree(node: GeneratorNode): GeneratorNode {
  return { ...node, stockfish: node.stockfish ? { ...node.stockfish } : null,
    lichess: node.lichess ? { ...node.lichess } : null, children: node.children.map(cloneGeneratorTree) };
}

/** Validate every line before publishing anything; merge shared prefixes once. */
export function buildSeedTree(seeds: string[][], color: 'white' | 'black'): GeneratorNode {
  let id = 0;
  const root: GeneratorNode = {
    id: 'root', san: null, uci: '', fen: new Chess().fen(), depth: 0, fullMoveNumber: 0,
    children: [], isOurMove: color === 'white', isMainLine: false, isDangerous: false,
    cappedByMoveLimit: false, stockfish: null, lichess: null, isRoot: true, repertoireColor: color,
  };
  seeds.forEach((line, index) => {
    const chess = new Chess();
    let parent = root;
    line.forEach((san, ply) => {
      const fullMoveNumber = Number(chess.fen().split(' ')[5]);
      let move;
      try { move = chess.move(san); } catch { throw new Error(`Starting line ${index + 1}: illegal move “${san}” at ply ${ply + 1}. Nothing was changed.`); }
      if (!move) throw new Error(`Starting line ${index + 1}: illegal move “${san}”.`);
      const uci = move.from + move.to + (move.promotion || '');
      let child = parent.children.find(n => n.uci === uci);
      if (!child) {
        child = {
          id: `seed_${++id}`, san: move.san, uci, fen: chess.fen(), children: [], depth: ply + 1,
          fullMoveNumber, isOurMove: move.color === (color === 'white' ? 'w' : 'b'),
          isMainLine: parent.children.length === 0, isDangerous: false, cappedByMoveLimit: false,
          stockfish: null, lichess: null, isSeed: true, reason: 'Your supplied move — preserved',
        };
        parent.children.push(child);
      }
      parent = child;
    });
  });
  return root;
}

export function countGeneratorNodes(root: GeneratorNode): number {
  return root.children.reduce((sum, n) => sum + 1 + countGeneratorNodes(n), 0);
}
