# diet-n8n

n8n repackaged for tight environments.

---

> If you landed here by accident, you should know that this is probably not what you are looking for. Use the official [n8n packages](https://www.npmjs.com/package/n8n), unless you have disk space or memory constraints; in which case, keep reading.

---

## Usage

Download your platform's distribution from the [Releases](https://github.com/web-harness/diet-n8n/releases) page.

```sh
npm install diet-n8n-<version>-<platform>.tgz
cd node_modules/diet-n8n
npm start
```

## Synopsis

The vanilla n8n package downloads about 2GB of npm dependencies, and it does not load all of them at once. Indirectly, it also pulls in dependencies that ship *many* native Node `.node` modules for various platforms, regardless of which platform you are using.

That makes it extremely hard to host n8n in tight environments; for example, on a tiny Raspberry Pi with less than 1GB of SD card storage.

diet-n8n applies a "diet" to the upstream package and strips out anything that is not immediately loaded by n8n core and native binaries for platforms you are not targeting. diet-n8n then compresses the result into 10MB tar.xz chunks for easier distribution.

## Build

Requires Node 24, Python 3.12 or 3.13, pip, venv, and [uv](https://github.com/astral-sh/uv).

```sh
npm install
npm run build
```

Set `DIET_TARGET` to one of `linux-x64`, `linux-arm64`, `win-x64`, `mac-x64`, `mac-arm64` (default: host OS/arch). Output lands in `dist/`.

The build starts a local [llamafile](https://github.com/Mozilla-Ocho/llamafile) inference server and runs a committed `workflow.json` (Chat Trigger → AI Agent → OpenAI Chat Model) during the `NODE_DEBUG=module` trace so AI node dependencies are retained. Export that workflow once from the n8n editor and commit it at the repo root; the build fails if it is missing. Llamafile is downloaded into `build/.llamafile/` (not shipped in dist).

The result is a reduction from somewhere north of 2GB to about 35MB (compressed).

diet-n8n extracts the chunks in a post-install script, which unpacks to about 600MB on disk.

## Auth bypass

diet-n8n ships an [external hook](https://docs.n8n.io/hosting/configuration/external-hooks/) (`hooks.js`) that auto-issues an `n8n-auth` session cookie for the instance owner defined in `minimal.env` (`N8N_INSTANCE_OWNER_EMAIL`, default `admin@localhost.com`). The login screen is skipped for normal UI use.

`launch.js` sets `EXTERNAL_HOOK_FILES` automatically. Set `N8N_DIET_AUTO_LOGIN=false` to restore the standard login flow (for debugging).

## Security

- Anyone who can reach the n8n HTTP port is treated as the instance owner. Do not expose diet-n8n directly to the internet; put it behind a trusted reverse proxy or bind to localhost only.

- diet-n8n is designed to be an open sandbox and allows full on code execution on your host. This is not for production use out of the box. You will need to secure it based on your environment.

## Disclaimer

This project is in no way associated with the upstream n8n project.
