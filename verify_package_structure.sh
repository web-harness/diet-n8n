#!/usr/bin/env bash
set -euo pipefail

# Verify package structure: dist/ artifacts and root package.json constraints.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FAILED=false

check() {
  local label="$1"
  shift
  if "$@" &>/dev/null; then
    echo "[PASS] $label"
  else
    echo "[FAIL] $label"
    FAILED=true
  fi
}

# --- dist/package.json checks ---

# Check 1: dist/package.json exists and is valid JSON
check "dist/package.json exists and valid JSON" \
  bash -c 'test -f "$1/dist/package.json" && node -e "JSON.parse(require(\"fs\").readFileSync(\"$1/dist/package.json\"))"' _ "$SCRIPT_DIR"

# Check 2: dist/package.json has "bin" field with correct path
check 'dist/package.json bin["diet-n8n"] === "./node_modules/n8n/bin/n8n"' \
  env PKG="$SCRIPT_DIR/dist/package.json" node -e 'const p=JSON.parse(require("fs").readFileSync(process.env.PKG,"utf8")); process.exit(p.bin&&p.bin["diet-n8n"]==="./node_modules/n8n/bin/n8n"?0:1)'

# Check 3: dist/package.json has scripts.postinstall === "node extract.js"
check 'dist/package.json scripts.postinstall === "node extract.js"' \
  env PKG="$SCRIPT_DIR/dist/package.json" node -e 'const p=JSON.parse(require("fs").readFileSync(process.env.PKG,"utf8")); process.exit(p.scripts&&p.scripts.postinstall==="node extract.js"?0:1)'

# Check 4: dist/package.json has "os": ["linux"]
check 'dist/package.json os contains "linux"' \
  env PKG="$SCRIPT_DIR/dist/package.json" node -e 'const p=JSON.parse(require("fs").readFileSync(process.env.PKG,"utf8")); process.exit(Array.isArray(p.os)&&p.os.includes("linux")?0:1)'

# Check 5: dist/package.json has "cpu": ["x64"]
check 'dist/package.json cpu contains "x64"' \
  env PKG="$SCRIPT_DIR/dist/package.json" node -e 'const p=JSON.parse(require("fs").readFileSync(process.env.PKG,"utf8")); process.exit(Array.isArray(p.cpu)&&p.cpu.includes("x64")?0:1)'

# Check 6: dist/package.json version is non-empty string
check 'dist/package.json version is non-empty string' \
  env PKG="$SCRIPT_DIR/dist/package.json" node -e 'const p=JSON.parse(require("fs").readFileSync(process.env.PKG,"utf8")); process.exit(typeof p.version==="string"&&p.version.length>0?0:1)'

# --- dist/ file checks ---

# Check 7: dist/extract.js exists and is non-empty
check "dist/extract.js exists and non-empty" \
  bash -c 'test -f "$1/dist/extract.js" && test -s "$1/dist/extract.js"' _ "$SCRIPT_DIR"

# Check 8: dist/extract.js contains no require("tar-fs") or require("xz-decompress")
check "dist/extract.js has no tar-fs or xz-decompress require" \
  bash -c '! grep -qi "require.*tar-fs" "$1/dist/extract.js" && ! grep -qi "require.*xz-decompress" "$1/dist/extract.js"' _ "$SCRIPT_DIR"

# Check 9: dist/chunks/ directory exists with at least one chunk file
check "dist/chunks/ exists with at least one chunk file" \
  bash -c 'test -d "$1/dist/chunks" && test "$(ls -A "$1/dist/chunks" 2>/dev/null)" != ""' _ "$SCRIPT_DIR"

# Check 10: dist/sha256sums.txt exists
check "dist/sha256sums.txt exists" \
  test -f "$SCRIPT_DIR/dist/sha256sums.txt"

# --- root package.json checks ---

# Check 11: Root package.json has NO "main" field
check "root package.json has NO main field" \
  env PKG="$SCRIPT_DIR/package.json" node -e 'const p=JSON.parse(require("fs").readFileSync(process.env.PKG,"utf8")); process.exit(p.main===undefined?0:1)'

# Check 12: Root package.json has NO "bin" field
check "root package.json has NO bin field" \
  env PKG="$SCRIPT_DIR/package.json" node -e 'const p=JSON.parse(require("fs").readFileSync(process.env.PKG,"utf8")); process.exit(p.bin===undefined?0:1)'

# Check 13: Root package.json has NO "files" field
check "root package.json has NO files field" \
  env PKG="$SCRIPT_DIR/package.json" node -e 'const p=JSON.parse(require("fs").readFileSync(process.env.PKG,"utf8")); process.exit(p.files===undefined?0:1)'

# Check 14: Root package.json dependencies has NO tar-fs or xz-decompress
check "root package.json dependencies has NO tar-fs or xz-decompress" \
  env PKG="$SCRIPT_DIR/package.json" node -e 'const p=JSON.parse(require("fs").readFileSync(process.env.PKG,"utf8")); const d=p.dependencies||{}; process.exit(!d["tar-fs"]&&!d["xz-decompress"]?0:1)'

# Check 15: Root package.json devDependencies HAS tar-fs, xz-decompress, esbuild
check "root package.json devDependencies HAS tar-fs, xz-decompress, esbuild" \
  env PKG="$SCRIPT_DIR/package.json" node -e 'const p=JSON.parse(require("fs").readFileSync(process.env.PKG,"utf8")); const d=p.devDependencies||{}; process.exit(d["tar-fs"]&&d["xz-decompress"]&&d["esbuild"]?0:1)'

# --- Result ---

if [ "$FAILED" = true ]; then
  echo ""
  echo "Verification FAILED."
  exit 1
fi

echo ""
echo "All checks passed."
exit 0
