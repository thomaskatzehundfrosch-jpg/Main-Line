import { parsePgnMoves, type RawFetchedGame } from './chessComFetcher';
import type { RepertoireFile } from '../types/repertoireFile';
import type { TreeNode } from '../types';

export type PerformanceResult = 'win' | 'loss' | 'draw';

export interface PerformanceGame {
  id: string;
  raw: RawFetchedGame;
  moves: string[];
  playerColor: 'white' | 'black';
  result: PerformanceResult;
  endedAt: number;
}

export interface RepertoirePerformanceSummary {
  file: RepertoireFile;
  matchedGames: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  averageMatchedMoves: number;
  deepestMatchMoves: number;
  linePreview: string[];
}

export interface MatchedPerformanceGame {
  game: PerformanceGame;
  fileId: string;
  matchedMovesCount: number;
  matchedMoves: string[];
  deviationMove: string | null;
  endPhase: GamePhase;
}

export interface RepertoirePerformanceDetail {
  summary: RepertoirePerformanceSummary;
  games: MatchedPerformanceGame[];
  commonDeviationMoves: Array<{ move: string; count: number }>;
  stageResults: Array<{
    phase: GamePhase;
    wins: number;
    draws: number;
    losses: number;
    total: number;
  }>;
}

export interface PerformanceReportData {
  summaries: RepertoirePerformanceSummary[];
  matchedGames: MatchedPerformanceGame[];
  detailsByFileId: Record<string, RepertoirePerformanceDetail>;
}

interface MatchResult {
  matchedPlies: number;
  finalNode: TreeNode;
}

export type GamePhase = 'opening' | 'middlegame' | 'endgame';

const DRAW_RESULTS = new Set([
  'agreed',
  'stalemate',
  'repetition',
  'insufficient',
  'timevsinsufficient',
  '50move',
  'draw',
]);

function normalizeResult(result: string | undefined): PerformanceResult | null {
  if (!result) return null;
  if (result === 'win') return 'win';
  if (DRAW_RESULTS.has(result)) return 'draw';
  return 'loss';
}

function classifyGamePhase(moveCount: number): GamePhase {
  if (moveCount <= 10) return 'opening';
  if (moveCount <= 30) return 'middlegame';
  return 'endgame';
}

function toMoveCount(plies: number): number {
  return Math.floor(plies / 2);
}

function getLinePreview(root: TreeNode, limit: number = 16): string[] {
  const moves: string[] = [];
  let current = root;

  while (moves.length < limit && current.children.length === 1) {
    const [next] = current.children;
    if (!next?.move) {
      break;
    }
    moves.push(next.move);
    current = next;
  }

  return moves;
}

export function toPerformanceGames(
  rawGames: RawFetchedGame[],
  username: string
): PerformanceGame[] {
  const normalizedUsername = username.trim().toLowerCase();

  return rawGames.flatMap((raw, index) => {
    const whiteName = raw.white?.username?.toLowerCase() ?? '';
    const blackName = raw.black?.username?.toLowerCase() ?? '';
    const playerColor =
      whiteName === normalizedUsername
        ? 'white'
        : blackName === normalizedUsername
          ? 'black'
          : null;

    if (!playerColor || !raw.pgn) return [];

    const resultToken = playerColor === 'white' ? raw.white?.result : raw.black?.result;
    const result = normalizeResult(resultToken);
    if (!result) return [];

    const moves = parsePgnMoves(raw.pgn);
    if (moves.length === 0) return [];

    return [{
      id: `${raw.source}_${raw.end_time}_${index}`,
      raw,
      moves,
      playerColor,
      result,
      endedAt: raw.end_time ?? 0,
    }];
  });
}

function matchMovesToTree(moves: string[], root: TreeNode): MatchResult {
  let current = root;
  let matchedPlies = 0;

  for (const san of moves) {
    const next = current.children.find((child) => child.move === san);
    if (!next) break;
    current = next;
    matchedPlies += 1;
  }

  return { matchedPlies, finalNode: current };
}

