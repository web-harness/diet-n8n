# T1: Multi-stage skeleton
FROM node:22-bookworm-slim AS builder
SHELL ["/bin/bash", "-c"]

# Install file utility and other needed tools
RUN set -e && set -o pipefail && \
    apt-get update && \
    apt-get install -y --no-install-recommends file xz-utils && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# T1: Install n8n
COPY package.json package-lock.json ./
RUN set -e && set -o pipefail && \
    npm install

# T2: .node pruning
# Find + file -b, remove non-x86-64, log each as "REMOVED arch: path"
# CRITICAL: Check the FULL file -b output for "x86-64" not just the ELF prefix,
# because 'file -b' output is "ELF 64-bit LSB shared object, x86-64, ..."
# and the x86-64 part comes AFTER the first comma.
RUN set -e && set -o pipefail && \
    find node_modules -type f -name "*.node" | while read -r file; do \
        if ! file -b "$file" | grep -q "x86-64"; then \
            arch=$(file -b "$file" | grep -oE "x86-64|ARM|aarch64|ELF [^,]+" | head -1 || echo "unknown"); \
            echo "REMOVED $arch: $file"; \
            rm -f "$file"; \
        fi; \
    done

# T3: .wasm pruning
# remove targeted high-bloat WASM packages (onnxruntime-*, @tensorflow/*, @xenova/*, @anthropic-ai/*)
RUN set -e && set -o pipefail && \
    find node_modules -name "*.wasm" | while read -r file; do \
        if [[ "$file" =~ onnxruntime-|@tensorflow/|@xenova/|@anthropic-ai/ ]]; then \
            echo "REMOVED WASM: $file"; \
            rm -rf "$file"; \
        fi; \
    done && \
    find node_modules -name "package.json" -printf "%h\n" | while read -r dir; do \
        if [[ "$dir" =~ onnxruntime-|@tensorflow/|@xenova/|@anthropic-ai/ ]]; then \
            echo "REMOVED WASM DIR: $dir"; \
            rm -rf "$dir"; \
        fi; \
    done || true

# T4: Chunking pipeline
# tar | xz | split into /out/chunks/
RUN set -e && set -o pipefail && \
    mkdir -p /out/chunks && \
    tar -cf - node_modules package.json package-lock.json | xz -9e | split -b 10M - /out/chunks/node_modules.tar.xz.

# Verification step in builder: check archive reconstructibility
RUN set -e && set -o pipefail && \
    cd /out/chunks && \
    cat node_modules.tar.xz.* | tar -xJf - -C /app/ && \
    test -f /app/package.json && test -f /app/package-lock.json && \
    echo "Verification: Archive reconstructibility passed (node_modules + metadata)"

# T1: Export stage
FROM scratch AS export
COPY --from=builder /out /
