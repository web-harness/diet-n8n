#!/usr/bin/env bash
# Diet-prune a node_modules directory for a specific platform.
# Usage: ./apply-diet.sh [path-to-node_modules] [platform]
#   Platforms: win-x64, linux-x64, linux-arm64, macos-x64, macos-arm64
#   Defaults to ./node_modules and linux-x64.
set -euo pipefail

NM_INPUT="${1:-node_modules}"
SELF_DIR="$(cd "$(dirname "$NM_INPUT")" && pwd)"
NODE_MODULES="$(basename "$NM_INPUT")"
PLATFORM="${2:-linux-x64}"
# Platform mapping
case "$PLATFORM" in
  win-x64)      EXPECTED_OS="win32";  EXPECTED_ARCH="x64";    EXPECTED_FORMAT="PE32+"  ;;
  linux-x64)    EXPECTED_OS="linux";  EXPECTED_ARCH="x64";    EXPECTED_FORMAT="ELF"    ;;
  linux-arm64)  EXPECTED_OS="linux";  EXPECTED_ARCH="arm64";  EXPECTED_FORMAT="ELF"    ;;
  macos-x64)    EXPECTED_OS="darwin"; EXPECTED_ARCH="x64";    EXPECTED_FORMAT="Mach-O" ;;
  macos-arm64)  EXPECTED_OS="darwin"; EXPECTED_ARCH="arm64";  EXPECTED_FORMAT="Mach-O" ;;
  *) echo "ERROR: Unknown platform '$PLATFORM'. Valid: win-x64, linux-x64, linux-arm64, macos-x64, macos-arm64" >&2; exit 1 ;;
esac
cd "$SELF_DIR"

if [[ ! -d "$NODE_MODULES" ]]; then
  echo "Usage: $0 [path-to-node_modules]"
  echo "Defaults to ./node_modules if not specified."
  exit 1
fi

N8N_PORT="${N8N_PORT:-5678}"
LOGS_TXT="${LOGS_TXT:-logs.txt}"
DIET_TXT="${DIET_TXT:-diet.txt}"
SERVER_WAIT_SECS="${SERVER_WAIT_SECS:-180}"
POST_READY_SECS="${POST_READY_SECS:-15}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== 0/15 n8n trace (NODE_DEBUG=module) → ${LOGS_TXT} ==="
rm -f "$LOGS_TXT"
N8N_TRACE_DIR="${SELF_DIR}/.n8n-diet-trace"
rm -rf "$N8N_TRACE_DIR"
mkdir -p "$N8N_TRACE_DIR"

set -a
# shellcheck source=minimal.env
source "$SCRIPT_DIR/minimal.env"
set +a

export N8N_USER_FOLDER="$N8N_TRACE_DIR"
# Trace only: PostHogClient skips require('posthog-node') when diagnostics is off.
export N8N_DIAGNOSTICS_ENABLED=true

NODE_DEBUG=module npx n8n &>>"$LOGS_TXT" &
n8n_pid=$!

ready=0
for ((i = 0; i < SERVER_WAIT_SECS; i++)); do
  if ! kill -0 "$n8n_pid" 2>/dev/null; then
    break
  fi
  if bash -c "exec 3<>/dev/tcp/127.0.0.1/${N8N_PORT}; exec 3<&-; exec 3>&-" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done

[[ "$ready" -eq 1 ]]
for _ in $(seq 1 10); do
  node -e "const h=require('http');const port=process.env.N8N_PORT;['/','/healthz'].forEach((pth)=>{h.get('http://127.0.0.1:'+port+pth,(r)=>r.resume()).on('error',()=>{});});" || true
  sleep 2
done
sleep "$POST_READY_SECS"
kill -TERM "$n8n_pid" 2>/dev/null || true
wait "$n8n_pid" 2>/dev/null || true

[[ -s "$LOGS_TXT" ]]

