# Multi-stage skeleton
FROM node:24-bookworm-slim AS builder
SHELL ["/bin/bash", "-c"]

RUN set -e && set -o pipefail && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      file xz-utils \
      python3 python3-venv python3-pip \
      curl ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    npm config set min-release-age 3 --global && \
    pip config set install.uploaded-prior-to P3D --global

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Install n8n (production deps only)
RUN npm init -y && npm install n8n --omit=dev --no-audit --no-fund

# Set up the Python Task Runner from the n8n monorepo tag n8n@<semver>
RUN set -e && set -o pipefail && \
    N8N_VER="$(node -p "require('./node_modules/n8n/package.json').version")" && \
    mkdir -p node_modules/@n8n && \
    curl -fsSL "https://github.com/n8n-io/n8n/archive/refs/tags/n8n%40${N8N_VER}.tar.gz" -o /tmp/n8n-monorepo.tar.gz && \
    ROOT="$( ( tar tzf /tmp/n8n-monorepo.tar.gz 2>/dev/null || true ) | head -1 | cut -d/ -f1 )" && \
    test -n "$ROOT" && \
    tar xzf /tmp/n8n-monorepo.tar.gz -C /tmp "${ROOT}/packages/@n8n/task-runner-python" && \
    rm -f /tmp/n8n-monorepo.tar.gz && \
    rm -rf node_modules/@n8n/task-runner-python && \
    mv "/tmp/${ROOT}/packages/@n8n/task-runner-python" "node_modules/@n8n/task-runner-python" && \
    rm -rf "/tmp/${ROOT}" && \
    cd "node_modules/@n8n/task-runner-python" && \
    uv sync --no-dev && \
    uv cache clean && \
    # bin directory is meant to be recreated on the target machine with "python3 -m venv .venv --upgrade"
    rm -rf .venv/bin

# Diet: strip runtime-unnecessary bloat (apply-diet.sh sources minimal.env from SCRIPT_DIR)
COPY apply-diet.sh minimal.env /app/
RUN chmod +x apply-diet.sh && ./apply-diet.sh node_modules

# Create compressed archive split into 10 MB chunks
RUN set -e && set -o pipefail && \
    mkdir -p /out/chunks && \
    tar -cf - node_modules | xz -9e | split -b 10M - /out/chunks/node_modules.tar.xz.

FROM scratch AS export
COPY --from=builder /out /
