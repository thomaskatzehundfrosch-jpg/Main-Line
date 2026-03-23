/**
 * Lichess Opening Explorer API client.
 * Handles API calls with throttling (~1 req/sec) and exponential backoff on 429.
 */

import type { GeneratorSettings, GeneratorLichessStats } from '../types/generator';
import { getStoredToken } from './lichessAuth';

/** Timestamp of last successful request start (for throttling). */
let _lastRequestTime = 0;

/** Minimum ms between API calls.
 *  The Opening Explorer endpoint is more permissive than the main API;
 *  200 ms (≈5 req/s) is safe. The exponential backoff handles any 429s. */
const THROTTLE_MS = 200;

/** Max retry attempts on 429 / network errors. */
const MAX_RETRIES = 5;

type LogFn = (level: 'info' | 'warning' | 'error', message: string) => void;

/**
 * Build the Lichess API URL for a given position and settings.
 */
export function buildLichessUrl(fen: string, settings: GeneratorSettings): string {
  const params = new URLSearchParams();
  params.set('fen', fen);
  params.set('moves', '12');

  if (settings.useMasters) {
    // Masters DB — no rating/speed filters, different endpoint
    return `https://explorer.lichess.ovh/masters?${params.toString().replace(/\+/g, '%20')}`;
  }

  const base = 'https://explorer.lichess.ovh/lichess';

  // Rating brackets — comma-separated (API no longer accepts repeated params)
  const ratingBrackets = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
  const rMin = settings.ratingMin || 1600;
  const rMax = settings.ratingMax || 2500;
  const selectedRatings = ratingBrackets.filter((r) => r >= rMin && r <= rMax);
  params.set('ratings', (selectedRatings.length ? selectedRatings : [1600]).join(','));

  // Time controls — comma-separated
  const validSpeeds = new Set(['bullet', 'blitz', 'rapid', 'classical']);
  const speeds = (settings.speeds || ['blitz', 'rapid', 'classical']).filter((s) => validSpeeds.has(s));
  params.set('speeds', (speeds.length ? speeds : ['blitz']).join(','));

  return `${base}?${params.toString().replace(/\+/g, '%20')}`;
}

/**
 * Simple delay promise.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the throttle window has elapsed since the last request.
 */
async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - _lastRequestTime;
  if (elapsed < THROTTLE_MS) {
    await delay(THROTTLE_MS - elapsed);
  }
  _lastRequestTime = Date.now();
}

interface LichessMoveEntry {
  san: string;
  uci: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number;
}

interface LichessApiResponse {
  moves: LichessMoveEntry[];
}

/**
 * Calculate win rate for a given color from a Lichess move entry.
 */
function winRate(move: LichessMoveEntry, color: string): number {
  const total = move.white + move.draws + move.black;
  if (total === 0) return 0;
  if (color === 'white') return (move.white / total) * 100;
  return (move.black / total) * 100;
}

/**
 * Calculate loss rate for a given color from a Lichess move entry.
 */
function lossRate(move: LichessMoveEntry, color: string): number {
  const total = move.white + move.draws + move.black;
  if (total === 0) return 0;
  if (color === 'white') return (move.black / total) * 100;
  return (move.white / total) * 100;
}

/**
 * Calculate draw rate from a Lichess move entry.
 */
function drawRate(move: LichessMoveEntry): number {
  const total = move.white + move.draws + move.black;
  if (total === 0) return 0;
  return (move.draws / total) * 100;
}

/**
 * Total games for a move entry.
 */
function totalGames(move: LichessMoveEntry): number {
  return move.white + move.draws + move.black;
}

/**
 * Fetch opening data from Lichess API with retry logic.
 * Automatically throttles to ~1 req/sec and retries on 429 with
 * exponential backoff (3s, 6s, 12s, 24s, 48s).
 */
