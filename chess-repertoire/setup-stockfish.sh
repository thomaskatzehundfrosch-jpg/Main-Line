#!/bin/bash
# Run from the chess-repertoire directory to install the browser engine.
set -euo pipefail
if [ ! -f package.json ]; then
  echo "Run this script from the chess-repertoire directory."
  exit 1
fi
npm install --save-exact stockfish@19.0.1
mkdir -p public/stockfish
cp node_modules/stockfish/bin/stockfish-19-lite-single.js public/stockfish/
cp node_modules/stockfish/bin/stockfish-19-lite-single.wasm public/stockfish/
cp node_modules/stockfish/Copying.txt public/stockfish/Copying.txt
echo "Installed Stockfish 19.0.1 lite single-threaded browser engine."
