/**
 * PGN seed parser and export for the generator.
 * Handles parsing PGN text into move sequences and exporting generator trees to PGN.
 */

import { Chess } from 'chess.js';
import type { GeneratorNode } from '../types/generator';
import { sanitizePgnForParser } from './pgnSanitizer';
import { parseGames } from '@mliebelt/pgn-parser';
import type { PgnMove } from '@mliebelt/pgn-types';
import { buildSeedTree } from './generatorSeeds';
import { END_REASON_LABELS } from '../types/generator';

/** Parse all main lines and nested variations, validating SAN before loading. */
export function parsePGN(pgnText: string): string[][] {
  if (!pgnText.trim()) return [];
  const games = parseGames(sanitizePgnForParser(pgnText));
  const sequences: string[][] = [];
  for (const game of games) {
    if (game.tags?.FEN && game.tags.FEN !== new Chess().fen()) {
      throw new Error('PGNs starting from a custom FEN are not supported. Load lines from the standard starting position.');
    }
    const visit = (moves: PgnMove[], prefix: string[]) => {
      const mainLine = [...prefix, ...moves.map(move => move.notation.notation)];
      if (mainLine.length) sequences.push(mainLine);
      const line = [...prefix];
      for (const move of moves) {
        for (const variation of move.variations ?? []) visit(variation, line);
        line.push(move.notation.notation);
      }
    };
    visit(game.moves, []);
  }
  buildSeedTree(sequences, 'white');
  return [...new Map(sequences.map(line => [line.join(' '), line])).values()];
}

/**
 * Export a GeneratorNode tree to PGN format with annotations.
 */
export function exportGeneratorPGN(
  tree: GeneratorNode,
  settings: { color: string },
  withAnnotations: boolean = true
): string {
  const exportTree = tree;
  const headers = [
    '[Event "Generated Repertoire"]',
    `[Site "Main Line"]`,
    `[Date "${new Date().toISOString().split('T')[0].replace(/-/g, '.')}"]`,
    `[White "${settings.color === 'white' ? 'Repertoire' : '?'}"]`,
    `[Black "${settings.color === 'black' ? 'Repertoire' : '?'}"]`,
    '[Result "*"]',
    '',
  ];

  const moveText = buildPGNMoves(exportTree, withAnnotations, false);
  return headers.join('\n') + '\n' + moveText + ' *\n';
}

/**
 * Recursively build PGN move notation from a generator tree node.
 */
function buildPGNMoves(
  node: GeneratorNode,
  withAnnotations: boolean,
  forceBlackNumber: boolean
): string {
  if (!node.children || node.children.length === 0) return '';

  const mainChild = node.children[0];
  if (!isExportableSan(mainChild.san)) return '';

  const variations = node.children.slice(1).filter((child) => isExportableSan(child.san));

  let result = '';

  // Main move
  const isBlackMove = mainChild.fen.split(' ')[1] === 'w'; // after move, it's other side's turn
  const moveNum = mainChild.fullMoveNumber || 1;

  if (!isBlackMove) {
    // White just moved
    result += `${moveNum}. ${mainChild.san}`;
  } else if (forceBlackNumber || node.isRoot) {
    result += `${moveNum}... ${mainChild.san}`;
  } else {
    result += mainChild.san || '';
  }

  // Annotation comment
  if (withAnnotations) {
    const annotation = buildAnnotation(mainChild);
    if (annotation) result += ` {${annotation}}`;
  }

  // Variations (in parentheses)
  let hasVariations = false;
  for (const varChild of variations) {
    hasVariations = true;
    let varText = '';
    if (!isBlackMove) {
      varText += `${moveNum}. ${varChild.san}`;
    } else {
      varText += `${moveNum}... ${varChild.san}`;
    }

    if (withAnnotations) {
      const ann = buildAnnotation(varChild);
      if (ann) varText += ` {${ann}}`;
    }

    const continuation = buildPGNMoves(varChild, withAnnotations, false);
    if (continuation) varText += ' ' + continuation;

    result += ` (${varText})`;
  }

  // Continue main line
  const nextForceBlack = hasVariations || false;
  const mainContinuation = buildPGNMoves(mainChild, withAnnotations, nextForceBlack);
  if (mainContinuation) result += ' ' + mainContinuation;

  return result;
}

function isExportableSan(san: string | null): san is string {
  return Boolean(san && !/^[a-h]$/.test(san));
}

/**
 * Build an annotation comment for a node.
 */
function buildAnnotation(node: GeneratorNode): string {
  const parts: string[] = [];

  if (node.stockfish && node.stockfish.eval !== null) {
    const ev = node.stockfish.eval;
    const sign = ev >= 0 ? '+' : '';
    parts.push(`SF: ${sign}${ev.toFixed(2)}/d${node.stockfish.depth}`);
  }

  if (node.lichess && node.lichess.totalGames) {
    parts.push(`${node.lichess.totalGames}g`);
    if (node.lichess.winRate !== undefined) {
      parts.push(`W${Math.round(node.lichess.winRate)}%`);
    }
  }

  if (node.reason) parts.push(node.reason);
  if (node.warning) parts.push(node.warning);
  if (node.endReason) parts.push(END_REASON_LABELS[node.endReason]);
  return parts.join(' | ').replace(/[{}]/g, '');
}