async function fetchLichess(
  fen: string,
  settings: GeneratorSettings,
  logError: LogFn,
  attempt: number = 1
): Promise<LichessApiResponse> {
  await throttle();

  try {
    const url = buildLichessUrl(fen, settings);
    const token = getStoredToken();
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    logError('info', `Lichess request (attempt ${attempt}): ${url}`);
    const res = await fetch(url, { headers });

    if (res.status === 429) {
      if (attempt <= MAX_RETRIES) {
        const backoff = 3000 * Math.pow(2, attempt - 1);
        logError('warning', `Lichess rate limited (429). Waiting ${backoff / 1000}s before retry ${attempt}/${MAX_RETRIES}...`);
        await delay(backoff);
        return fetchLichess(fen, settings, logError, attempt + 1);
      }
      throw new Error(`Lichess API rate limited after ${MAX_RETRIES} retries`);
    }

    // Non-retryable errors — bail out immediately
    if (res.status === 401) {
      throw new Error(
        'Lichess API returned 401 (not retrying): not connected. Use the "Connect Lichess" button in settings.'
      );
    }
    if (res.status === 400 || res.status === 403 || res.status === 404) {
      const body = await res.text().catch(() => '');
      throw new Error(`Lichess API returned ${res.status} (not retrying): ${body || res.statusText || '(empty)'}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Lichess API returned ${res.status}: ${body || res.statusText || '(empty)'}`);
    }

    const data = await res.json();
    if (!data.moves) {
      throw new Error('Lichess API response missing moves field');
    }

    return data as LichessApiResponse;
  } catch (err: any) {
    const isNonRetryable =
      err.message.includes('rate limited after') ||
      err.message.includes('not retrying');
    if (attempt <= MAX_RETRIES && !isNonRetryable) {
      const retryDelay = 3000 * Math.pow(2, attempt - 1);
      logError('warning', `Lichess request failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}. Retrying in ${retryDelay / 1000}s...`);
      await delay(retryDelay);
      return fetchLichess(fen, settings, logError, attempt + 1);
    }
    logError('error', `Lichess API failed after ${attempt} attempts: ${err.message}`);
    throw err;
  }
}

/** A processed Lichess move result. */
export interface LichessMove {
  san: string;
  uci: string;
  totalGames: number;
  winRate: number;
  lossRate: number;
  drawRate: number;
  averageRating: number | null;
}

/**
 * Composite move quality score blending popularity and win rate.
 *
 * Formula:
 *   score = winRate_for_color  +  (log10(totalGames) / log10(maxGames)) * popularityWeight
 *
 * This ensures popular moves still rank well but a move with a strong win
 * rate can overtake a slightly more-played but weaker move.
 *
 * popularityWeight: 0 = pure win-rate; 1 = equal weight; default 0.4
 */
function compositeScore(
  move: LichessMoveEntry,
  color: string,
  maxGames: number,
  popularityWeight: number = 0.4
): number {
  const total = totalGames(move);
  if (total === 0) return 0;
  const wr = winRate(move, color);
  const popularityNorm = maxGames > 1
    ? Math.log10(Math.max(total, 1)) / Math.log10(maxGames)
    : 1;
  return wr + popularityNorm * popularityWeight * 100;
}

/**
 * Get the most played moves for a position from Lichess.
 * Returns moves sorted by a composite quality score (win rate + popularity),
 * with stats attached.
 */
export async function getMostPlayedMoves(
  fen: string,
  settings: GeneratorSettings,
  logError: LogFn,
  maxMoves: number = 5
): Promise<LichessMove[]> {
  const data = await fetchLichess(fen, settings, logError);

  const color = settings.color || 'white';
  const moves = data.moves || [];

  if (moves.length === 0) return [];

  // Find max games across all moves for normalisation
  const maxGames = Math.max(...moves.map(totalGames));

  // Sort by composite score (win rate weighted with popularity)
  moves.sort((a, b) => compositeScore(b, color, maxGames) - compositeScore(a, color, maxGames));

  // Take top N
  const top = moves.slice(0, maxMoves);

  const result: LichessMove[] = [];
  for (const m of top) {
    const total = totalGames(m);
    if (total === 0) continue;

    result.push({
      san: m.san,
      uci: m.uci,
      totalGames: total,
      winRate: winRate(m, color),
      lossRate: lossRate(m, color),
      drawRate: drawRate(m),
      averageRating: m.averageRating || null,
    });
  }

  return result;
}

/**
 * Fetch raw game-count data for all moves in a position, keyed by SAN.
 * Used by the trickyness system to frequency-weight opponent error rates:
 * a mistake that 40% of players make is far more relevant than one only
 * 2% attempt.
 *
 * Returns an empty Map (graceful degradation) on any API failure.
 */
export async function getLichessMoveCounts(
  fen: string,
  settings: GeneratorSettings,
  logError: LogFn
): Promise<Map<string, number>> {
  const data = await fetchLichess(fen, settings, logError);
  const counts = new Map<string, number>();
  for (const m of data.moves || []) {
    const total = m.white + m.draws + m.black;
    if (total > 0) counts.set(m.san, total);
  }
  return counts;
}
