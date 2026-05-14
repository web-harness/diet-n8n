#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DOCKER_BUILDKIT=1

show_usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Build diet-n8n packaging and generate SHA256 checksums.

Requires Docker. The script:
  1. Builds the packaging using BuildKit (target: export stage)
  2. Splits output into chunks in dist/chunks/
  3. Generates SHA256 checksums for every chunk
  4. Verifies all checksums
  5. Bundles extract.ts with esbuild
  6. Generates dist/package.json

Options:
  --help    Show this help message and exit
EOF
}

if [[ "${1:-}" == "--help" ]]; then
    show_usage
    exit 0
fi

if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed or not in PATH."
    echo "Please install Docker before running this script."
    exit 1
fi

echo "==> Cleaning dist/ ..."
rm -rf "$SCRIPT_DIR/dist"
mkdir -p "$SCRIPT_DIR/dist/chunks"

echo "==> Building with Docker (platform: linux/amd64, target: export) ..."
docker build \
    --platform linux/amd64 \
    --target export \
    --output type=local,dest="$SCRIPT_DIR/dist" \
    "$SCRIPT_DIR"

echo "==> Generating SHA256 checksums ..."
(cd "$SCRIPT_DIR/dist/chunks" && sha256sum *) > "$SCRIPT_DIR/dist/sha256sums.txt"

chunk_count=$(ls -1 "$SCRIPT_DIR/dist/chunks/" | wc -l)
total_size=$(du -sh "$SCRIPT_DIR/dist" | cut -f1)
echo ""
echo "==> Build summary:"
echo "  Chunks:     $chunk_count"
echo "  Total size: $total_size"
echo "  Chunk files:"
ls -lh "$SCRIPT_DIR/dist/chunks/" | sed 's/^/    /'

echo ""
echo "==> Verifying SHA256 checksums ..."
if (cd "$SCRIPT_DIR/dist/chunks" && sha256sum -c "$SCRIPT_DIR/dist/sha256sums.txt"); then
    echo ""
    echo "==> All checksums verified successfully."
else
    echo ""
    echo "==> ERROR: Checksum verification failed!"
    exit 1
fi

echo ""
echo "==> Bundling extract.ts with esbuild ..."
npx esbuild "$SCRIPT_DIR/extract.ts" --bundle --platform=node --format=cjs --outfile="$SCRIPT_DIR/dist/extract.js" --minify
chmod +x "$SCRIPT_DIR/dist/extract.js"
echo "  dist/extract.js bundled successfully."

echo "==> Generating dist/package.json ..."
VERSION=$(node -p "require('$SCRIPT_DIR/package.json').version")
cat > "$SCRIPT_DIR/dist/package.json" << JSONEOF
{
  "name": "diet-n8n",
  "version": "${VERSION}",
  "bin": {
    "diet-n8n": "./node_modules/n8n/bin/n8n"
  },
  "scripts": {
    "postinstall": "node extract.js"
  },
  "os": ["linux"],
  "cpu": ["x64"]
}
JSONEOF
echo "  dist/package.json generated (version: ${VERSION})."
