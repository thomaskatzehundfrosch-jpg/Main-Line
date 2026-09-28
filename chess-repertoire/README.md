# Main Line — Chess Repertoire App

A dark-themed, interactive chess opening repertoire builder with cloud sync, user auth, spaced repetition training, D3 tree visualization, Stockfish engine analysis, and PGN import/export.

---

## Infrastructure

| Service | Details |
|---|---|
| Supabase project URL | `https://nxperpauqoylswshsbei.supabase.co` |
| GitHub repo | `github.com/thomaskatzehundfrosch-jpg/Main-Line` |
| Vercel project | `Main-Line` — Root Directory set to `chess-repertoire` |

---

## Deploying a New Version

```bash
git add .
git commit -m "describe your change"
git push
```

Vercel auto-deploys within ~60 seconds. No manual steps needed.

---

## Auth + Cloud Sync

- **Auth:** Supabase (email/password + Google OAuth). Sign In button lives in the TopBar.
- **Not logged in:** data saves to localStorage only (works offline)
- **On sign in:** local files push to Supabase, remote files fetched and merged
- **While logged in:** every save, update, rename, and delete syncs to Supabase automatically

### Supabase Database (3 tables, all with Row Level Security)
- `repertoire_files` — repertoire files stored as JSONB per user
- `sr_cards` — spaced repetition cards per user
- `sr_stats` — lifetime review stats per user

To recreate the schema from scratch, run `supabase-schema.sql` in the Supabase SQL Editor.

### Environment Variables
Required in `.env` in the project root (never commit this file):
```
VITE_SUPABASE_URL=https://nxperpauqoylswshsbei.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```
The same two variables must also be added in the Vercel project dashboard under Environment Variables.

### Key Auth/Sync Files
- `src/lib/supabase.ts` — Supabase client (gracefully disabled if env vars missing)
- `src/lib/supabaseSync.ts` — all cloud read/write helpers
- `src/context/AuthContext.tsx` — auth state + signIn/signUp/signOut/Google
- `src/components/Auth/AuthModal.tsx` — login/signup modal
- `src/components/Auth/UserMenu.tsx` — avatar dropdown + sign out
- `src/context/FileContext.tsx` — repertoire files with Supabase sync baked in

### Known Issues
Two pre-existing TypeScript errors in `usePgnParser.ts` and `openingNames.ts` — don't affect runtime behaviour. Build command is `vite build` (not `tsc -b && vite build`) to skip the type check on deploy.

---

## Setup

```bash
cd chess-repertoire
npm install
npm run dev
```

Then open `http://localhost:5173` in your browser.

## Stockfish Engine Setup (REQUIRED for real analysis)

Without Stockfish installed, the app runs in **simulation mode** with fake evaluations and random move suggestions. You must install the actual engine files:

### Quick Setup (recommended)

```bash
cd chess-repertoire
chmod +x setup-stockfish.sh
./setup-stockfish.sh
```

This installs the `stockfish` npm package (Stockfish 17.1 WASM) and copies the lite single-threaded engine files to `public/stockfish/`.

### Manual Setup

1. Install the npm package: `npm install stockfish@17.1.0`
2. Find the lite single-threaded files in `node_modules/stockfish/src/` (names include a hash suffix like `stockfish-nnue-17.1-lite-single-XXXX.js`)
3. Copy the `.js` file to `public/stockfish/stockfish.js`
4. Copy all matching `.wasm` files to `public/stockfish/` (keep their original names)

### Alternative: Direct download

