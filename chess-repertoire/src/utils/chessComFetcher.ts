/**
 * Game fetching utilities for Chess.com and Lichess.
 */

export type GameSource = 'chesscom' | 'lichess';

export interface RawFetchedGame {
  source: GameSource;
  url: string;
  pgn: string;
  time_control: string;
  end_time: number;
  rated: boolean;
  time_class: string;
  rules: string;
  white: {
    username: string;
    rating: number;
    result: string;
  };
  black: {
    username: string;
    rating: number;
    result: string;
  };
}

export type ChessComRawGame = RawFetchedGame;

export interface FetchProgress {
  fetchedMonths: number;
  totalMonths: number;
  gamesFound: number;
}

interface LichessApiGame {
  id: string;
  rated: boolean;
  variant: string;
  speed: string;
  createdAt: number;
  lastMoveAt?: number;
  winner?: 'white' | 'black';
  players?: {
    white?: {
      user?: { name?: string };
      rating?: number;
    };
    black?: {
      user?: { name?: string };
      rating?: number;
    };
  };
  pgn?: string;
  clock?: {
    initial?: number;
    increment?: number;
  };
}

/**
 * Generate a list of {year, month} tuples between two month strings.
 * @param fromStr Format: "YYYY-MM"
 * @param toStr   Format: "YYYY-MM"
 */
export function getMonthsBetween(
  fromStr: string,
  toStr: string
): { year: number; month: number }[] {
  const [fy, fm] = fromStr.split('-').map(Number);
  const [ty, tm] = toStr.split('-').map(Number);
  const months: { year: number; month: number }[] = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    months.push({ year: y, month: m });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return months;
}

function monthBoundsUtc(year: number, month: number): { since: number; until: number } {
  return {
    since: Date.UTC(year, month - 1, 1, 0, 0, 0, 0),
    until: Date.UTC(year, month, 0, 23, 59, 59, 999),
  };
}

function mapWinnerToResult(
  winner: 'white' | 'black' | undefined,
  color: 'white' | 'black'
): string {
  if (!winner) return 'agreed';
  return winner === color ? 'win' : 'loss';
}

