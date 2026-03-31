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

export interface SRLastSessionStats {
  totalReviewed: number;
  totalCorrect: number;
  completedAt: number | null;
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

const LAST_SESSION_KEY = 'aic_sr_last_session_stats';

export function loadLastSessionStats(): SRLastSessionStats | null {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SRLastSessionStats;
    if (
      typeof parsed.totalReviewed !== 'number' ||
      typeof parsed.totalCorrect !== 'number' ||
      (parsed.completedAt !== null && typeof parsed.completedAt !== 'number')
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveSessionStats(
  correct: number,
  incorrect: number,
): { lifetime: SRLifetimeStats; lastSession: SRLastSessionStats } {
  const prev = loadStats();
  const totalReviewed = correct + incorrect;
  const updated: SRLifetimeStats = {
    totalReviewed: prev.totalReviewed + totalReviewed,
    totalCorrect: prev.totalCorrect + correct,
  };
  localStorage.setItem(STATS_KEY, JSON.stringify(updated));
  const lastSession: SRLastSessionStats = {
    totalReviewed,
    totalCorrect: correct,
    completedAt: Date.now(),
  };
  localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(lastSession));
  return { lifetime: updated, lastSession };
}