1. Download Stockfish WASM files from [stockfish.js on npm](https://www.npmjs.com/package/stockfish) or [GitHub](https://github.com/nmrugg/stockfish.js)
2. Place the `.js` file as `public/stockfish/stockfish.js` along with its `.wasm` companion files

### Verify it works

After setup, `public/stockfish/` should contain at least a `.js` and `.wasm` file. Run `npm run dev` and the engine panel should show real evaluations (not "Simulated").

## Features

- **PGN Import/Export**: Paste PGN text or upload .pgn files; export with annotations
- **Opening Tree**: Interactive D3.js tree visualization with zoom, pan, and tooltips
- **Chessboard**: Drag-and-drop pieces, engine arrows, evaluation bar
- **Engine Analysis**: Stockfish WASM with MultiPV support (top 3 lines)
- **Move List**: Navigate through lines with variation branches
- **Annotations**: Add comments and NAG symbols to any position
- **Keyboard Shortcuts**: Arrow keys to navigate, `f` to flip board

## Tech Stack

React 18, TypeScript, Vite, Tailwind CSS, chess.js, react-chessboard, D3.js, Stockfish WASM

### Repertoire generator

Choose your side, opponent profile, study size and target move number. Play starting moves on the board or load a PGN into the same editable move tree, then choose **Generate continuations**. Existing moves (including alternatives) are preserved; questionable starting moves receive warnings. Generation adds one recommendation for your side at each leaf, and common opponent replies plus the strongest engine defense. Common mistakes are retained so their punishment can be studied.

Compact / Standard / Broad aim for 70% / 85% / 95% local database reply coverage, with budgets of 150 / 500 / 1200 moves and normally up to 3 / 5 / 8 replies per opponent position. Opponent replies meeting the configurable play-frequency threshold (default 5%) and minimum game count override these reply and coverage limits, regardless of evaluation; the total move budget still applies. The strongest engine defense is always selected. With **Shorten rare opponent branches** enabled, additional replies below the frequency threshold end up to two moves earlier. This reduction does not compound down the branch, and missing human data does not trigger it. Coverage uses the full database position count; it is not an estimate of whole-repertoire coverage. Limited samples, reply limits and database failures are reported. The engine-only profile has no human coverage estimate.

Advanced preferences control one local Stockfish depth, allowed loss against the best verified candidate, bounded tactical extensions and optional avoidance of immediate queen exchanges. Historical style and trickiness scores are no longer used to select moves. Starting moves are never removed for failing an evaluation threshold. PGNs with nonstandard starting FENs are rejected explicitly.

The preview, PGN export and repertoire import retain the same branches. Stop cancels engine searches and database requests; a subsequent run has independent state. Results distinguish completed targets, stopped runs, budget limits, coverage gaps and failed analysis. The main repertoire's **Extend Continuation** action preserves existing branches and applies the result when generation finishes.

Run generator regression checks with `npm test`, type checking with `npx tsc --noEmit`, and the production build with `npm run build`.

Trickiness for your own moves defaults to High, with a 0–0.5 pawn sacrifice interval. The default opponent profile uses the Lichess database at ratings 2200–2500. Balanced / High examine up to five engine candidates plus three popular moves, then up to eight supported human replies for each candidate inside the selected sacrifice interval (0–5 pawns relative to the position evaluation before your move, from your side’s perspective). The interval replaces the normal allowed-loss setting while trickiness is active. Reversed bounds are sorted. Selection uses objective evaluation plus 0.5 / 1.0 times frequency-weighted opponent mistakes, capping each reply gain at three pawns and shrinking it by games / (games + 100). Unexamined or unsupported replies contribute zero benefit; frequencies are not renormalized. If no candidate beats the best verified objective score on this measure, the best permitted move is retained even if below the interval minimum. If no candidate respects the maximum loss from the current evaluation, the continuation is marked unfinished; the limit is never bypassed. Engine-only mode ignores trickiness. This is a one-reply practical estimate, not a prediction of win probability; additional analysis increases generation time.

The overall evaluation floor is enabled by default at −0.4 pawns from the repertoire side’s perspective, adjustable from −10 to +10 or disabled. Above or at the floor, generated own moves must meet both the floor and the per-move loss limit. Below it, choose the strongest verified continuation without popularity, queen-exchange or trickiness preferences; the per-move limit still applies. If no candidate qualifies, mark the branch unfinished. Seeds remain preserved and opponent moves are not filtered by this floor.

Branch decay defaults to Balanced (Off / Gentle are available). After the first two generated opponent turns, Balanced limits paths with estimated probability 2–10% to the strongest and most likely replies, and paths below 2% to one reply. Gentle uses 0.5–5% and below 0.5%. A single reply is the most likely supported move unless the strongest defense worsens the repertoire side's evaluation by at least 0.5 pawns compared with it. Probabilities multiply local opponent frequencies from each seed leaf; missing frequencies make the estimate unknown rather than zero. These are rough profile-based estimates, not measured whole-line frequencies.

When decay is enabled, branching also reserves one continuation to the target plus possible tactical extension for every pending branch. This can reduce even early branching and overrides frequency/coverage requirements; coverage gaps remain visible. Rare lines retain full target depth instead of using the older two-move reduction. Existing seeds, engine failures, tactical limits and insufficient budget for the initial seed frontier can still prevent completion; reaching the target is not guaranteed.
