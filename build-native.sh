#!/usr/bin/env bash
# Native build: npm install + apply-diet on the host (no Docker).
# Requires PLATFORM, OUT_DIR, SCRIPT_DIR in the environment.
set -euo pipefail

: "${PLATFORM:?PLATFORM required}"
: "${OUT_DIR:?OUT_DIR required}"
: "${SCRIPT_DIR:?SCRIPT_DIR required}"

BUILD_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$BUILD_ROOT"; }
trap cleanup EXIT

cd "$BUILD_ROOT"

echo "==> Installing n8n (production) ..."
npm init -y >/dev/null
npm install n8n --omit=dev --no-audit --no-fund

echo "==> Python task runner ..."
N8N_VER="$(node -p "require('./node_modules/n8n/package.json').version")"
mkdir -p node_modules/@n8n
MONOREPO_TGZ="$(mktemp)"
curl -fsSL "https://github.com/n8n-io/n8n/archive/refs/tags/n8n%40${N8N_VER}.tar.gz" -o "$MONOREPO_TGZ"
ROOT="$(tar tzf "$MONOREPO_TGZ" | head -1 | cut -d/ -f1)"
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
mkdir -p "$SCRIPT_DIR/$OUT_DIR/chunks"
tar -cf - node_modules | xz -9e | split -b 10M - "$SCRIPT_DIR/$OUT_DIR/chunks/node_modules.tar.xz."
node -p "require('./node_modules/n8n/package.json').version" > "$SCRIPT_DIR/$OUT_DIR/.n8n-version"
