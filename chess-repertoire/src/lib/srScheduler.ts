/**
 * SM-2 Spaced Repetition Scheduler
 *
 * Implements the SuperMemo-2 algorithm adapted for chess opening training.
 * Cards represent positions (FEN) paired with the correct response (UCI move).
 */

export interface Card {
  id: string;
  front: string;              // FEN position
  back: string;               // Correct move in UCI notation (e.g. "e2e4")
  interval: number;           // Days until next review (default 1)
  repetitions: number;        // Consecutive correct reviews (default 0)
  easeFactor: number;         // Difficulty multiplier (default 2.5)
  dueDate: number;            // Timestamp when card is next due (default Date.now())
  lastReviewed: number | null;
  lineName?: string;          // Optional opening line label
}

/**
 * Review quality grade.
 * 0 = blackout (complete failure), 1 = hard, 2 = good, 3 = easy
 */
export type ReviewGrade = 0 | 1 | 2 | 3;

/**
 * Update a card's scheduling parameters after a review using the SM-2 algorithm.
 *
 * If grade < 2 the card is "failed": repetitions reset to 0, interval reset to 1.
 * If grade >= 2 the standard SM-2 interval progression applies:
 *   rep 0 → 1 day, rep 1 → 6 days, rep 2+ → interval × easeFactor.
 *
 * The ease factor is adjusted using the classic SM-2 formula, with our 0-3 grade
 * scale mapped linearly onto the original 0-5 quality scale.
 */
export function reviewCard(card: Card, grade: ReviewGrade): Card {
  let { interval, repetitions, easeFactor } = card;

  if (grade < 2) {
    // Failed — reset
    repetitions = 0;
    interval = 1;
  } else {
    // Passed — standard SM-2 interval progression
    if (repetitions === 0) {
      interval = 1;
    } else if (repetitions === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * easeFactor);
    }
    repetitions += 1;
  }

  // Adjust ease factor (SM-2 formula mapped from 0-3 → 0-5 scale)
  const q = grade * (5 / 3);
  easeFactor = easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  easeFactor = Math.max(1.3, easeFactor);

  const now = Date.now();
  const dueDate = now + interval * 24 * 60 * 60 * 1000;

  return {
    ...card,
    interval,
    repetitions,
    easeFactor,
    dueDate,
    lastReviewed: now,
  };
}

/**
 * Return cards that are currently due for review, sorted by due date ascending.
 * @param limit Maximum number of cards to return (default 20)
 */
export function getDueCards(cards: Card[], limit: number = 20): Card[] {
  const now = Date.now();
  return cards
    .filter((card) => card.dueDate <= now)
    .sort((a, b) => a.dueDate - b.dueDate)
    .slice(0, limit);
}

/**
 * Create a new review card for a chess position.
 * @param fen     The FEN string of the position to drill
 * @param moveUci The correct response in UCI notation (e.g. "e2e4")
 * @param lineName Optional label for the opening line
 */
export function createCard(fen: string, moveUci: string, lineName?: string): Card {
  return {
    id: crypto.randomUUID(),
    front: fen,
    back: moveUci,
    interval: 1,
    repetitions: 0,
    easeFactor: 2.5,
    dueDate: Date.now(),
    lastReviewed: null,
    lineName,
  };
}
