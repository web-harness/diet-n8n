#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DOCKER_BUILDKIT=1

show_usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Build diet-n8n packaging and generate SHA256 checksums.

Requires Docker.

Options:
  --help, -h             Show this help message and exit
  --platform, -p <ID>    Target platform ID (default: linux-x64)
                        Supported: win-x64, linux-x64, linux-arm64, macos-x64, macos-arm64
EOF
}


PLATFORM="linux-x64"  # default

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform|-p)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --platform requires an argument" >&2
        exit 1
      fi
      PLATFORM="$2"
      shift 2
      ;;
    --help|-h)
      show_usage
      exit 0
      ;;
    *)
      echo "Error: Unknown option: $1" >&2
      show_usage
      exit 1
      ;;
  esac
done

# Validate platform
case "$PLATFORM" in
  win-x64|linux-x64|linux-arm64|macos-x64|macos-arm64) ;;
  *)
    echo "Error: Invalid platform '$PLATFORM'. Supported: win-x64, linux-x64, linux-arm64, macos-x64, macos-arm64" >&2
    show_usage
    exit 1
    ;;
esac

if [[ "$PLATFORM" == "linux-x64" ]]; then
  OUT_DIR="dist"
else
  OUT_DIR="dist-${PLATFORM}"
fi

echo "==> Cleaning $OUT_DIR/ ..."
rm -rf "$SCRIPT_DIR/$OUT_DIR"
mkdir -p "$SCRIPT_DIR/$OUT_DIR/chunks"

echo "==> Building with Docker (platform: linux/amd64, target: export) ..."
docker build \
    --platform linux/amd64 \
    --target export \
    --build-arg "PLATFORM=${PLATFORM}" \
    --output type=local,dest="$SCRIPT_DIR/$OUT_DIR" \
    "$SCRIPT_DIR"

N8N_VERSION_FILE="$SCRIPT_DIR/$OUT_DIR/.n8n-version"
if [[ ! -f "$N8N_VERSION_FILE" ]]; then
    echo "Error: $N8N_VERSION_FILE is missing (Docker export did not emit repackaged n8n version)."
    exit 1
fi
VERSION=$(tr -d '\r\n' <"$N8N_VERSION_FILE")
if [[ -z "$VERSION" ]]; then
    echo "Error: $N8N_VERSION_FILE is empty."
    exit 1
fi

echo "==> Generating SHA256 checksums ..."
(cd "$SCRIPT_DIR/$OUT_DIR/chunks" && sha256sum *) > "$SCRIPT_DIR/$OUT_DIR/sha256sums.txt"

chunk_count=$(ls -1 "$SCRIPT_DIR/$OUT_DIR/chunks/" | wc -l)
total_size=$(du -sh "$SCRIPT_DIR/$OUT_DIR" | cut -f1)
echo ""
echo "==> Build summary:"
echo "  n8n (repackaged): ${VERSION}"
echo "  Chunks:     $chunk_count"
echo "  Total size: $total_size"
echo "  Chunk files:"
ls -lh "$SCRIPT_DIR/$OUT_DIR/chunks/" | sed 's/^/    /'

echo ""
echo "==> Verifying SHA256 checksums ..."
if (cd "$SCRIPT_DIR/$OUT_DIR/chunks" && sha256sum -c "$SCRIPT_DIR/$OUT_DIR/sha256sums.txt"); then
    echo ""
    echo "==> All checksums verified successfully."
else
    echo ""
    echo "==> ERROR: Checksum verification failed!"
    exit 1
fi

echo ""
echo "==> Bundling extract.ts with esbuild ..."
npx esbuild "$SCRIPT_DIR/extract.ts" --bundle --platform=node --format=cjs --outfile="$SCRIPT_DIR/$OUT_DIR/extract.js" --minify
chmod +x "$SCRIPT_DIR/$OUT_DIR/extract.js"
echo "  $OUT_DIR/extract.js bundled successfully."

echo ""
echo "==> Copying minimal.env to $OUT_DIR/ ..."
cp "$SCRIPT_DIR/minimal.env" "$SCRIPT_DIR/$OUT_DIR/minimal.env"
echo "  minimal.env copied successfully."

# Map platform to package.json os/cpu fields
case "$PLATFORM" in
  win-x64)      PKG_OS="win32";  PKG_CPU="x64"   ;;
  linux-x64)    PKG_OS="linux";  PKG_CPU="x64"   ;;
  linux-arm64)  PKG_OS="linux";  PKG_CPU="arm64" ;;
  macos-x64)    PKG_OS="darwin"; PKG_CPU="x64"   ;;
  macos-arm64)  PKG_OS="darwin"; PKG_CPU="arm64" ;;
esac

echo ""
echo "==> Generating $OUT_DIR/package.json ..."
cat > "$SCRIPT_DIR/$OUT_DIR/package.json" << JSONEOF
{
  "name": "diet-n8n",
  "version": "${VERSION}",
  "bin": {
    "diet-n8n": "./node_modules/n8n/bin/n8n"
  },
  "scripts": {
    "postinstall": "node extract.js"
  },
  "os": ["${PKG_OS}"],
  "cpu": ["${PKG_CPU}"]
}
JSONEOF
echo "  $OUT_DIR/package.json generated (version matches n8n: ${VERSION})."