export function buildPerformanceReport(
  files: RepertoireFile[],
  games: PerformanceGame[],
  minMatchPlies: number
): PerformanceReportData {
  const tallies = new Map<string, {
    file: RepertoireFile;
    matchedGames: number;
    wins: number;
    draws: number;
    losses: number;
    totalMatchedPlies: number;
    deepestMatch: number;
  }>();

  for (const file of files) {
    tallies.set(file.id, {
      file,
      matchedGames: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      totalMatchedPlies: 0,
      deepestMatch: 0,
    });
  }

  const matchedAssignments: MatchedPerformanceGame[] = [];

  for (const game of games) {
    let bestFile: RepertoireFile | null = null;
    let bestMatch: MatchResult | null = null;
    let bestMatchCount = 0;

    for (const file of files) {
      const match = matchMovesToTree(game.moves, file.tree);
      if (match.matchedPlies < minMatchPlies) continue;

      if (!bestMatch || match.matchedPlies > bestMatch.matchedPlies) {
        bestFile = file;
        bestMatch = match;
        bestMatchCount = 1;
      } else if (bestMatch && match.matchedPlies === bestMatch.matchedPlies) {
        bestMatchCount += 1;
      }
    }

    if (!bestFile || !bestMatch || bestMatchCount !== 1) continue;

    const tally = tallies.get(bestFile.id);
    if (!tally) continue;

    matchedAssignments.push({
      game,
      fileId: bestFile.id,
      matchedMovesCount: toMoveCount(bestMatch.matchedPlies),
      matchedMoves: game.moves.slice(0, bestMatch.matchedPlies),
      deviationMove: game.moves[bestMatch.matchedPlies] ?? null,
      endPhase: classifyGamePhase(toMoveCount(game.moves.length)),
    });

    tally.matchedGames += 1;
    tally.totalMatchedPlies += bestMatch.matchedPlies;
    tally.deepestMatch = Math.max(tally.deepestMatch, bestMatch.matchedPlies);

    if (game.result === 'win') tally.wins += 1;
    else if (game.result === 'draw') tally.draws += 1;
    else tally.losses += 1;
  }

  const summaries = files.map((file) => {
    const tally = tallies.get(file.id)!;
    return {
      file,
      matchedGames: tally.matchedGames,
      wins: tally.wins,
      draws: tally.draws,
      losses: tally.losses,
      winRate: tally.matchedGames > 0 ? (tally.wins / tally.matchedGames) * 100 : 0,
      averageMatchedMoves:
        tally.matchedGames > 0 ? tally.totalMatchedPlies / tally.matchedGames / 2 : 0,
      deepestMatchMoves: toMoveCount(tally.deepestMatch),
      linePreview: getLinePreview(file.tree),
    };
  });

  const detailsByFileId = Object.fromEntries(
    summaries.map((summary) => {
      const gamesForFile = matchedAssignments
        .filter((assignment) => assignment.fileId === summary.file.id)
        .sort((a, b) => b.game.endedAt - a.game.endedAt);

      const deviationCounts = new Map<string, number>();
      for (const assignment of gamesForFile) {
        const key = assignment.deviationMove ?? 'Followed full matched line';
        deviationCounts.set(key, (deviationCounts.get(key) ?? 0) + 1);
      }

      const commonDeviationMoves = Array.from(deviationCounts.entries())
        .map(([move, count]) => ({ move, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      const stageTallies: Record<GamePhase, { wins: number; draws: number; losses: number; total: number }> = {
        opening: { wins: 0, draws: 0, losses: 0, total: 0 },
        middlegame: { wins: 0, draws: 0, losses: 0, total: 0 },
        endgame: { wins: 0, draws: 0, losses: 0, total: 0 },
      };

      for (const assignment of gamesForFile) {
        const tally = stageTallies[assignment.endPhase];
        tally.total += 1;
        if (assignment.game.result === 'win') tally.wins += 1;
        else if (assignment.game.result === 'draw') tally.draws += 1;
        else tally.losses += 1;
      }

      return [summary.file.id, {
        summary,
        games: gamesForFile,
        commonDeviationMoves,
        stageResults: (['opening', 'middlegame', 'endgame'] as GamePhase[]).map((phase) => ({
          phase,
          ...stageTallies[phase],
        })),
      }];
    })
  ) as Record<string, RepertoirePerformanceDetail>;

  return {
    summaries,
    matchedGames: matchedAssignments,
    detailsByFileId,
  };
}
