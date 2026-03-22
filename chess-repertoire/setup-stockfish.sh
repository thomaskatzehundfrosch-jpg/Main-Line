#!/bin/bash
# Setup Stockfish 17.1 WASM for chess-repertoire
# Run this from the chess-repertoire directory:
#   chmod +x setup-stockfish.sh && ./setup-stockfish.sh

set -e

echo "=== Setting up Stockfish 17.1 WASM engine ==="

# Ensure we're in the right directory
if [ ! -f "package.json" ]; then
  echo "Error: Run this script from the chess-repertoire directory"
  exit 1
fi

# Create the stockfish directory
mkdir -p public/stockfish

# Install the stockfish npm package (nmrugg's Stockfish.js, currently SF 17.1)
echo "Installing stockfish npm package..."
npm install stockfish@17.1.0

# Find and copy the lite single-threaded files (best for broad compatibility, ~7MB)
echo "Copying Stockfish WASM files to public/stockfish/..."

# The lite-single version works without CORS headers and is small enough for most use cases
# File names include a hash suffix, so we find them dynamically
LITE_SINGLE_JS=$(find node_modules/stockfish/src -name "stockfish-nnue-17*-lite-single-*.js" ! -name "*.wasm*" 2>/dev/null | head -1)
LITE_SINGLE_WASM=$(find node_modules/stockfish/src -name "stockfish-nnue-17*-lite-single-*.wasm" 2>/dev/null | head -1)

if [ -z "$LITE_SINGLE_JS" ]; then
  echo "Lite single-threaded version not found. Trying multi-threaded lite..."
  LITE_SINGLE_JS=$(find node_modules/stockfish/src -name "stockfish-nnue-17*-lite-*.js" ! -name "*single*" ! -name "*.wasm*" 2>/dev/null | head -1)
  LITE_SINGLE_WASM=$(find node_modules/stockfish/src -name "stockfish-nnue-17*-lite-*.wasm" ! -name "*single*" 2>/dev/null | head -1)
fi

if [ -z "$LITE_SINGLE_JS" ]; then
  echo "Lite version not found. Trying full NNUE single-threaded..."
  LITE_SINGLE_JS=$(find node_modules/stockfish/src -name "stockfish-nnue-17*-single-*.js" ! -name "*lite*" ! -name "*.wasm*" 2>/dev/null | head -1)
  # Full NNUE may have split WASM parts
  LITE_SINGLE_WASM=$(find node_modules/stockfish/src -name "stockfish-nnue-17*-single-*.wasm" ! -name "*lite*" 2>/dev/null | head -1)
  WASM_PARTS=$(find node_modules/stockfish/src -name "stockfish-nnue-17*-single-*-part-*.wasm" 2>/dev/null)
fi

if [ -z "$LITE_SINGLE_JS" ]; then
  echo "Error: Could not find Stockfish JS files in node_modules/stockfish/src/"
  echo "Available files:"
  ls -la node_modules/stockfish/src/ 2>/dev/null || echo "  (directory not found)"
  exit 1
fi

echo "Found JS:   $LITE_SINGLE_JS"

# Copy the JS file as stockfish.js (the name our worker expects)
cp "$LITE_SINGLE_JS" public/stockfish/stockfish.js

# Copy WASM file(s)
if [ -n "$LITE_SINGLE_WASM" ]; then
  echo "Found WASM: $LITE_SINGLE_WASM"
  cp "$LITE_SINGLE_WASM" public/stockfish/stockfish.wasm
fi

# Copy any WASM parts (full NNUE splits large files)
if [ -n "$WASM_PARTS" ]; then
  echo "Found WASM parts:"
  for part in $WASM_PARTS; do
    echo "  $part"
    cp "$part" public/stockfish/
  done
fi

# Also copy with original names so the JS loader can find its matching WASM
# (the JS file internally references its specific WASM filename)
ORIG_JS_NAME=$(basename "$LITE_SINGLE_JS")
cp "$LITE_SINGLE_JS" "public/stockfish/$ORIG_JS_NAME"

if [ -n "$LITE_SINGLE_WASM" ]; then
  ORIG_WASM_NAME=$(basename "$LITE_SINGLE_WASM")
  cp "$LITE_SINGLE_WASM" "public/stockfish/$ORIG_WASM_NAME"
fi

# Copy all related files from the same flavor to be safe
JS_BASE=$(basename "$LITE_SINGLE_JS" .js)
# Extract the hash pattern to find all related files
FLAVOR_PREFIX=$(echo "$JS_BASE" | sed 's/-[0-9a-f]*$//')
for f in node_modules/stockfish/src/${FLAVOR_PREFIX}*; do
  if [ -f "$f" ]; then
    cp "$f" "public/stockfish/"
    echo "Copied: $(basename $f)"
  fi
done

echo ""
echo "=== Stockfish setup complete ==="
echo "Files in public/stockfish/:"
ls -lh public/stockfish/
echo ""
echo "The engine should now work when you run: npm run dev"