echo "=== 1/15 Build ${DIET_TXT} from node_modules/* paths in ${LOGS_TXT} ==="
grep -ohE 'node_modules/(@[^/[:space:]]+/[^/[:space:]]+|[^/[:space:]@]+)' "$LOGS_TXT" \
  | sed 's|^node_modules/||' \
  | while read -r rest; do
      [[ -n "$rest" ]] || continue
      printf '%s\n' "${rest%%/*}"
    done | sort -u >"$DIET_TXT.tmp"
sort -u "$DIET_TXT.tmp" -o "$DIET_TXT"
rm -f "$DIET_TXT.tmp"
[[ -s "$DIET_TXT" ]]

echo "=== 2/15 Top-level prune (diet.txt + n8n-* / acorn-* keep, same as trace/diet.js) ==="
while IFS= read -r -d '' top; do
  name="$(basename "$top")"
  [[ "$name" == "." || "$name" == ".." ]] && continue
  if [[ "$name" == n8n-* || "$name" == acorn-* ]]; then
    continue
  fi
  if grep -Fxq "$name" "$DIET_TXT"; then
    continue
  fi
  echo "  REMOVED top-level package dir: $name"
  rm -rf "$top"
done < <(find "$NODE_MODULES" -mindepth 1 -maxdepth 1 -type d -print0)

echo "=== 3/15 Native prebuilds pruning (target: $PLATFORM) ==="
if [[ "$EXPECTED_ARCH" == "x64" ]]; then
  find "$NODE_MODULES" -type f -name '*.node' \( -iname '*arm64*' -o -path '*linux-arm64*' \) -delete 2>/dev/null || true
  find "$NODE_MODULES" -type d \( -name 'linux-arm64' -o -name '*-linux-arm64-gnu' -o -name '*-linux-arm64-musl' \) -prune -exec rm -rf {} + 2>/dev/null || true
else
  find "$NODE_MODULES" -type f -name '*.node' \( -iname '*x64*' -o -path '*linux-x64*' \) -delete 2>/dev/null || true
  find "$NODE_MODULES" -type d \( -name 'linux-x64' -o -name '*-linux-x64-gnu' -o -name '*-linux-x64-musl' \) -prune -exec rm -rf {} + 2>/dev/null || true
fi

echo "=== 4/15 Source maps, CSS maps, Flow ==="
find "$NODE_MODULES" \( -name "*.js.map" -o -name "*.css.map" \) -delete
find "$NODE_MODULES" -type f -name "*.flow" -delete 2>/dev/null || true

echo "=== 5/15 Test data (safe patterns only) ==="
find "$NODE_MODULES" -type d \( \
  -name "__tests__" -o -name "__test__" -o -name "testdata" -o -name "test-data" \
  -o -name "fixtures" -o -name "fixture" -o -name "__mocks__" \
  -o -name "test" \
  -o -name "coverage" \
  -o -name "benchmark" -o -name "benchmarks" -o -name "e2e" \
  -o -name "__snapshots__" -o -name "demo" -o -name "demos" \
  -o -name ".github" \
  \) -exec rm -rf {} + 2>/dev/null || true
find "$NODE_MODULES" -type f \( -name "*.test.*" -o -name "*.spec.*" -o -name "*.bench.*" \) -delete 2>/dev/null || true

echo "=== 6/15 TypeScript declarations ==="
find "$NODE_MODULES" -type f -name "*.d.ts" -delete 2>/dev/null || true
find "$NODE_MODULES" -type f -name "*.d.ts.map" -delete 2>/dev/null || true

echo "=== 7/15 Native addons pruning (target: $PLATFORM) ==="
_keep_native_for_platform() {
  local file="$1"
  local file_output
  file_output=$(file -b "$file")
  # Check format
  if ! echo "$file_output" | grep -q "$EXPECTED_FORMAT"; then
    return 1
  fi
  # Check arch
  if [[ "$EXPECTED_ARCH" == "x64" ]]; then
    if ! echo "$file_output" | grep -qE "x86-64|x86_64"; then
      return 1
    fi
  else
    if ! echo "$file_output" | grep -qE "aarch64|arm64"; then
      return 1
    fi
  fi
  return 0
}

