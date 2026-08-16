#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { parse } from '@mliebelt/pgn-parser';

const DEFAULT_HUMAN = 'benchmarks/evans-gambit.pgn';

function usage() {
  return [
    'Usage:',
    '  npm run benchmark:evans -- --generated path/to/generated.pgn',
    '  node scripts/compare-repertoire.mjs --human benchmarks/evans-gambit.pgn --generated path/to/generated.pgn',
    '',
    'Without --generated, prints a summary of the human benchmark only.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    human: DEFAULT_HUMAN,
    generated: null,
    maxDepth: Infinity,
    strict: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--human') args.human = argv[++i];
    else if (arg === '--generated') args.generated = argv[++i];
    else if (arg === '--max-depth') args.maxDepth = Number(argv[++i]);
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function readPgn(filePath) {
  const absolute = path.resolve(filePath);
  return fs.readFileSync(absolute, 'utf8');
}

function parseGames(pgnText, label) {
  try {
    const games = parse(pgnText, { startRule: 'games' });
    return Array.isArray(games) ? games : [games];
  } catch (error) {
    throw new Error(`Could not parse ${label} PGN: ${error.message}`);
  }
}

function normalizeSan(san) {
  return san.replace(/[?!]+$/g, '');
}

function emptyEntry(fen, ply) {
  return {
    fen,
    ply,
    sideToMove: fen.split(' ')[1] === 'w' ? 'white' : 'black',
    moves: new Set(),
  };
}

function addMove(positionMap, fen, ply, san) {
  if (!positionMap.has(fen)) positionMap.set(fen, emptyEntry(fen, ply));
  positionMap.get(fen).moves.add(normalizeSan(san));
}

function walkMoves(moves, chess, positionMap, ply) {
  let currentPly = ply;

  for (const moveObj of moves ?? []) {
    const san = moveObj.notation?.notation;
    if (!san) continue;

    const beforeFen = chess.fen();
    addMove(positionMap, beforeFen, currentPly, san);

    for (const variation of moveObj.variations ?? []) {
      walkMoves(variation, new Chess(beforeFen), positionMap, currentPly);
    }

    try {
      chess.move(san);
      currentPly++;
    } catch {
      // Keep the rest of the benchmark usable even if one imported PGN move
      // has notation the parser/chess.js pair cannot replay.
      return;
    }
  }
}

function buildPositionMap(games) {
  const positionMap = new Map();
  for (const game of games) {
    walkMoves(game.moves ?? [], new Chess(), positionMap, 0);
  }
  return positionMap;
}

function sortedMoves(entry) {
  return [...entry.moves].sort((a, b) => a.localeCompare(b));
}

function filterEntries(positionMap, maxDepth) {
  return [...positionMap.values()]
    .filter((entry) => entry.ply <= maxDepth)
    .sort((a, b) => a.ply - b.ply || a.fen.localeCompare(b.fen));
}

function summarizeBenchmark(name, positionMap, maxDepth) {
  const entries = filterEntries(positionMap, maxDepth);
  const moveCount = entries.reduce((sum, entry) => sum + entry.moves.size, 0);
  const whiteEntries = entries.filter((entry) => entry.sideToMove === 'white').length;
  const blackEntries = entries.length - whiteEntries;
  const maxPly = entries.reduce((max, entry) => Math.max(max, entry.ply), 0);

  return {
    name,
    positions: entries.length,
    whiteToMovePositions: whiteEntries,
    blackToMovePositions: blackEntries,
    expectedMoves: moveCount,
    maxPly,
  };
}

function compareMaps(humanMap, generatedMap, maxDepth) {
  const humanEntries = filterEntries(humanMap, maxDepth);
  const result = {
    positions: humanEntries.length,
    exactPositionMatches: 0,
    moveMatches: 0,
    expectedMoves: 0,
    whiteMoveMatches: 0,
    whiteExpectedMoves: 0,
    blackMoveMatches: 0,
    blackExpectedMoves: 0,
    missingCritical: [],
    missingPositions: [],
    extraMovesAtKnownPositions: [],
  };

  for (const humanEntry of humanEntries) {
    const generatedEntry = generatedMap.get(humanEntry.fen);
    const humanMoves = sortedMoves(humanEntry);
    result.expectedMoves += humanMoves.length;

    if (humanEntry.sideToMove === 'white') result.whiteExpectedMoves += humanMoves.length;
    else result.blackExpectedMoves += humanMoves.length;

    if (!generatedEntry) {
      result.missingPositions.push({
        ply: humanEntry.ply,
        sideToMove: humanEntry.sideToMove,
        fen: humanEntry.fen,
        expected: humanMoves,
      });
      continue;
    }

    const generatedMoves = sortedMoves(generatedEntry);
    const matches = humanMoves.filter((move) => generatedEntry.moves.has(move));
    result.moveMatches += matches.length;
    if (humanEntry.sideToMove === 'white') result.whiteMoveMatches += matches.length;
    else result.blackMoveMatches += matches.length;

    if (
      matches.length === humanMoves.length &&
      generatedMoves.every((move) => humanEntry.moves.has(move))
    ) {
      result.exactPositionMatches++;
    }

    const missing = humanMoves.filter((move) => !generatedEntry.moves.has(move));
    if (missing.length > 0) {
      result.missingCritical.push({
        ply: humanEntry.ply,
        sideToMove: humanEntry.sideToMove,
        fen: humanEntry.fen,
        expected: humanMoves,
        generated: generatedMoves,
        missing,
      });
    }

    const extra = generatedMoves.filter((move) => !humanEntry.moves.has(move));
    if (extra.length > 0) {
      result.extraMovesAtKnownPositions.push({
        ply: humanEntry.ply,
        sideToMove: humanEntry.sideToMove,
        fen: humanEntry.fen,
        expected: humanMoves,
        generated: generatedMoves,
        extra,
      });
    }
  }

  return result;
}

function pct(numerator, denominator) {
  if (denominator === 0) return 'n/a';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function printSummary(summary) {
  console.log(`${summary.name}:`);
  console.log(`  positions: ${summary.positions}`);
  console.log(`  expected moves: ${summary.expectedMoves}`);
  console.log(`  white-to-move positions: ${summary.whiteToMovePositions}`);
  console.log(`  black-to-move positions: ${summary.blackToMovePositions}`);
  console.log(`  max ply: ${summary.maxPly}`);
}

function printComparison(comparison) {
  console.log('Comparison:');
  console.log(`  position exact matches: ${comparison.exactPositionMatches}/${comparison.positions} (${pct(comparison.exactPositionMatches, comparison.positions)})`);
  console.log(`  move coverage: ${comparison.moveMatches}/${comparison.expectedMoves} (${pct(comparison.moveMatches, comparison.expectedMoves)})`);
  console.log(`  white repertoire move coverage: ${comparison.whiteMoveMatches}/${comparison.whiteExpectedMoves} (${pct(comparison.whiteMoveMatches, comparison.whiteExpectedMoves)})`);
  console.log(`  opponent reply coverage: ${comparison.blackMoveMatches}/${comparison.blackExpectedMoves} (${pct(comparison.blackMoveMatches, comparison.blackExpectedMoves)})`);
  console.log(`  missing positions: ${comparison.missingPositions.length}`);
  console.log(`  positions with missing human moves: ${comparison.missingCritical.length}`);
  console.log(`  known positions with extra generated moves: ${comparison.extraMovesAtKnownPositions.length}`);
}

function printExamples(title, entries, limit = 12) {
  if (entries.length === 0) return;
  console.log('');
  console.log(`${title}:`);
  for (const entry of entries.slice(0, limit)) {
    console.log(`  ply ${entry.ply} ${entry.sideToMove} ${entry.fen}`);
    console.log(`    expected: ${entry.expected.join(', ') || '-'}`);
    if (entry.generated) console.log(`    generated: ${entry.generated.join(', ') || '-'}`);
    if (entry.missing) console.log(`    missing: ${entry.missing.join(', ')}`);
    if (entry.extra) console.log(`    extra: ${entry.extra.join(', ')}`);
  }
  if (entries.length > limit) console.log(`  ... ${entries.length - limit} more`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const humanGames = parseGames(readPgn(args.human), args.human);
  const humanMap = buildPositionMap(humanGames);

  printSummary(summarizeBenchmark('Human benchmark', humanMap, args.maxDepth));

  if (!args.generated) {
    console.log('');
    console.log('No generated PGN supplied yet. Export a generated repertoire PGN, then run:');
    console.log(`  npm run benchmark:evans -- --generated path/to/generated.pgn`);
    return;
  }

  const generatedGames = parseGames(readPgn(args.generated), args.generated);
  const generatedMap = buildPositionMap(generatedGames);
  console.log('');
  printSummary(summarizeBenchmark('Generated repertoire', generatedMap, args.maxDepth));

  const comparison = compareMaps(humanMap, generatedMap, args.maxDepth);
  console.log('');
  printComparison(comparison);
  printExamples('Missing human moves', comparison.missingCritical);
  printExamples('Missing human positions', comparison.missingPositions);
  printExamples('Extra generated moves at known human positions', comparison.extraMovesAtKnownPositions, 8);

  if (args.strict && comparison.moveMatches < comparison.expectedMoves) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
