/**
 * PGN seed parser and export for the generator.
 * Handles parsing PGN text into move sequences and exporting generator trees to PGN.
 */

import { Chess } from 'chess.js';
import type { GeneratorNode } from '../types/generator';

type LogFn = (level: 'info' | 'warning' | 'error', message: string) => void;

/**
 * Parse a PGN text string into an array of move sequences.
 * Each sequence is an array of SAN moves representing one game/variation line.
 */
export function parsePGN(pgnText: string, logError?: LogFn): string[][] {
  if (!pgnText || !pgnText.trim()) return [];

  const sequences: string[][] = [];

  // Split into individual games (separated by double newlines before headers)
  const games = splitGames(pgnText);

  for (const gameText of games) {
    try {
      const lines = extractMainAndVariations(gameText);
      for (const line of lines) {
        if (line.length > 0) {
          sequences.push(line);
        }
      }
    } catch (err: any) {
      if (logError) {
        logError('warning', `Failed to parse PGN game: ${err.message}`);
      }
    }
  }

  return sequences;
}

/**
 * Split multi-game PGN text into individual game strings.
 */
function splitGames(text: string): string[] {
  // Split on lines that start with [Event or [White etc. after a blank line
  const games: string[] = [];
  const lines = text.split('\n');
  let current: string[] = [];

  for (const line of lines) {
    if (line.match(/^\[Event\s/) && current.length > 0) {
      const joined = current.join('\n').trim();
      if (joined) games.push(joined);
      current = [];
    }
    current.push(line);
  }

  const joined = current.join('\n').trim();
  if (joined) games.push(joined);

  return games.length > 0 ? games : [text];
}

/**
 * Extract main line and variations from a single PGN game.
 * Returns an array of move sequences (main line + variations).
 */
function extractMainAndVariations(gameText: string): string[][] {
  // Strip headers
  const moveText = gameText
    .replace(/\[[^\]]*\]\s*/g, '')
    .replace(/\{[^}]*\}/g, '')  // strip comments
    .replace(/\$\d+/g, '')       // strip NAGs
    .trim();

  if (!moveText) return [];

  const tokens = tokenize(moveText);
  const allSequences: string[][] = [];
  parseTokens(tokens, 0, [], allSequences);
  return allSequences;
}

interface Token {
  type: 'move' | 'var_start' | 'var_end' | 'result';
  value: string;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // Remove move numbers
  const cleaned = text.replace(/\d+\.+/g, ' ').replace(/\s+/g, ' ').trim();

  for (const word of cleaned.split(' ')) {
    const trimmed = word.trim();
    if (!trimmed) continue;

    if (trimmed === '(') {
      tokens.push({ type: 'var_start', value: '(' });
    } else if (trimmed === ')') {
      tokens.push({ type: 'var_end', value: ')' });
    } else if (['1-0', '0-1', '1/2-1/2', '*'].includes(trimmed)) {
      tokens.push({ type: 'result', value: trimmed });
    } else if (trimmed.match(/^[a-hKQRBNO]/)) {
      // Looks like a move
      tokens.push({ type: 'move', value: trimmed.replace(/[+#?!]+$/, '') });
    }
  }

  return tokens;
}

function parseTokens(
  tokens: Token[],
  pos: number,
  currentLine: string[],
  allSequences: string[][]
): number {
  while (pos < tokens.length) {
    const token = tokens[pos];

    if (token.type === 'move') {
      currentLine.push(token.value);
      pos++;
    } else if (token.type === 'var_start') {
      // Start of variation — fork from one move back
      const branchPoint = currentLine.slice(0, -1);
      pos = parseTokens(tokens, pos + 1, [...branchPoint], allSequences);
    } else if (token.type === 'var_end') {
      // End of variation — save and return
      if (currentLine.length > 0) {
        allSequences.push([...currentLine]);
      }
      return pos + 1;
    } else if (token.type === 'result') {
      pos++;
    } else {
      pos++;
    }
  }

  // End of tokens — save main line
  if (currentLine.length > 0) {
    allSequences.push([...currentLine]);
  }

  return pos;
}

/**
 * Export a GeneratorNode tree to PGN format with annotations.
 */
export function exportGeneratorPGN(
  tree: GeneratorNode,
  settings: { color: string },
  withAnnotations: boolean = true
): string {
  const headers = [
    '[Event "Generated Repertoire"]',
    `[Site "Main Line"]`,
    `[Date "${new Date().toISOString().split('T')[0].replace(/-/g, '.')}"]`,
    `[White "${settings.color === 'white' ? 'Repertoire' : '?'}"]`,
    `[Black "${settings.color === 'black' ? 'Repertoire' : '?'}"]`,
    '[Result "*"]',
    '',
  ];

  const moveText = buildPGNMoves(tree, withAnnotations, false);
  return headers.join('\n') + moveText + ' *\n';
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
  const variations = node.children.slice(1);

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

  if (node.isDangerous) {
    parts.push('⚠ dangerous');
  }

  return parts.join(' | ');
}