function parseNdjson<T>(text: string): T[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function toLichessTimeControl(game: LichessApiGame): string {
  const initial = game.clock?.initial;
  const increment = game.clock?.increment;
  if (typeof initial === 'number' && typeof increment === 'number') {
    return `${initial}+${increment}`;
  }
  return '';
}

function normalizeLichessGame(game: LichessApiGame): RawFetchedGame {
  return {
    source: 'lichess',
    url: `https://lichess.org/${game.id}`,
    pgn: game.pgn ?? '',
    time_control: toLichessTimeControl(game),
    end_time: Math.floor((game.lastMoveAt ?? game.createdAt) / 1000),
    rated: !!game.rated,
    time_class: game.speed ?? '',
    rules: game.variant ?? 'standard',
    white: {
      username: game.players?.white?.user?.name ?? 'Anonymous',
      rating: game.players?.white?.rating ?? 0,
      result: mapWinnerToResult(game.winner, 'white'),
    },
    black: {
      username: game.players?.black?.user?.name ?? 'Anonymous',
      rating: game.players?.black?.rating ?? 0,
      result: mapWinnerToResult(game.winner, 'black'),
    },
  };
}

/**
 * Fetch games from chess.com for a given username and month range.
 * Calls the public API: https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}
 */
export async function fetchChessComGames(
  username: string,
  fromMonth: string,
  toMonth: string,
  onProgress?: (progress: FetchProgress) => void
): Promise<RawFetchedGame[]> {
  const months = getMonthsBetween(fromMonth, toMonth);
  const normalizedUsername = username.toLowerCase();
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  if (months.length === 0) {
    throw new Error('No months in selected range.');
  }
  if (months.length > 24) {
    throw new Error('Date range too large (max 24 months).');
  }

  // Validate the account once up front. Monthly archive 404s can also mean
  // "no archive for this month", so they should not be treated as user-not-found.
  const profileResp = await fetch(
    `/chess-api/pub/player/${encodeURIComponent(normalizedUsername)}`,
    {
      headers: { Accept: 'application/json' },
    }
  );

  if (profileResp.status === 404) {
    throw new Error(`User "${username}" not found on chess.com.`);
  }
  if (!profileResp.ok) {
    throw new Error(`HTTP ${profileResp.status} validating chess.com user`);
  }

  const allGames: RawFetchedGame[] = [];
  let fetched = 0;

  for (const { year, month } of months) {
    const mm = String(month).padStart(2, '0');
    const isCurrentMonthArchive = year === currentYear && month === currentMonth;
    const url = `/chess-api/pub/player/${encodeURIComponent(
      normalizedUsername
    )}/games/${year}/${mm}`;

    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if ((resp.status === 404 || resp.status === 500) && isCurrentMonthArchive) {
      // Chess.com can lag on the freshly started month archive. Keep the
      // default date range, but skip the current month until the archive is ready.
      fetched++;
      onProgress?.({
        fetchedMonths: fetched,
        totalMonths: months.length,
        gamesFound: allGames.length,
      });
      continue;
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} fetching ${year}/${mm}`);
    }

    const data = await resp.json();
    const games = ((data.games || []) as Omit<RawFetchedGame, 'source'>[]).map((game) => ({
      ...game,
      source: 'chesscom' as const,
    }));
    allGames.push(...games);

    fetched++;
    onProgress?.({
      fetchedMonths: fetched,
      totalMonths: months.length,
      gamesFound: allGames.length,
    });
  }

  return allGames;
}

/**
 * Fetch games from Lichess for a given username and month range.
 * Calls the public API: https://lichess.org/api/games/user/{username}
 */
export async function fetchLichessGames(
  username: string,
  fromMonth: string,
  toMonth: string,
  onProgress?: (progress: FetchProgress) => void
): Promise<RawFetchedGame[]> {
  const months = getMonthsBetween(fromMonth, toMonth);

  if (months.length === 0) {
    throw new Error('No months in selected range.');
  }
  if (months.length > 24) {
    throw new Error('Date range too large (max 24 months).');
  }

  const allGames: RawFetchedGame[] = [];
  let fetched = 0;

  for (const { year, month } of months) {
    const { since, until } = monthBoundsUtc(year, month);
    const url = `/lichess-api/api/games/user/${encodeURIComponent(
      username
    )}?since=${since}&until=${until}&pgnInJson=true&opening=true`;

    const resp = await fetch(url, {
      headers: { Accept: 'application/x-ndjson' },
    });

    if (resp.status === 404) {
      throw new Error(`User "${username}" not found on Lichess.`);
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} fetching ${year}-${String(month).padStart(2, '0')}`);
    }

    const text = await resp.text();
    const games = parseNdjson<LichessApiGame>(text).map(normalizeLichessGame);
    allGames.push(...games);

    fetched++;
    onProgress?.({
      fetchedMonths: fetched,
      totalMonths: months.length,
      gamesFound: allGames.length,
    });
  }

  return allGames;
}

export async function fetchGames(
  source: GameSource,
  username: string,
  fromMonth: string,
  toMonth: string,
  onProgress?: (progress: FetchProgress) => void
): Promise<RawFetchedGame[]> {
  if (source === 'lichess') {
    return fetchLichessGames(username, fromMonth, toMonth, onProgress);
  }
  return fetchChessComGames(username, fromMonth, toMonth, onProgress);
}

/**
 * Extract SAN moves from a PGN string (stripping comments, annotations, results).
 */
export function parsePgnMoves(pgn: string): string[] {
  // Remove tag pairs
  let text = pgn.replace(/\[.*?\]\s*/g, '').trim();
  // Remove comments
  text = text.replace(/\{[^}]*\}/g, '');
  // Remove variations (simple nesting)
  text = text.replace(/\([^)]*\)/g, '');
  // Remove move numbers, NAGs, results
  text = text
    .replace(/\d+\.\.\./g, '')
    .replace(/\d+\./g, '')
    .replace(/\$\d+/g, '');
  text = text.replace(/1-0|0-1|1\/2-1\/2|\*/g, '');

  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const moves: string[] = [];
  for (const t of tokens) {
    // Standard SAN patterns + castling
    if (
      /^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?$/.test(t) ||
      t === 'O-O-O' ||
      t === 'O-O' ||
      /^[KQRBN][a-h1-8]?[a-h][1-8][+#]?$/.test(t)
    ) {
      // Strip check/mate symbols for consistency
      moves.push(t.replace(/[+#]/, ''));
    }
  }
  return moves;
}

/**
 * Extract the result from a PGN string.
 */
export function parsePgnResult(pgn: string): string {
  const match = pgn.match(/\[Result\s+"([^"]+)"\]/);
  return match ? match[1] : '?';
}

/**
 * Extract a specific tag value from PGN.
 */
export function parsePgnTag(pgn: string, tag: string): string | undefined {
  const regex = new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`);
  const match = pgn.match(regex);
  return match ? match[1] : undefined;
}
