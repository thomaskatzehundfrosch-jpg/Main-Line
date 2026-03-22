/**
 * Chess.com API integration for fetching player games.
 */

export interface ChessComRawGame {
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

export interface FetchProgress {
  fetchedMonths: number;
  totalMonths: number;
  gamesFound: number;
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

/**
 * Fetch games from chess.com for a given username and month range.
 * Calls the public API: https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}
 */
export async function fetchChessComGames(
  username: string,
  fromMonth: string,
  toMonth: string,
  onProgress?: (progress: FetchProgress) => void
): Promise<ChessComRawGame[]> {
  const months = getMonthsBetween(fromMonth, toMonth);

  if (months.length === 0) {
    throw new Error('No months in selected range.');
  }
  if (months.length > 24) {
    throw new Error('Date range too large (max 24 months).');
  }

  const allGames: ChessComRawGame[] = [];
  let fetched = 0;

  for (const { year, month } of months) {
    const mm = String(month).padStart(2, '0');
    const url = `/chess-api/pub/player/${encodeURIComponent(
      username.toLowerCase()
    )}/games/${year}/${mm}`;

    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (resp.status === 404) {
      throw new Error(`User "${username}" not found on chess.com.`);
    }
    if (resp.status === 500) {
      // Chess.com returns 500 for the current in-progress month (archive not yet finalised).
      // Skip silently and continue fetching the remaining months.
      fetched++;
      onProgress?.({ fetchedMonths: fetched, totalMonths: months.length, gamesFound: allGames.length });
      continue;
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} fetching ${year}/${mm}`);
    }

    const data = await resp.json();
    const games: ChessComRawGame[] = data.games || [];
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
