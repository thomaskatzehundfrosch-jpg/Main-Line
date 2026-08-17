import type { GeneratorNode } from '../types/generator';

type RepertoireColor = 'white' | 'black';

/**
 * Training tools commonly merge identical positions reached by different move
 * orders. Keep exactly one repertoire move for our side per position key so
 * those transpositions do not become multiple-choice prep.
 */
export function pruneOurTranspositionChoices(
  tree: GeneratorNode,
  color: string
): GeneratorNode {
  const repertoireColor: RepertoireColor = color === 'black' ? 'black' : 'white';
  const chosenMoveByFen = new Map<string, string>();

  collectCanonicalOurMoves(tree, repertoireColor, chosenMoveByFen);
  return cloneWithCanonicalOurMoves(tree, repertoireColor, chosenMoveByFen);
}

function collectCanonicalOurMoves(
  node: GeneratorNode,
  color: RepertoireColor,
  chosenMoveByFen: Map<string, string>
): void {
  if (isOurTurn(node.fen, color) && node.children.length > 0) {
    const key = positionKey(node.fen);
    const currentChoice = chosenMoveByFen.get(key);
    const bestChild = chooseBestOurChild(node.children, color);

    if (bestChild?.san) {
      if (!currentChoice) {
        chosenMoveByFen.set(key, bestChild.san);
      } else {
        const currentChild = node.children.find((child) => child.san === currentChoice);
        const winner = chooseBestOurChild(
          [currentChild, bestChild].filter(Boolean) as GeneratorNode[],
          color
        );
        if (winner?.san) chosenMoveByFen.set(key, winner.san);
      }
    }
  }

  for (const child of node.children) {
    collectCanonicalOurMoves(child, color, chosenMoveByFen);
  }
}

function cloneWithCanonicalOurMoves(
  node: GeneratorNode,
  color: RepertoireColor,
  chosenMoveByFen: Map<string, string>
): GeneratorNode {
  let children = node.children;

  if (isOurTurn(node.fen, color) && children.length > 0) {
    const chosenSan = chosenMoveByFen.get(positionKey(node.fen));
    children = chosenSan ? children.filter((child) => child.san === chosenSan) : [];
  }

  return {
    ...node,
    stockfish: node.stockfish ? { ...node.stockfish } : null,
    lichess: node.lichess ? { ...node.lichess } : null,
    children: children.map((child) => cloneWithCanonicalOurMoves(child, color, chosenMoveByFen)),
  };
}

function chooseBestOurChild(children: GeneratorNode[], color: RepertoireColor): GeneratorNode | null {
  let best: GeneratorNode | null = null;

  for (const child of children) {
    if (!child.san) continue;
    if (!best) {
      best = child;
      continue;
    }

    if (scoreChild(child, color) > scoreChild(best, color)) {
      best = child;
    }
  }

  return best;
}

function scoreChild(node: GeneratorNode, color: RepertoireColor): number {
  const evalScore = node.stockfish?.eval;
  const evalForColor = evalScore == null
    ? 0
    : color === 'white'
      ? evalScore
      : -evalScore;

  const mainLineBonus = node.isMainLine ? 100 : 0;
  const lichessBonus = Math.log10(Math.max(1, node.lichess?.totalGames ?? 0)) / 100;

  return mainLineBonus + evalForColor + lichessBonus;
}

function isOurTurn(fen: string, color: RepertoireColor): boolean {
  const turn = fen.split(' ')[1];
  return (color === 'white' && turn === 'w') || (color === 'black' && turn === 'b');
}

function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}
