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

To automate the first time admin user creation:

```sh
curl -X POST http://localhost:5678/rest/owner \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Admin",
    "lastName": "Local",
    "email": "admin@localhost.com",
    "password": "21JumpStreet"
  }'
```

Tune [minimal.env](minimal.env) further according to the [official documentation](https://docs.n8n.io/hosting/configuration/environment-variables/) to suit your setup.

## Synopsis

The vanilla n8n package downloads about 2GB of npm dependencies, and it does not load all of them at once. Indirectly, it also pulls in dependencies that ship *many* native Node `.node` modules for various platforms, regardless of which platform you are using.

That makes it extremely hard to host n8n in tight Linux environments; for example, on a tiny Raspberry Pi with less than 1GB of SD card storage.

Diet n8n applies a "diet" to the upstream package and strips out anything that is not immediately loaded by n8n core and native binaries for platforms you are not targeting. Diet n8n then compresses the result into 10MB tar.xz chunks for easier distribution.

## Build

Requires Node 24, Python 3.12 or 3.13, pip, venv, and [uv](https://github.com/astral-sh/uv).

```sh
npm install
npm run build
```

Set `DIET_TARGET` to one of `linux-x64`, `linux-arm64`, `win-x64`, `mac-x64`, `mac-arm64` (default: host OS/arch). Output lands in `dist/`.

The result is a reduction from somewhere north of 2GB to about 35MB (compressed).

Diet n8n extracts the chunks in a post-install script, which unpacks to about 600MB on disk.

## Disclaimer

This project is in no way associated with the upstream n8n project.
