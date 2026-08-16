import { Chess } from 'chess.js';
import { parse } from '@mliebelt/pgn-parser';
import type { GeneratorNode } from '../types/generator';

export interface BenchmarkPosition {
  fen: string;
  ply: number;
  sideToMove: 'white' | 'black';
  moves: Set<string>;
}

export interface BenchmarkMoveIssue {
  ply: number;
  sideToMove: 'white' | 'black';
  fen: string;
  expected: string[];
  generated: string[];
  missing?: string[];
  extra?: string[];
}

export interface BenchmarkSummary {
  positions: number;
  whiteToMovePositions: number;
  blackToMovePositions: number;
  expectedMoves: number;
  maxPly: number;
}

export interface RepertoireBenchmarkResult {
  human: BenchmarkSummary;
  generated: BenchmarkSummary;
  exactPositionMatches: number;
  moveMatches: number;
  expectedMoves: number;
  whiteMoveMatches: number;
  whiteExpectedMoves: number;
  blackMoveMatches: number;
  blackExpectedMoves: number;
  missingPositions: BenchmarkMoveIssue[];
  missingHumanMoves: BenchmarkMoveIssue[];
  extraGeneratedMoves: BenchmarkMoveIssue[];
}

interface ParsedMove {
  notation?: { notation?: string };
  variations?: ParsedMove[][];
}

interface ParsedGame {
  moves?: ParsedMove[];
}

function normalizeSan(san: string): string {
  return san.replace(/[?!]+$/g, '');
}

function emptyPosition(fen: string, ply: number): BenchmarkPosition {
  return {
    fen,
    ply,
    sideToMove: fen.split(' ')[1] === 'w' ? 'white' : 'black',
    moves: new Set(),
  };
}

function addMove(map: Map<string, BenchmarkPosition>, fen: string, ply: number, san: string): void {
  if (!map.has(fen)) map.set(fen, emptyPosition(fen, ply));
  map.get(fen)!.moves.add(normalizeSan(san));
}

function walkParsedMoves(
  moves: ParsedMove[] | undefined,
  chess: Chess,
  map: Map<string, BenchmarkPosition>,
  ply: number
): void {
  let currentPly = ply;

  for (const moveObj of moves ?? []) {
    const san = moveObj.notation?.notation;
    if (!san) continue;

    const beforeFen = chess.fen();
    addMove(map, beforeFen, currentPly, san);

    for (const variation of moveObj.variations ?? []) {
      walkParsedMoves(variation, new Chess(beforeFen), map, currentPly);
    }

    try {
      chess.move(san);
      currentPly += 1;
    } catch {
      return;
    }
  }
}

export function buildBenchmarkMapFromPgn(pgn: string): Map<string, BenchmarkPosition> {
  const parsed = parse(pgn, { startRule: 'games' }) as ParsedGame[] | ParsedGame;
  const games = Array.isArray(parsed) ? parsed : [parsed];
  const map = new Map<string, BenchmarkPosition>();

  for (const game of games) {
    walkParsedMoves(game.moves, new Chess(), map, 0);
  }

  return map;
}

export function buildBenchmarkMapFromGeneratorTree(
  tree: GeneratorNode | null
): Map<string, BenchmarkPosition> {
  const map = new Map<string, BenchmarkPosition>();
  if (!tree) return map;

  const visit = (node: GeneratorNode): void => {
    for (const child of node.children) {
      if (child.san) {
        addMove(map, node.fen, node.depth, child.san);
      }
      visit(child);
    }
  };

  visit(tree);
  return map;
}

function sortedMoves(entry: BenchmarkPosition): string[] {
  return [...entry.moves].sort((a, b) => a.localeCompare(b));
}

function sortedEntries(
  map: Map<string, BenchmarkPosition>,
  maxPly: number
): BenchmarkPosition[] {
  return [...map.values()]
    .filter((entry) => entry.ply <= maxPly)
    .sort((a, b) => a.ply - b.ply || a.fen.localeCompare(b.fen));
}

function summarize(map: Map<string, BenchmarkPosition>, maxPly: number): BenchmarkSummary {
  const entries = sortedEntries(map, maxPly);
  const whiteToMovePositions = entries.filter((entry) => entry.sideToMove === 'white').length;

  return {
    positions: entries.length,
    whiteToMovePositions,
    blackToMovePositions: entries.length - whiteToMovePositions,
    expectedMoves: entries.reduce((sum, entry) => sum + entry.moves.size, 0),
    maxPly: entries.reduce((max, entry) => Math.max(max, entry.ply), 0),
  };
}

export function compareBenchmarkMaps(
  humanMap: Map<string, BenchmarkPosition>,
  generatedMap: Map<string, BenchmarkPosition>,
  maxPly = Infinity
): RepertoireBenchmarkResult {
  const result: RepertoireBenchmarkResult = {
    human: summarize(humanMap, maxPly),
    generated: summarize(generatedMap, maxPly),
    exactPositionMatches: 0,
    moveMatches: 0,
    expectedMoves: 0,
    whiteMoveMatches: 0,
    whiteExpectedMoves: 0,
    blackMoveMatches: 0,
    blackExpectedMoves: 0,
    missingPositions: [],
    missingHumanMoves: [],
    extraGeneratedMoves: [],
  };

  for (const humanEntry of sortedEntries(humanMap, maxPly)) {
    const generatedEntry = generatedMap.get(humanEntry.fen);
    const expected = sortedMoves(humanEntry);
    result.expectedMoves += expected.length;

    if (humanEntry.sideToMove === 'white') result.whiteExpectedMoves += expected.length;
    else result.blackExpectedMoves += expected.length;

    if (!generatedEntry) {
      result.missingPositions.push({
        ply: humanEntry.ply,
        sideToMove: humanEntry.sideToMove,
        fen: humanEntry.fen,
        expected,
        generated: [],
      });
      continue;
    }

    const generated = sortedMoves(generatedEntry);
    const matches = expected.filter((move) => generatedEntry.moves.has(move));
    result.moveMatches += matches.length;

    if (humanEntry.sideToMove === 'white') result.whiteMoveMatches += matches.length;
    else result.blackMoveMatches += matches.length;

    if (
      matches.length === expected.length &&
      generated.every((move) => humanEntry.moves.has(move))
    ) {
      result.exactPositionMatches += 1;
    }

    const missing = expected.filter((move) => !generatedEntry.moves.has(move));
    if (missing.length > 0) {
      result.missingHumanMoves.push({
        ply: humanEntry.ply,
        sideToMove: humanEntry.sideToMove,
        fen: humanEntry.fen,
        expected,
        generated,
        missing,
      });
    }

    const extra = generated.filter((move) => !humanEntry.moves.has(move));
    if (extra.length > 0) {
      result.extraGeneratedMoves.push({
        ply: humanEntry.ply,
        sideToMove: humanEntry.sideToMove,
        fen: humanEntry.fen,
        expected,
        generated,
        extra,
      });
    }
  }

  return result;
}

export function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return (numerator / denominator) * 100;
}
