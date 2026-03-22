# Chess Repertoire Explorer

A dark-themed, interactive chess opening repertoire explorer with D3 tree visualization, Stockfish engine analysis, and PGN import/export.

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
