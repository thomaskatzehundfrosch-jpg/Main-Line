#!/bin/bash
# Run from the chess-repertoire directory to install the browser engine.
set -euo pipefail
if [ ! -f package.json ]; then
  echo "Run this script from the chess-repertoire directory."
  exit 1
fi
npm install --save-exact stockfish@19.0.1
mkdir -p public/stockfish
cp node_modules/stockfish/bin/stockfish-19-single.js public/stockfish/
cp node_modules/stockfish/bin/stockfish-19-single.wasm public/stockfish/
cp node_modules/stockfish/Copying.txt public/stockfish/Copying.txt
echo "Installed Stockfish 19.0.1 full-network single-threaded browser engine."
