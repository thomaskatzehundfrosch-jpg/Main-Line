/**
 * Converts a repertoire tree into spaced-repetition cards.
 *
 * Walks every node in the tree. For each move that belongs to the player's
 * colour (determined by drillColor), a Card is created where:
 *   - front = the parent's FEN (the position the player must respond to)
 *   - back  = the move in UCI notation
 *   - lineName = the supplied repertoire file name
 */

import { Chess } from 'chess.js';
import type { TreeNode } from '../types';
import type { Card } from './srScheduler';
import { createCard } from './srScheduler';

export interface TreeImportResult {
  /** Cards that were newly created (not already in the existing set). */
  newCards: Card[];
  /** Existing cards upgraded with full move history. */
  updatedCards: Card[];
  /** How many tree positions matched the drill colour. */
  totalPositions: number;
  /** How many were skipped because an identical FEN+move already existed. */
  duplicatesSkipped: number;
}

/**
 * Extract drill cards from a repertoire tree.
 *
 * @param tree        Root TreeNode of the repertoire
 * @param drillColor  Which colour the player is training ('white' | 'black' | 'both')
 * @param lineName    Label to attach to every card (typically the repertoire file name)
 * @param existingCards Cards already in storage, used to skip duplicates by FEN+UCI
 */
export function treeToCards(
  tree: TreeNode,
  drillColor: 'white' | 'black' | 'both',
  lineName: string,
  existingCards: Card[] = [],
): TreeImportResult {
  // Build a set of existing (front, back) pairs for fast dedup
  const existingByKey = new Map(
    existingCards.map((c) => [`${c.front}|||${c.back}`, c] as const),
  );

  const newCards: Card[] = [];
  const updatedCards: Card[] = [];
  let totalPositions = 0;
  let duplicatesSkipped = 0;

  function traverse(node: TreeNode, parentFen: string | null, path: string[]): void {
    // For every non-root node, check if this move should become a card
    if (node.move !== '' && parentFen !== null) {
      const currentPath = [...path, node.move];
      // Whose turn was it in the parent position?
      const activeColor = parentFen.split(' ')[1]; // 'w' or 'b'
      const isPlayerMove =
        drillColor === 'both' ||
        (drillColor === 'white' && activeColor === 'w') ||
        (drillColor === 'black' && activeColor === 'b');

      if (isPlayerMove) {
        totalPositions++;

        // Convert SAN → UCI
        try {
          const chess = new Chess(parentFen);
          const move = chess.move(node.move);
          if (move) {
            const uci = move.from + move.to + (move.promotion || '');
            const key = `${parentFen}|||${uci}`;

            const existingCard = existingByKey.get(key);

            if (existingCard) {
              if (!existingCard.moveHistorySan || existingCard.moveHistorySan.length === 0) {
                const upgradedCard: Card = {
                  ...existingCard,
                  lineName: existingCard.lineName ?? lineName,
                  moveHistorySan: currentPath,
                  lineStartFen: existingCard.lineStartFen ?? tree.fen,
                };
                updatedCards.push(upgradedCard);
                existingByKey.set(key, upgradedCard);
              } else {
                duplicatesSkipped++;
              }
            } else {
              const newCard = createCard(parentFen, uci, lineName, currentPath, tree.fen);
              existingByKey.set(key, newCard);
              newCards.push(newCard);
            }
          }
        } catch {
          // Skip moves that chess.js can't parse (shouldn't happen in a valid tree)
        }
      }

      for (const child of node.children) {
        traverse(child, node.fen, currentPath);
      }
      return;
    }

    // Recurse into children
    for (const child of node.children) {
      traverse(child, node.fen, path);
    }
  }

  traverse(tree, null, []);

  return { newCards, updatedCards, totalPositions, duplicatesSkipped };
}
