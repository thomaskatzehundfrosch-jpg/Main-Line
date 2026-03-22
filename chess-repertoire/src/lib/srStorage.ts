/**
 * localStorage persistence layer for spaced repetition cards.
 */

import type { Card } from './srScheduler';

const STORAGE_KEY = 'aic_sr_cards';

/**
 * Load all cards from localStorage.
 * Returns an empty array on any parse or read error.
 */
export function loadCards(): Card[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Card[];
  } catch {
    return [];
  }
}

/**
 * Overwrite the entire card collection in localStorage.
 */
export function saveCards(cards: Card[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
}

/**
 * Merge new cards into the existing collection (no duplicates by id).
 * Saves and returns the merged array.
 */
export function addCards(newCards: Card[]): Card[] {
  const existing = loadCards();
  const existingIds = new Set(existing.map((c) => c.id));
  const merged = [
    ...existing,
    ...newCards.filter((c) => !existingIds.has(c.id)),
  ];
  saveCards(merged);
  return merged;
}

/**
 * Remove a card by id. Saves and returns the updated array.
 */
export function deleteCard(id: string): Card[] {
  const cards = loadCards().filter((c) => c.id !== id);
  saveCards(cards);
  return cards;
}

/**
 * Remove all cards from localStorage entirely.
 */
export function clearAllCards(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// ─── Lifetime accuracy stats ───────────────────────────────────────────

const STATS_KEY = 'aic_sr_stats';

export interface SRLifetimeStats {
  totalReviewed: number;
  totalCorrect: number;
}

export function loadStats(): SRLifetimeStats {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return { totalReviewed: 0, totalCorrect: 0 };
    const parsed = JSON.parse(raw) as SRLifetimeStats;
    if (
      typeof parsed.totalReviewed !== 'number' ||
      typeof parsed.totalCorrect !== 'number'
    ) {
      return { totalReviewed: 0, totalCorrect: 0 };
    }
    return parsed;
  } catch {
    return { totalReviewed: 0, totalCorrect: 0 };
  }
}

export function saveSessionStats(correct: number, incorrect: number): SRLifetimeStats {
  const prev = loadStats();
  const updated: SRLifetimeStats = {
    totalReviewed: prev.totalReviewed + correct + incorrect,
    totalCorrect: prev.totalCorrect + correct,
  };
  localStorage.setItem(STATS_KEY, JSON.stringify(updated));
  return updated;
}
