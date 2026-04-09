import type { TreeNode } from '../types';
import type { ImportedGame, MistakeTier } from '../types/game';

export interface ImportantLineRecommendation {
  key: string;
  parentNodeId: string;
  parentFen: string;
  startMoveNumber: number;
  triggerMove: string;
  line: string[];
  gamesCount: number;
  mistakeCount: number;
  averageEvalDrop: number;
  totalEvalDrop: number;
  worstTier: MistakeTier;
  score: number;
  sampleGameNames: string[];
}

interface DeviationMatch {
  parentNode: TreeNode;
  deviationIndex: number | null;
}

interface GroupedOccurrence {
  gameId: string;
  gameName: string;
  tier: MistakeTier;
  evalDrop: number;
  lineKey: string;
  line: string[];
}

interface RecommendationAccumulator {
  key: string;
  parentNodeId: string;
  parentFen: string;
  startMoveNumber: number;
  triggerMove: string;
  occurrencesByGame: Map<string, GroupedOccurrence>;
}

const TIER_WEIGHTS: Record<MistakeTier, number> = {
  inaccuracy: 1,
  mistake: 2,
  blunder: 3,
};

const TIER_ORDER: Record<MistakeTier, number> = {
  inaccuracy: 0,
  mistake: 1,
  blunder: 2,
};

function getMistakePlyIndex(side: 'white' | 'black', moveNumber: number): number {
  return (moveNumber - 1) * 2 + (side === 'black' ? 1 : 0);
}

function findFirstDeviationUpToPly(
  root: TreeNode,
  moves: string[],
  maxPlyIndex: number
): DeviationMatch {
  let current = root;

  for (let i = 0; i <= maxPlyIndex && i < moves.length; i += 1) {
    const next = current.children.find(
      (child) => !(child as any)._isOverlay && child.move === moves[i]
    );
    if (!next) {
      return {
        parentNode: current,
        deviationIndex: i,
      };
    }
    current = next;
  }

  return {
    parentNode: current,
    deviationIndex: null,
  };
}

function buildSuggestedLine(
  moves: string[],
  deviationIndex: number,
  mistakePlyIndex: number,
  maxLinePlies: number
): string[] {
  const preferredLength = mistakePlyIndex - deviationIndex + 2;
  const lineLength = Math.max(1, Math.min(maxLinePlies, preferredLength));
  return moves.slice(deviationIndex, deviationIndex + lineLength);
}

function occurrenceWeight(tier: MistakeTier, evalDrop: number): number {
  return TIER_WEIGHTS[tier] + evalDrop;
}

export function buildImportantLineRecommendations(
  root: TreeNode,
  games: ImportedGame[],
  repertoireColor: 'white' | 'black',
  maxLinePlies: number = 4
): ImportantLineRecommendation[] {
  const grouped = new Map<string, RecommendationAccumulator>();

  for (const game of games) {
    if (!game.analyzed || game.mistakes.length === 0) continue;

    for (const mistake of game.mistakes) {
      if (mistake.side !== repertoireColor) continue;

      const mistakePlyIndex = getMistakePlyIndex(mistake.side, mistake.moveNumber);
      if (mistakePlyIndex < 0 || mistakePlyIndex >= game.moves.length) continue;

      const { parentNode, deviationIndex } = findFirstDeviationUpToPly(
        root,
        game.moves,
        mistakePlyIndex
      );

      // If the entire line up to the mistake already exists in the repertoire,
      // this is a review issue rather than a missing-line issue.
      if (deviationIndex === null) continue;

      const line = buildSuggestedLine(game.moves, deviationIndex, mistakePlyIndex, maxLinePlies);
      const triggerMove = line[0];
      if (!triggerMove) continue;

      const key = `${parentNode.fen}::${triggerMove}`;
      const lineKey = line.join(' ');
      const gameName = `${game.white} vs ${game.black}`;

      let bucket = grouped.get(key);
      if (!bucket) {
        bucket = {
          key,
          parentNodeId: parentNode.id,
          parentFen: parentNode.fen,
          startMoveNumber: Math.floor(deviationIndex / 2) + 1,
          triggerMove,
          occurrencesByGame: new Map<string, GroupedOccurrence>(),
        };
        grouped.set(key, bucket);
      }

      const existing = bucket.occurrencesByGame.get(game.id);
      const candidateWeight = occurrenceWeight(mistake.tier, mistake.evalDrop);
      const existingWeight = existing
        ? occurrenceWeight(existing.tier, existing.evalDrop)
        : -Infinity;

      if (!existing || candidateWeight > existingWeight) {
        bucket.occurrencesByGame.set(game.id, {
          gameId: game.id,
          gameName,
          tier: mistake.tier,
          evalDrop: mistake.evalDrop,
          lineKey,
          line,
        });
      }
    }
  }

  return Array.from(grouped.values())
    .map((bucket) => {
      const occurrences = Array.from(bucket.occurrencesByGame.values());
      const gamesCount = occurrences.length;
      const mistakeCount = occurrences.length;
      const totalEvalDrop = occurrences.reduce((sum, item) => sum + item.evalDrop, 0);
      const averageEvalDrop = gamesCount > 0 ? totalEvalDrop / gamesCount : 0;

      const lineCounts = new Map<string, { line: string[]; count: number }>();
      for (const occurrence of occurrences) {
        const existing = lineCounts.get(occurrence.lineKey);
        if (existing) {
          existing.count += 1;
        } else {
          lineCounts.set(occurrence.lineKey, {
            line: occurrence.line,
            count: 1,
          });
        }
      }

      const line =
        Array.from(lineCounts.values())
          .sort((a, b) => b.count - a.count || a.line.length - b.line.length)[0]
          ?.line ?? [bucket.triggerMove];

      const worstTier = occurrences.reduce<MistakeTier>(
        (worst, item) =>
          TIER_ORDER[item.tier] > TIER_ORDER[worst] ? item.tier : worst,
        'inaccuracy'
      );

      const severityScore = occurrences.reduce(
        (sum, item) => sum + occurrenceWeight(item.tier, item.evalDrop),
        0
      );
      const earlinessFactor = 1 + Math.max(0, 12 - bucket.startMoveNumber) * 0.06;
      const score = severityScore * earlinessFactor;

      return {
        key: bucket.key,
        parentNodeId: bucket.parentNodeId,
        parentFen: bucket.parentFen,
        startMoveNumber: bucket.startMoveNumber,
        triggerMove: bucket.triggerMove,
        line,
        gamesCount,
        mistakeCount,
        averageEvalDrop,
        totalEvalDrop,
        worstTier,
        score,
        sampleGameNames: occurrences.slice(0, 3).map((item) => item.gameName),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.gamesCount !== a.gamesCount) return b.gamesCount - a.gamesCount;
      if (b.averageEvalDrop !== a.averageEvalDrop) return b.averageEvalDrop - a.averageEvalDrop;
      return a.triggerMove.localeCompare(b.triggerMove);
    });
}
