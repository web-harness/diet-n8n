# diet-n8n — Agent Guide

## What this is

This is **not** an n8n fork or source-level modification. `diet-n8n` is a packaging tool that:
1. Installs the upstream `n8n` npm package with production deps
2. Runs a 15-step "diet" (`apply-diet.sh`) that strips runtime-unnecessary bloat from `node_modules/`
3. Compresses the result into 10 MB `tar.xz` chunks with SHA256 checksums
4. Publishes a tiny npm package whose `postinstall` hook (`extract.js`) downloads and verifies the chunks, then decompresses them

The actual n8n source code is never modified.

## Build

- **Requires Docker** (builds on `linux/amd64` only)
- `npm run build` → runs `bash build.sh`
- Output lands in `dist/` (for linux-x64) or `dist-<platform>/` for other platforms.
- The generated `package.json` has platform-specific `"os"` and `"cpu"` fields.
- n8n version is extracted at Docker build time from `node_modules/n8n/package.json`
- The prebuilt tarball `diet-n8n-2.20.6.tgz` at repo root was published to npm

## Format & Lint

- Single tool: **Biome** (`@biomejs/biome@^2`)
  - `npm run format` → `biome format --write`
  - `npm run lint` → `biome lint --fix`
- No ESLint, no Prettier
- Biome config: 2-space indent, 120 line width, double quotes (JS), git VCS integration, `organizeImports` on assist
- `dist/` directory is excluded from lint/format

## How the diet works

`apply-diet.sh` has 15 steps, run in order:

| Step | What it does |
|------|-------------|
| 0 | Traces n8n startup with `NODE_DEBUG=module` to log every `require()`'d path |
| 1 | Extracts a keep-list (`diet.txt`) from the trace — only packages actually loaded at runtime survive |
| 2–14 | Removes source maps, test data, `.d.ts`, non-ELF `.node` files, `.dll`/`.dylib`, browser bundles, build artifacts, docs/changelogs, config files, caches, Python runner caches |
| 15 | Cleans up trace artifacts |

Key insight: step 1 does **not** remove `n8n-*` or `acorn-*` scoped packages (they're always kept). Everything else is pruned unless it appeared in the runtime trace.

## Python task runner

The Docker build fetches the upstream n8n monorepo tag matching the installed n8n version, extracts `packages/@n8n/task-runner-python`, and builds **two** virtual environments (Python 3.12 and 3.13).

At extraction time (`extract.ts`), the postinstall script:
1. Detects the system Python version
2. Renames the matching `.venv.3.12` or `.venv.3.13` to `.venv`
3. Removes incompatible venvs
4. Runs `python -m venv .venv --upgrade`
5. Skips setup with warning on unsupported Python

## Postinstall extraction (`extract.ts`)

- Bundled by esbuild into `dist/extract.js` (minified, CJS, Node target)
- Verifies SHA256 of every chunk against `sha256sums.txt` before extraction
- Uses `xz-decompress` (WASM-based, no native xz binary required) and `tar-fs`
- Accepts `--dest` / `-d` argument or defaults to `__dirname`
- Dies with exit code 0 if n8n already present (idempotent)
- `DEBUG=dietn8n` for verbose logging

## Key env (from `minimal.env`)

Production-oriented minimal config. Notable disabled modules (optimized out for tight environments):
```
N8N_DISABLED_MODULES=insights,external-secrets,provisioning,breaking-changes,source-control,dynamic-credentials,chat-hub,sso-oidc,sso-saml,log-streaming,ldap,quick-connect,redaction,instance-registry,otel,token-exchange,instance-version-history,encryption-key-manager
```

Other flags set for constrained environments: metrics off, public API off, onboarding disabled, templates off, hiring banner off, workflow history pruning off.

## File conventions

- `*.ts` files use TypeScript with ES modules (`import/export`), `node:path`, `node:fs`, etc.
- Shell scripts use `set -euo pipefail`
- Biome auto-formats — don't fight it
- No tests, no CI workflows, no test infrastructure