find "$NODE_MODULES" -type f -name "*.node" | while read -r file; do
    if ! _keep_native_for_platform "$file"; then
        echo "  REMOVED non-matching native: $file"
        rm -f "$file"
    fi
done

if [[ "$EXPECTED_OS" != "win32" ]]; then
  find "$NODE_MODULES" -type f -name "*.dll" -delete 2>/dev/null || true
fi
if [[ "$EXPECTED_OS" != "darwin" ]]; then
  find "$NODE_MODULES" -type f -name "*.dylib" -delete 2>/dev/null || true
fi

echo "=== 8/15 musl .node variants ==="
find "$NODE_MODULES" -type f -name "*.node" \( -path "*-musl*" -o -path "*musl*" \) -delete 2>/dev/null || true
find "$NODE_MODULES" -type d -name "*-musl" -exec rm -rf {} + 2>/dev/null || true

echo "=== 9/15 Browser-only bundles ==="
find "$NODE_MODULES" -type f -name "*.bc.js" -delete 2>/dev/null || true
find "$NODE_MODULES" -type f -name "*.browser.*" -not -name "*.browser.js" -delete 2>/dev/null || true

echo "=== 10/15 Build artifacts ==="
find "$NODE_MODULES" -type f \( -name "*.tar.gz" -o -name "*.o" -o -name "*.lo" -o -name "*.la" -o -name "*.a" -o -name "*.obj" -o -name "CMakeCache.txt" -o -name "Makefile" -o -name "cmake_install.cmake" -o -name "*.cmake" \) -delete 2>/dev/null || true
find "$NODE_MODULES" -type d \( -name "CMakeFiles" -o -name "cmake" -o -name "node-gyp" \) -exec rm -rf {} + 2>/dev/null || true
rm -rf "$NODE_MODULES/sqlite3/deps" 2>/dev/null || true

echo "=== 11/15 Docs, changelogs, licenses ==="
find "$NODE_MODULES" -type f \( -name "CHANGELOG*" -o -name "changelog*" -o -name "CHANGE*" -o -name "README*" -o -name "readme*" -o -name "AUTHORS*" -o -name "CONTRIBUTORS*" -o -name "PATENTS*" -o -name "LICENSE" -o -name "LICENSE.*" -o -name "LICENSE-*" -o -name "LICENCE" -o -name "LICENCE.*" -o -name "LICENCE-*" \) -delete 2>/dev/null || true

echo "=== 12/15 Config/metadata files ==="
find "$NODE_MODULES" -type f \( -name ".npmignore" -o -name ".gitignore" -o -name ".editorconfig" -o -name ".gitattributes" -o -name ".eslintrc*" -o -name ".prettierrc*" -o -name ".jshintrc" -o -name "tsconfig.json" -o -name "babel.config*" -o -name ".babelrc*" -o -name "rollup.config*" -o -name "webpack.config*" -o -name "jest.config*" -o -name "karma.conf*" -o -name ".nycrc*" -o -name "lint-staged*" -o -name ".huskyrc*" -o -name ".lintstagedrc*" \) -delete 2>/dev/null || true

echo "=== 13/15 Cache directories ==="
rm -rf "$NODE_MODULES/.cache" 2>/dev/null || true
find "$NODE_MODULES" -type d -name ".cache" -exec rm -rf {} + 2>/dev/null || true

echo "=== 14/15 Python task runner trim (tests, caches, venv __pycache__) ==="
TRP="${NODE_MODULES}/@n8n/task-runner-python"
if [[ -d "$TRP" ]]; then
  rm -rf "$TRP/tests" 2>/dev/null || true
  find "$TRP" -depth \( -name '__pycache__' -o -name '.pytest_cache' -o -name '.ruff_cache' -o -name '.mypy_cache' \) -exec rm -rf {} + 2>/dev/null || true
fi

echo "=== 15/15 Trace cleanup ==="
rm -rf "$N8N_TRACE_DIR" 2>/dev/null || true
rm -f "$LOGS_TXT"

echo "=== Pruning complete ==="
du -sh "$NODE_MODULES" | awk '{print "node_modules final size: " $0}'
