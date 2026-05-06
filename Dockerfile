# Multi-stage skeleton
FROM node:22-bookworm-slim AS builder
SHELL ["/bin/bash", "-c"]

RUN set -e && set -o pipefail && \
    apt-get update && \
    apt-get install -y --no-install-recommends file xz-utils && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install n8n (production deps only)
RUN npm init -y && npm install n8n --omit=dev --no-audit --no-fund

# Diet: strip runtime-unnecessary bloat
COPY apply-diet.sh /app/
RUN chmod +x apply-diet.sh && ./apply-diet.sh node_modules

# Create compressed archive split into 10 MB chunks
RUN set -e && set -o pipefail && \
    mkdir -p /out/chunks && \
    tar -cf - node_modules | xz -9e | split -b 10M - /out/chunks/node_modules.tar.xz.

FROM scratch AS export
COPY --from=builder /out /
