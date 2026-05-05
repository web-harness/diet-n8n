#!/usr/bin/env bash
# Diet-prune a node_modules directory for runtime-only Linux x64 deployment.
# Usage: ./apply-diet.sh [path-to-node_modules]
#   Defaults to ./node_modules if not specified.
set -euo pipefail

NODE_MODULES="${1:-node_modules}"
SELF_DIR="$(cd "$(dirname "$(dirname "$NODE_MODULES")")" && pwd)"
cd "$SELF_DIR"

if [[ ! -d "$NODE_MODULES" ]]; then
  echo "Usage: $0 [path-to-node_modules]"
  echo "Defaults to ./node_modules if not specified."
  exit 1
fi

echo "=== 1/10 Source maps ==="
find "$NODE_MODULES" -name "*.js.map" -delete

echo "=== 2/10 Test data (safe patterns only) ==="
find "$NODE_MODULES" -type d \( -name "__tests__" -o -name "__test__" -o -name "testdata" -o -name "test-data" -o -name "fixtures" -o -name "fixture" -o -name "__mocks__" \) -exec rm -rf {} + 2>/dev/null || true
find "$NODE_MODULES" -type f \( -name "*.test.*" -o -name "*.spec.*" -o -name "*.bench.*" \) -delete 2>/dev/null || true
rm -rf "$NODE_MODULES/pdf-parse/test" 2>/dev/null || true

echo "=== 3/10 TypeScript declarations ==="
find "$NODE_MODULES" -type f -name "*.d.ts" -delete 2>/dev/null || true
find "$NODE_MODULES" -type f -name "*.d.ts.map" -delete 2>/dev/null || true

echo "=== 4/10 Non-Linux native addons ==="
find "$NODE_MODULES" -type f -name "*.node" | while read -r file; do
    if ! file -b "$file" | grep -q "^ELF"; then
        echo "  REMOVED non-ELF: $file"
        rm -f "$file"
    fi
done
find "$NODE_MODULES" -type f \( -name "*.dll" -o -name "*.dylib" \) -delete 2>/dev/null || true

echo "=== 5/10 musl .node variants ==="
find "$NODE_MODULES" -type f -name "*.node" \( -path "*-musl*" -o -path "*musl*" \) -delete 2>/dev/null || true
find "$NODE_MODULES" -type d -name "*-musl" -exec rm -rf {} + 2>/dev/null || true

echo "=== 6/10 Browser-only bundles ==="
find "$NODE_MODULES" -type f -name "*.bc.js" -delete 2>/dev/null || true
find "$NODE_MODULES" -type f -name "*.browser.*" -not -name "*.browser.js" -delete 2>/dev/null || true

echo "=== 7/10 Build artifacts ==="
find "$NODE_MODULES" -type f \( -name "*.tar.gz" -o -name "*.o" -o -name "*.lo" -o -name "*.la" -o -name "*.a" -o -name "*.obj" -o -name "CMakeCache.txt" -o -name "Makefile" -o -name "cmake_install.cmake" -o -name "*.cmake" \) -delete 2>/dev/null || true
find "$NODE_MODULES" -type d \( -name "CMakeFiles" -o -name "cmake" -o -name "node-gyp" \) -exec rm -rf {} + 2>/dev/null || true
rm -rf "$NODE_MODULES/sqlite3/deps" 2>/dev/null || true

echo "=== 8/10 Docs, changelogs, licenses ==="
find "$NODE_MODULES" -type f \( -name "CHANGELOG*" -o -name "changelog*" -o -name "CHANGE*" -o -name "README*" -o -name "readme*" -o -name "AUTHORS*" -o -name "CONTRIBUTORS*" -o -name "PATENTS*" -o -name "LICENSE" -o -name "LICENSE.*" -o -name "LICENSE-*" -o -name "LICENCE" -o -name "LICENCE.*" -o -name "LICENCE-*" \) -delete 2>/dev/null || true

echo "=== 9/10 Config/metadata files ==="
find "$NODE_MODULES" -type f \( -name ".npmignore" -o -name ".gitignore" -o -name ".editorconfig" -o -name ".gitattributes" -o -name ".eslintrc*" -o -name ".prettierrc*" -o -name ".jshintrc" -o -name "tsconfig.json" -o -name "babel.config*" -o -name ".babelrc*" -o -name "rollup.config*" -o -name "webpack.config*" -o -name "jest.config*" -o -name "karma.conf*" -o -name ".nycrc*" -o -name "lint-staged*" -o -name ".huskyrc*" -o -name ".lintstagedrc*" \) -delete 2>/dev/null || true

echo "=== 10/10 Cache directories ==="
rm -rf "$NODE_MODULES/.cache" 2>/dev/null || true
find "$NODE_MODULES" -type d -name ".cache" -exec rm -rf {} + 2>/dev/null || true

echo "=== Pruning complete ==="
du -sh "$NODE_MODULES" | awk '{print "node_modules final size: " $0}'
