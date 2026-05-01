#!/usr/bin/env bash
set -euo pipefail

# Script to verify the integrity, architecture, and functionality of the distribution chunks.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_CHUNKS_DIR="$SCRIPT_DIR/dist/chunks"
VERIFY_DIR="/tmp/verify-dist"

# Default flags
KEEP_TEMP=false
SKIP_FUNC=false

usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Options:
  --keep-temp    Preserve $VERIFY_DIR on success for debugging.
  --skip-func    Skip functional require() tests.
  --help         Show this help message.

EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --keep-temp) KEEP_TEMP=true; shift ;;
        --skip-func) SKIP_FUNC=true; shift ;;
        --help) usage; exit 0 ;;
        *) echo "Unknown option: $1"; usage; exit 1 ;;
    esac
done

echo "--- Starting Distribution Verification ---"

# 0. Pre-flight check
if [[ ! -d "$DIST_CHUNKS_DIR" ]]; then
    echo "[FAIL] Distribution chunks directory not found: $DIST_CHUNKS_DIR"
    exit 1
fi

# 1. Integrity Check
echo "[1/3] Integrity Check..."
rm -rf "$VERIFY_DIR" && mkdir -p "$VERIFY_DIR"

if ! cat "$DIST_CHUNKS_DIR"/node_modules.tar.xz.* | tar -xJf - -C "$VERIFY_DIR" 2>/dev/null; then
    echo "[FAIL] Integrity Check: Failed to extract chunks."
    exit 1
else
    echo "[PASS] Integrity Check: Chunks extracted successfully."
fi

# Verify specific files exist
INTEGRITY_PASS=true
FILES_TO_CHECK=(
    "$VERIFY_DIR/package.json"
    "$VERIFY_DIR/node_modules/n8n/package.json"
    "$VERIFY_DIR/node_modules/.package-lock.json"
)

for f in "${FILES_TO_CHECK[@]}"; do
    if [[ -f "$f" ]]; then
        echo "[PASS] Found $f"
    else
        echo "[FAIL] Missing $f"
        INTEGRITY_PASS=false
    fi
done

if [[ "$INTEGRITY_PASS" = false ]]; then
    echo "[FAIL] Integrity Check: Essential files missing."
    exit 1
fi

# 2. Architecture Check
echo "[2/3] Architecture Check..."
# Find all .node files and check if they are x86-64
# We use a subshell to avoid exit 1 from the main script immediately when we find a mismatch
# so we can print the offending file.

NON_X86_64_FILES=$(find "$VERIFY_DIR/node_modules" -name '*.node' -type f -exec sh -c 'file -b "$1" | grep -qv "x86-64"' _ {} \; -print || true)

# Count total .node files
TOTAL_NODE_FILES=$(find "$VERIFY_DIR/node_modules" -name '*.node' -type f | wc -l)
# Count non-x86-64
NON_X86_64_COUNT=$(echo "$NON_X86_64_FILES" | grep -c . || true)

if [[ $NON_X86_64_COUNT -gt 0 ]]; then
    echo "[FAIL] Architecture Check: Found $NON_X86_64_COUNT non-x86-64 .node files:"
    echo "$NON_X86_64_FILES"
    ARCH_PASS=false
else
    echo "[PASS] Architecture Check: All $TOTAL_NODE_FILES .node files are x86-64."
    ARCH_PASS=true
fi

# 3. Functional Test
echo "[3/3] Functional Test..."
FUNC_PASS=true
FUNC_COUNT=0
FUNC_FAILED=0

if [[ "$SKIP_FUNC" = true ]]; then
    echo "[SKIP] Functional tests skipped."
    FUNC_SKIPPED=true
else
    FUNC_SKIPPED=false
    export NODE_PATH="$VERIFY_DIR/node_modules"
    PACKAGES=("n8n" "n8n-core" "n8n-nodes-base")
    TOTAL_FUNC_COUNT=${#PACKAGES[@]}

    for pkg in "${PACKAGES[@]}"; do
        if node -e "require('$pkg')" >/dev/null 2>&1; then
            echo "[PASS] require(\"$pkg\")"
            FUNC_COUNT=$((FUNC_COUNT + 1))
        else
            # Get actual error
            ERR=$(node -e "require('$pkg')" 2>&1 || true)
            echo "[FAIL] require(\"$pkg\"): $ERR"
            FUNC_FAILED=$((FUNC_FAILED + 1))
            FUNC_PASS=false
        fi
    done
fi

# Final Summary
echo "----------------------------------------"
echo "Summary:"
echo "Integrity: PASS"
echo "Architecture: $TOTAL_NODE_FILES .node files, $NON_X86_64_COUNT non-x86-64"
if [[ "$FUNC_SKIPPED" = true ]]; then
    echo "Functional: SKIPPED"
else
    echo "Functional: $FUNC_COUNT/$TOTAL_FUNC_COUNT passed, $FUNC_FAILED failed"
fi
echo "----------------------------------------"

# Cleanup
if [[ "$FUNC_PASS" = true && "$ARCH_PASS" = true ]]; then
    if [[ "$KEEP_TEMP" = false ]]; then
        rm -rf "$VERIFY_DIR"
        echo "Cleanup: $VERIFY_DIR removed."
    else
        echo "Cleanup: $VERIFY_DIR preserved (--keep-temp)."
    fi
    exit 0
else
    echo "Verification FAILED. $VERIFY_DIR preserved for debugging."
    exit 1
fi
