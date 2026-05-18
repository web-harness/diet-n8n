#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

show_usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Build diet-n8n packaging and generate SHA256 checksums on the host machine.

Options:
  --help, -h             Show this help message and exit
  --platform, -p <ID>    Target platform ID (default: linux-x64)
                        Supported: win-x64, linux-x64, linux-arm64, macos-x64, macos-arm64
EOF
}

host_platform_id() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64) echo "linux-x64" ;;
        aarch64|arm64) echo "linux-arm64" ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        x86_64) echo "macos-x64" ;;
        arm64|aarch64) echo "macos-arm64" ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*|*MINGW*|*NT*)
      case "$arch" in
        x86_64|amd64) echo "win-x64" ;;
      esac
      ;;
  esac
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

HOST_PLATFORM="$(host_platform_id || true)"
if [[ "$HOST_PLATFORM" != "$PLATFORM" ]]; then
  echo "Error: --platform $PLATFORM must be built on a matching host (detected: ${HOST_PLATFORM:-unknown})." >&2
  exit 1
fi

if [[ "$PLATFORM" == "linux-x64" ]]; then
  OUT_DIR="dist"
else
  OUT_DIR="dist-${PLATFORM}"
fi

echo "==> Cleaning $OUT_DIR/ ..."
rm -rf "$SCRIPT_DIR/$OUT_DIR"
mkdir -p "$SCRIPT_DIR/$OUT_DIR/chunks"

BUILD_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$BUILD_ROOT"; }
trap cleanup EXIT

cd "$BUILD_ROOT"

echo "==> Installing n8n (production) ..."
npm config set min-release-age 3 --global
pip config set install.uploaded-prior-to P3D --global 2>/dev/null || true
npm init -y >/dev/null
npm install n8n --omit=dev --no-audit --no-fund

echo "==> Python task runner ..."
N8N_VER="$(node -p "require('./node_modules/n8n/package.json').version")"
mkdir -p node_modules/@n8n
MONOREPO_TGZ="$(mktemp)"
curl -fsSL "https://github.com/n8n-io/n8n/archive/refs/tags/n8n%40${N8N_VER}.tar.gz" -o "$MONOREPO_TGZ"
ROOT="$( ( tar tzf "$MONOREPO_TGZ" 2>/dev/null || true ) | head -1 | cut -d/ -f1 )"
test -n "$ROOT"
tar xzf "$MONOREPO_TGZ" -C /tmp "${ROOT}/packages/@n8n/task-runner-python"
rm -f "$MONOREPO_TGZ"
rm -rf node_modules/@n8n/task-runner-python
mv "/tmp/${ROOT}/packages/@n8n/task-runner-python" "node_modules/@n8n/task-runner-python"
rm -rf "/tmp/${ROOT}"

cd "node_modules/@n8n/task-runner-python"
uv python install 3.12 3.13
cp pyproject.toml /tmp/pyproject.toml.orig
sed 's/requires-python = ">=3.13"/requires-python = ">=3.12"/' pyproject.toml > pyproject.toml.tmp && mv pyproject.toml.tmp pyproject.toml
uv sync --no-dev --python 3.12
mv .venv .venv.3.12
cp /tmp/pyproject.toml.orig pyproject.toml
uv sync --no-dev --python 3.13
mv .venv .venv.3.13
rm -rf .venv.3.12/bin .venv.3.13/bin
uv cache clean
cd "$BUILD_ROOT"

echo "==> Diet (apply-diet.sh) ..."
cp "$SCRIPT_DIR/apply-diet.sh" "$SCRIPT_DIR/minimal.env" .
chmod +x apply-diet.sh
./apply-diet.sh node_modules "$PLATFORM"

echo "==> Chunking node_modules ..."
tar -cf - node_modules | xz -9e | split -b 10M - "$SCRIPT_DIR/$OUT_DIR/chunks/node_modules.tar.xz."
node -p "require('./node_modules/n8n/package.json').version" > "$SCRIPT_DIR/$OUT_DIR/.n8n-version"

N8N_VERSION_FILE="$SCRIPT_DIR/$OUT_DIR/.n8n-version"
if [[ ! -f "$N8N_VERSION_FILE" ]]; then
    echo "Error: $N8N_VERSION_FILE is missing (build did not emit repackaged n8n version)."
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
    "diet-n8n": "./node_modules/n8n/bin/n8n",
    "n8n": "./node_modules/n8n/bin/n8n"
  },
  "scripts": {
    "postinstall": "node extract.js"
  },
  "os": ["${PKG_OS}"],
  "cpu": ["${PKG_CPU}"]
}
JSONEOF
echo "  $OUT_DIR/package.json generated (version matches n8n: ${VERSION})."
