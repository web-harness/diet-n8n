# diet-n8n

n8n repackaged for tight environments.

---

> If you landed here by accident, you should know that this is probably not what you are looking for. Use the official [n8n packages](https://www.npmjs.com/package/n8n), unless you have disk space or memory constraints; in which case, keep reading.

---

## Usage

```sh
npm install diet-n8n
```

Sample bare minimum, **insecure**, and sandbox launch with [minimal.env](minimal.env):

```sh
npx -y dotenv-cli -e minimal.env n8n
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

Diet n8n applies a "diet" to the upstream package and strips out anything that is not immediately loaded by n8n core and all non-Linux x64 binaries. Diet n8n then compresses the resulting package into 10MB tar.xz archives so it can be downloaded in chunks more easily.

The result is a reduction from somewhere north of 2GB to about 30MB (compressed).

Diet n8n extracts the chunks in a post-install script, which unpacks to about 600MB on disk.

## Disclaimer

This project is in no way associated with the upstream n8n project.
