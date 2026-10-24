# Main Line — Chess Repertoire App

A dark-themed, interactive chess opening repertoire builder with cloud sync, user auth, spaced repetition training, D3 tree visualization, Stockfish engine analysis, and PGN import/export.

---

## Infrastructure

| Service | Details |
|---|---|
| Cloud auth + database | Firebase Authentication + Cloud Firestore (Spark) |
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

Firebase setup and migration instructions are in [FIREBASE_SETUP.md](FIREBASE_SETUP.md).
Local repertoires remain in browser storage and upload when signing into Firebase.
Cloud payloads are split into 400 KB binary chunks and replaced atomically. Each
repertoire currently supports up to 8 MB of serialized JSON per save, below the
Firestore atomic request limit. Chunk payload indexing is disabled by the supplied
index configuration. Fetch failures propagate to the sync error handler rather
than being interpreted as an empty remote account.

Generated moves no longer add analysis comments to imported trees or exported PGN.
Existing personal notes are preserved when extending a line.

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

This installs the pinned `stockfish@19.0.1` package and copies its Stockfish 19 full-network single-threaded JavaScript/WASM pair and GPL license into `public/stockfish/`. This build uses the full neural network, is approximately 99 MB, and works without cross-origin isolation. All local board, generator, and Opening Lab analysis uses this same build. Lichess cloud results remain available when they satisfy the requested analysis quality; their engine version is unspecified.

The application loads `/stockfish/stockfish-19-single.js?v=19.0.1`; the matching `.wasm` file sits alongside it. Opening Lab engine caches include the WASM SHA-256 so previous engine results are not reused after this upgrade.

Upstream source and build instructions: [Stockfish.js v19.0.1](https://github.com/nmrugg/stockfish.js/tree/v19.0.1). The distributed package includes the engine source.

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

Compact / Standard / Broad aim for 70% / 85% / 95% local database reply coverage, with budgets of 150 / 500 / 1200 moves and normally up to 3 / 5 / 8 replies per opponent position. Opponent replies meeting the configurable play-frequency threshold (default 10%) and minimum game count override these reply and coverage limits, regardless of evaluation; the total move budget still applies. The strongest engine defense is always selected. With **Shorten rare opponent branches** enabled, additional replies below the frequency threshold end up to two moves earlier. This reduction does not compound down the branch, and missing human data does not trigger it. Coverage uses the full database position count; it is not an estimate of whole-repertoire coverage. Limited samples, reply limits and database failures are reported. The engine-only profile has no human coverage estimate.

Continuation work is shared proportionally at every opponent fork: an 80% reply receives roughly four times the move budget of a 20% reply, rather than giving every line equal depth or spending everything on the most likely line. Each generated move counts toward every ancestor branch, so nested forks retain their parent’s share. Supplied and resumed branches use the same frequency weights. Unrecorded engine defenses retain a small share; positions without human frequencies share equally. With decay enabled, reservations follow these shares while retaining enough budget for existing continuations. Target depth, terminal positions and analysis failures can limit a branch; its unused share is available to other active branches. Integer moves and minimum continuation requirements can make the final split approximate.

Advanced preferences control one local Stockfish depth, allowed loss against the best verified candidate, bounded tactical extensions and optional avoidance of immediate queen exchanges. Historical style and trickiness scores are no longer used to select moves. Starting moves are never removed for failing an evaluation threshold. PGNs with nonstandard starting FENs are rejected explicitly.

The preview, PGN export and repertoire import retain the same branches. Stop cancels engine searches and database requests; a subsequent run has independent state. Results distinguish completed targets, stopped runs, budget limits, coverage gaps and failed analysis. The main repertoire's **Extend Continuation** action preserves existing branches and applies the result when generation finishes.

Run generator regression checks with `npm test`, type checking with `npx tsc --noEmit`, and the production build with `npm run build`.

Trickiness for your own moves defaults to High, with a 0–0.5 pawn sacrifice interval. The default opponent profile uses the Lichess database at ratings 2200–2500. Balanced / High examine up to five engine candidates plus three popular moves, then up to eight supported human replies for each candidate inside the selected sacrifice interval (0–5 pawns relative to the position evaluation before your move, from your side’s perspective). The interval replaces the normal allowed-loss setting while trickiness is active. Reversed bounds are sorted. Selection uses objective evaluation plus 0.5 / 1.0 times frequency-weighted opponent mistakes, capping each reply gain at three pawns and shrinking it by games / (games + 100). Unexamined or unsupported replies contribute zero benefit; frequencies are not renormalized. If no candidate beats the best verified objective score on this measure, the best permitted move is retained even if below the interval minimum. If no candidate respects the maximum loss from the current evaluation, the continuation is marked unfinished; the limit is never bypassed. Engine-only mode ignores trickiness. This is a one-reply practical estimate, not a prediction of win probability; additional analysis increases generation time.

The overall evaluation floor is enabled by default at −0.4 pawns from the repertoire side’s perspective, adjustable from −10 to +10 or disabled. Above or at the floor, generated own moves must meet both the floor and the per-move loss limit. Below it, choose the strongest verified continuation without popularity, queen-exchange or trickiness preferences; the per-move limit still applies. If no candidate qualifies, mark the branch unfinished. Seeds remain preserved and opponent moves are not filtered by this floor.

Branch decay defaults to Balanced (Off / Gentle are available). After the first two generated opponent turns, Balanced limits paths with estimated probability 2–10% to the strongest and most likely replies, and paths below 2% to one reply. Gentle uses 0.5–5% and below 0.5%. A single reply is the most likely supported move unless the strongest defense worsens the repertoire side's evaluation by at least 0.5 pawns compared with it. Probabilities multiply local opponent frequencies from each seed leaf; missing frequencies make the estimate unknown rather than zero. These are rough profile-based estimates, not measured whole-line frequencies.

When decay is enabled, branching also reserves one continuation to the target plus possible tactical extension for every pending branch. This can reduce even early branching and overrides frequency/coverage requirements; coverage gaps remain visible. Rare lines retain full target depth instead of using the older two-move reduction. Existing seeds, engine failures, tactical limits and insufficient budget for the initial seed frontier can still prevent completion; reaching the target is not guaranteed.
