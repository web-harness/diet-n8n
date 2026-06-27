import assert from "assert";
import crypto from "crypto";
import https from "https";
import os from "os";
import path from "path";
import { finished, pipeline } from "stream/promises";
import zlib from "zlib";
import fs from "fs";
import * as tar from "tar";
import tarFs from "tar-fs";
import { parse as parseEnv } from "dotenv";
import esbuild from "esbuild";
import { fileTypeFromFile } from "file-type";
import { glob } from "glob";
import lzma from "lzma-native";
import waitOn from "wait-on";

import { $, cd, chalk, within, type ProcessPromise } from "zx";

const ROOT = __dirname;
const NPMRC = path.join(ROOT, ".npmrc");
const PIP_CONF = path.join(ROOT, "pip.conf");
const UV_CONF = path.join(ROOT, "uv.toml");
const BUILD_DIR = path.join(ROOT, "build");
const DIST_DIR = path.join(ROOT, "dist");
const MINIMAL_ENV = path.join(ROOT, "minimal.env");
const WORKFLOW_JSON = path.join(ROOT, "workflow.json");
const LLAMAFILE_URL = "https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/Qwen3.5-0.8B-Q8_0.llamafile";
const LLAMAFILE_NAME = "Qwen3.5-0.8B-Q8_0.llamafile";
const LLAMAFILE_EXPECTED_BYTES = 1_339_309_799;
const LLAMAFILE_DIR = path.join(BUILD_DIR, ".llamafile");
const NM = "node_modules";
const BUILD_NM = path.join(BUILD_DIR, NM);
const CHUNK = 10 * 1024 * 1024;
const PYTHON_BIN = process.env.DIET_N8N_PYTHON_BIN || "python3";

type DietTarget = "linux-x64" | "linux-arm64" | "win-x64" | "mac-x64" | "mac-arm64";

const TARGET: Record<DietTarget, { keep: string[]; nativeExt: string; os: string[]; cpu: string[] }> = {
  "linux-x64": { keep: ["linux-x64", "linux-x64-gnu"], nativeExt: "elf", os: ["linux"], cpu: ["x64"] },
  "linux-arm64": { keep: ["linux-arm64", "linux-arm64-gnu"], nativeExt: "elf", os: ["linux"], cpu: ["arm64"] },
  "win-x64": { keep: ["win32-x64"], nativeExt: "exe", os: ["win32"], cpu: ["x64"] },
  "mac-x64": { keep: ["darwin-x64"], nativeExt: "macho", os: ["darwin"], cpu: ["x64"] },
  "mac-arm64": { keep: ["darwin-arm64"], nativeExt: "macho", os: ["darwin"], cpu: ["arm64"] },
};

const PLATFORM_TOKENS = [
  "linux-x64",
  "linux-x64-gnu",
  "linux-arm64",
  "linux-arm64-gnu",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
];

const PRUNE_GLOBS = [
  "**/*.{js.map,css.map}",
  "**/*.flow",
  "**/{__tests__,__test__,testdata,test-data,fixtures,fixture,__mocks__,test,coverage,benchmark,benchmarks,e2e,__snapshots__,demo,demos,.github}",
  "**/*.{test,spec,bench}.*",
  "**/*.{d.ts,d.ts.map}",
  "**/*.bc.js",
  "**/*.{tar.gz,o,lo,la,a,obj}",
  "**/{CMakeCache.txt,Makefile,cmake_install.cmake}",
  "**/*.cmake",
  "**/{CMakeFiles,cmake,node-gyp}",
  "**/{CHANGELOG*,changelog*,CHANGE*,README*,readme*,AUTHORS*,CONTRIBUTORS*,PATENTS*}",
  "**/{LICENSE,LICENSE.*,LICENSE-*,LICENCE,LICENCE.*,LICENCE-*}",
  "**/{.npmignore,.gitignore,.editorconfig,.gitattributes,.eslintrc*,.prettierrc*,.jshintrc,tsconfig.json,babel.config*,.babelrc*,rollup.config*,webpack.config*,jest.config*,karma.conf*,.nycrc*,lint-staged*,.huskyrc*,.lintstagedrc*}",
  "**/.cache",
  "**/{__pycache__,.pytest_cache,.ruff_cache,.mypy_cache}",
];

const HOST_TO_TARGET: Record<string, DietTarget> = {
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "win32-x64": "win-x64",
  "darwin-x64": "mac-x64",
  "darwin-arm64": "mac-arm64",
};

function n8nPkg() {
  return require(path.join(BUILD_DIR, NM, "n8n", "package.json"));
}

function n8nCliFromBuild(): string {
  const pkg = n8nPkg();
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.n8n;
  if (!rel) throw new Error("n8n package.json missing bin entry");
  // zx template literals treat backslashes as escapes (e.g. node_modules\n8n → newline).
  return path.join(BUILD_DIR, NM, "n8n", rel).replace(/\\/g, "/");
}

function resolveDietTarget(): DietTarget {
  const env = process.env.DIET_TARGET as DietTarget | undefined;
  if (env) return env;
  const t = HOST_TO_TARGET[`${process.platform}-${process.arch}`];
  if (!t) throw new Error(`unsupported host: ${process.platform}/${process.arch}`);
  return t;
}

async function inBuild<T>(fn: () => Promise<T>) {
  return within(async () => {
    cd(BUILD_DIR);
    return fn();
  });
}

async function inRoot<T>(fn: () => Promise<T>) {
  return within(async () => {
    cd(ROOT);
    return fn();
  });
}

async function rmGlobs(cwd: string, patterns: string[]) {
  for (const pattern of patterns) {
    // macOS/Windows default nocase:true — LICENSE-* would match license-state.js.
    for (const p of await glob(pattern, { cwd, absolute: true, dot: true, nocase: false }))
      await fs.promises.rm(p, { recursive: true, force: true });
  }
}

function splitSuffix(i: number): string {
  let n = i;
  let suffix = "";
  do {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return suffix.length < 2 ? suffix.padStart(2, "a") : suffix;
}

/** lzma-native xz of node_modules, split into CHUNK-sized dist pieces. */
async function writeNodeModulesChunks(chunksDir: string): Promise<{ chunkNames: string[]; totalBytes: number }> {
  const tarPath = path.join(chunksDir, "__bundle.tar");
  const xzPath = path.join(chunksDir, "__bundle.tar.xz");

  console.log(chalk.green("Creating node_modules tar..."));
  await pipeline(
    tarFs.pack(path.join(BUILD_DIR, NM), {
      map: (header) => {
        header.name = header.name.replace(/\\/g, "/");
        return header;
      },
    }),
    fs.createWriteStream(tarPath),
  );

  console.log(chalk.green("Compressing tar with lzma-native..."));
  await pipeline(
    fs.createReadStream(tarPath),
    lzma.createCompressor({ preset: 9 | (1 << 31) }),
    fs.createWriteStream(xzPath),
  );
  await fs.promises.rm(tarPath, { force: true });

  const { size } = await fs.promises.stat(xzPath);
  const chunkNames: string[] = [];
  let totalBytes = 0;
  const handle = await fs.promises.open(xzPath, "r");
  try {
    for (let off = 0; off < size; ) {
      const len = Math.min(CHUNK, size - off);
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, off);
      const name = `node_modules.tar.xz.${splitSuffix(chunkNames.length)}`;
      await fs.promises.writeFile(path.join(chunksDir, name), buf);
      chunkNames.push(name);
      totalBytes += len;
      off += len;
    }
  } finally {
    await handle.close();
    await fs.promises.rm(xzPath, { force: true });
  }

  return { chunkNames, totalBytes };
}

function keepPlatformToken(tok: string, keep: string[]) {
  return keep.some((k) => tok === k || tok.startsWith(`${k}-`));
}

function applySupplyChainEnv() {
  $.env = {
    ...$.env,
    NPM_CONFIG_USERCONFIG: NPMRC,
    PIP_CONFIG_FILE: PIP_CONF,
    UV_CONFIG_FILE: UV_CONF,
  };
}

async function assertSupplyChainConfig() {
  assert(fs.existsSync(NPMRC));
  assert(fs.existsSync(PIP_CONF));
  assert(fs.existsSync(UV_CONF));
  assert($.env.NPM_CONFIG_USERCONFIG === NPMRC);
  assert($.env.PIP_CONFIG_FILE === PIP_CONF);
  assert($.env.UV_CONFIG_FILE === UV_CONF);

  // npm flattens min-release-age into `before`; config get min-release-age returns null.
  const before = new Date((await $`npm config get before`).stdout.trim());
  const ageDays = (Date.now() - before.getTime()) / 86_400_000;
  assert(
    ageDays >= 2.5 && ageDays <= 3.5,
    `expected min-release-age=3 (~3d before cutoff), got before=${before.toISOString()} (${ageDays.toFixed(2)}d)`,
  );

  const pipList = (await $`${PYTHON_BIN} -m pip config list`).stdout;
  assert(
    pipList.includes("install.uploaded-prior-to='P3D'") || pipList.includes("install.uploaded-prior-to=P3D"),
    "expected uploaded-prior-to=P3D in active pip config",
  );
}

async function prepare() {
  console.log(chalk.green("Preparing build environment..."));
  await inRoot(async () => {
    await fs.promises.rm(DIST_DIR, { recursive: true, force: true });
    await fs.promises.rm(BUILD_DIR, { recursive: true, force: true });
    await fs.promises.mkdir(path.join(DIST_DIR, "chunks"), { recursive: true });
    await fs.promises.mkdir(BUILD_DIR, { recursive: true });
    await fs.promises.copyFile(NPMRC, path.join(BUILD_DIR, ".npmrc"));
  });
}

async function ensureDependencies() {
  console.log(chalk.green("Ensuring dependencies are installed..."));
  await inRoot(async () => {
    assert((await $`${PYTHON_BIN} --version`).stdout.match(/3\.12|3\.13/));
    assert((await $`node --version`).stdout.match(/v24/));
    assert((await $`${PYTHON_BIN} -m pip --version`).stdout.match(/pip/));
    assert((await $`${PYTHON_BIN} -m venv --help`).exitCode === 0);
    assert((await $`uv --version`).stdout.match(/uv/));
    console.log(chalk.green("Dependencies are present"));
  });
}

async function installUpstream() {
  console.log(chalk.green("Installing upstream n8n..."));
  await inBuild(async () => {
    await $`npm init -y`;
    await $`npm install n8n@latest --omit=dev --no-audit --no-fund`;
  });
  const { version } = n8nPkg();
  console.log(chalk.green(`n8n ${version} installed`));
  return version as string;
}

async function installPythonTaskRunner(n8nVersion: string) {
  console.log(chalk.green("Installing Python task runner..."));
  await inBuild(async () => {
    const taskRunnerDir = path.join(BUILD_NM, "@n8n/task-runner-python");
    const archiveUrl = `https://codeload.github.com/n8n-io/n8n/tar.gz/refs/tags/n8n%40${n8nVersion}`;

    await fs.promises.rm(taskRunnerDir, { recursive: true, force: true });
    await fs.promises.mkdir(taskRunnerDir, { recursive: true });

    const gunzip = zlib.createGunzip();
    const tarStream = tar.x({
      cwd: taskRunnerDir,
      strip: 4,
      filter: (p) => p.includes("/packages/@n8n/task-runner-python"),
      onReadEntry: (entry) => console.log(chalk.green(`Extracting ${entry.path}`)),
    });

    await new Promise<void>((resolve, reject) => {
      tarStream.on("finish", resolve).on("error", reject);
      gunzip.on("error", reject);
      https
        .get(archiveUrl, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${archiveUrl}`));
            res.resume();
            return;
          }
          res.on("error", reject).pipe(gunzip);
        })
        .on("error", reject);
      gunzip.pipe(tarStream);
    });

    cd(taskRunnerDir);
    await $`uv python install 3.12 3.13`;

    const pyproject = path.join(taskRunnerDir, "pyproject.toml");
    const pyprojectOrig = await fs.promises.readFile(pyproject, "utf8");
    await fs.promises.writeFile(
      pyproject,
      pyprojectOrig.replace('requires-python = ">=3.13"', 'requires-python = ">=3.12"'),
    );
    await $`uv sync --no-dev --python 3.12`;
    await fs.promises.rename(path.join(taskRunnerDir, ".venv"), path.join(taskRunnerDir, ".venv.3.12"));
    await fs.promises.writeFile(pyproject, pyprojectOrig);
    await $`uv sync --no-dev --python 3.13`;
    await fs.promises.rename(path.join(taskRunnerDir, ".venv"), path.join(taskRunnerDir, ".venv.3.13"));
    const venvLauncher = process.platform === "win32" ? "Scripts" : "bin";
    await fs.promises.rm(path.join(taskRunnerDir, ".venv.3.12", venvLauncher), { recursive: true, force: true });
    await fs.promises.rm(path.join(taskRunnerDir, ".venv.3.13", venvLauncher), { recursive: true, force: true });
    await $`uv cache clean`;
  });
  console.log(chalk.green("Python task runner installed"));
}

async function updateMinimalEnv() {
  console.log(chalk.green("Updating minimal.env..."));
  const { ModuleRegistry } = require(path.join(BUILD_DIR, NM, "@n8n/backend-common/dist/modules/module-registry.js"));
  const { defaultModules } = new ModuleRegistry();
  const skipped = defaultModules
    .filter((m: string) => m !== "community-packages" && m !== "workflow-builder" && m !== "favorites")
    .sort();
  const body = await fs.promises.readFile(MINIMAL_ENV, "utf8");
  await fs.promises.writeFile(
    MINIMAL_ENV,
    body.replace(/N8N_DISABLED_MODULES=.*$/m, `N8N_DISABLED_MODULES=${skipped.join(",")}`),
  );
  console.log(chalk.green("minimal.env updated"));
}

function zxPath(p: string) {
  return p.replace(/\\/g, "/");
}

async function ensureLlamafile(): Promise<string> {
  await fs.promises.mkdir(LLAMAFILE_DIR, { recursive: true });
  const dest = path.join(LLAMAFILE_DIR, LLAMAFILE_NAME);
  const stat = await fs.promises.stat(dest).catch(() => null);
  if (stat?.size === LLAMAFILE_EXPECTED_BYTES) return dest;
  if (stat) await fs.promises.rm(dest, { force: true });

  console.log(chalk.green("Downloading llamafile..."));
  const out = zxPath(dest);
  if (process.platform === "win32") {
    await $`curl.exe -L --fail -o ${out} ${LLAMAFILE_URL}`;
  } else {
    await $`curl -L --fail -o ${out} ${LLAMAFILE_URL}`;
  }
  const { size } = await fs.promises.stat(dest);
  if (size !== LLAMAFILE_EXPECTED_BYTES) {
    throw new Error(`llamafile download size mismatch: expected ${LLAMAFILE_EXPECTED_BYTES}, got ${size}`);
  }
  return dest;
}

async function ensureApeLoader(): Promise<string> {
  if (process.platform === "darwin") {
    const ape = path.join(LLAMAFILE_DIR, "ape-x86_64.macho");
    if (await fs.promises.stat(ape).catch(() => null)) return ape;
    const url = "https://cosmo.zip/pub/cosmos/bin/ape-x86_64.macho";
    console.log(chalk.green("Downloading cosmopolitan APE loader..."));
    await $`curl -L --fail -o ${zxPath(ape)} ${url}`;
    await fs.promises.chmod(ape, 0o755);
    return ape;
  }

  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const ape = path.join(LLAMAFILE_DIR, `ape-${arch}.elf`);
  if (await fs.promises.stat(ape).catch(() => null)) return ape;
  const url = `https://cosmo.zip/pub/cosmos/bin/ape-${arch}.elf`;
  console.log(chalk.green("Downloading cosmopolitan APE loader..."));
  await $`curl -L --fail -o ${zxPath(ape)} ${url}`;
  await fs.promises.chmod(ape, 0o755);
  return ape;
}

async function stopBg(proc: ProcessPromise) {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already exited */
  }
  await proc.nothrow();
}

async function stopWinPid(pid: number) {
  await $`taskkill /F /T /PID ${pid}`.nothrow();
}

async function startLlamafile(): Promise<{ proc: ProcessPromise } | { pid: number }> {
  const llamafile = await ensureLlamafile();
  const port = process.env.LLAMAFILE_PORT || "8080";
  const logPath = path.join(LLAMAFILE_DIR, "server.log");
  const args = ["--server", "--host", "127.0.0.1", "--port", port, "--jinja"];
  if (process.platform === "darwin" && process.arch === "arm64") args.push("-ngl", "0");
  const ready = waitOn({
    resources: [`http-get://127.0.0.1:${port}/v1/models`],
    timeout: Number(process.env.LLAMAFILE_WAIT_MS || 1_200_000),
    interval: 2000,
  });

  if (process.platform === "win32") {
    const winExe = `${llamafile}.exe`;
    await fs.promises.copyFile(llamafile, winExe);
    const ps = [
      "$p = Start-Process",
      `-FilePath '${zxPath(winExe).replace(/'/g, "''")}'`,
      `-ArgumentList ${args.map((a) => `'${a}'`).join(",")}`,
      "-PassThru -WindowStyle Hidden;",
      "Write-Output $p.Id",
    ].join(" ");
    const pid = Number((await $`powershell -NoProfile -Command ${ps}`).stdout.trim());
    if (!pid) throw new Error("failed to start llamafile on Windows");
    await ready;
    return { pid };
  }

  const logStream = fs.createWriteStream(logPath);
  const run$ = $({ env: { ...process.env, TMPDIR: LLAMAFILE_DIR } });
  let proc: ProcessPromise;
  if (process.platform === "linux" || (process.platform === "darwin" && process.arch !== "arm64")) {
    proc = run$`${await ensureApeLoader()} ${llamafile} ${args}`.stdio("pipe", "pipe", "ignore").quiet();
  } else if (process.platform === "darwin") {
    await fs.promises.chmod(llamafile, 0o755);
    for (const f of await glob(path.join(LLAMAFILE_DIR, ".ape*"))) await fs.promises.rm(f, { force: true });
    proc = run$`/bin/sh ${llamafile} ${args}`.stdio("pipe", "pipe", "ignore").quiet();
  } else {
    await fs.promises.chmod(llamafile, 0o755);
    proc = run$`${llamafile} ${args}`.stdio("pipe", "pipe", "ignore").quiet();
  }
  proc.stdout.pipe(logStream, { end: false });
  proc.stderr.pipe(logStream, { end: false });
  const failed = proc.then((r) => {
    if (r.exitCode !== 0) throw new Error(`llamafile exited with code ${r.exitCode}`);
  });
  await Promise.race([ready, failed]).catch(async (err) => {
    logStream.end();
    await finished(logStream).catch(() => undefined);
    const log = await fs.promises.readFile(logPath, "utf8").catch(() => "");
    if (log) console.error(chalk.red("llamafile log (last 8k):\n"), log.slice(-8_000));
    throw err;
  });
  return { proc };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function assertNoMissingModules(logs: string) {
  const match = logs.replace(/\\/g, "/").match(/Cannot find module '([^']+)'/);
  if (match) throw new Error(`n8n trace missing module: ${match[1]}`);
}

function modulesFromTraceLog(logs: string): Set<string> {
  const keep = new Set<string>();
  for (const m of logs.replace(/\\/g, "/").matchAll(/node_modules\/(@[^\s/]+\/[^\s/]+|[^\s/@]+)/g))
    keep.add(m[1].split("/")[0]);
  return keep;
}

async function waitForN8nReady(baseUrl: string) {
  const deadline = Date.now() + Number(process.env.N8N_READY_MS || 180_000);
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/rest/projects`);
    const body = await res.text();
    if (!body.includes("starting up")) return;
    await sleep(2000);
  }
  throw new Error("n8n never finished starting");
}

async function runAiChatTrace(baseUrl: string, llamafileBaseUrl: string) {
  let cookie = "";
  const capture = (res: Response) => {
    for (const part of res.headers.getSetCookie()) {
      const token = part.split(";")[0] ?? "";
      cookie = cookie ? `${cookie}; ${token}` : token;
    }
  };
  const request = async (p: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
    if (cookie) headers.set("Cookie", cookie);
    const res = await fetch(`${baseUrl}${p}`, { ...init, headers });
    capture(res);
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${p} failed (${res.status}): ${await res.text()}`);
    return res;
  };

  const loginDeadline = Date.now() + 60_000;
  while (Date.now() < loginDeadline) {
    const res = await fetch(`${baseUrl}/rest/projects`, { headers: cookie ? { Cookie: cookie } : {} });
    capture(res);
    if (cookie) break;
    await sleep(1000);
  }
  if (!cookie) throw new Error("auto-login hook did not issue n8n-auth cookie");

  const cred = (await (
    await request("/rest/credentials", {
      method: "POST",
      body: JSON.stringify({
        name: "Llamafile Trace",
        type: "openAiApi",
        data: { apiKey: "sk-no-key-required", url: llamafileBaseUrl },
      }),
    })
  ).json()) as { data: { id: string } };

  const workflow = JSON.parse(await fs.promises.readFile(WORKFLOW_JSON, "utf8")) as {
    nodes: { type: string; webhookId?: string; credentials?: Record<string, { id?: string; name?: string }> }[];
    connections: Record<string, unknown>;
    name: string;
    settings?: Record<string, unknown>;
  };
  const chatNode = workflow.nodes.find((n) => n.type === "@n8n/n8n-nodes-langchain.chatTrigger");
  if (!chatNode?.webhookId) throw new Error("workflow.json missing chatTrigger webhookId");
  for (const node of workflow.nodes) {
    if (node.credentials?.openAiApi) node.credentials.openAiApi = { id: cred.data.id, name: "Llamafile Trace" };
  }

  const saved = (await (
    await request("/rest/workflows", { method: "POST", body: JSON.stringify(workflow) })
  ).json()) as { data: { id: string; versionId: string } };
  await request(`/rest/workflows/${saved.data.id}/activate`, {
    method: "POST",
    body: JSON.stringify({ versionId: saved.data.versionId }),
  });
  await (
    await request(`/webhook/${chatNode.webhookId}/chat`, {
      method: "POST",
      body: JSON.stringify({
        action: "sendMessage",
        chatInput: "Reply with exactly: trace-ok",
        sessionId: "diet-trace",
      }),
    })
  ).text();

  const deadline = Date.now() + 120_000;
  let executionId: string | undefined;
  while (Date.now() < deadline) {
    const list = (await (await request("/rest/executions?limit=10")).json()) as {
      data?: { results?: { id: string; workflowId: string; status: string; stoppedAt: string | null }[] };
    };
    const exec = list.data?.results?.find((e) => e.workflowId === saved.data.id);
    if (!exec) {
      await sleep(1000);
      continue;
    }
    if (!exec.stoppedAt && (exec.status === "running" || exec.status === "waiting" || exec.status === "new")) {
      await sleep(1000);
      continue;
    }
    executionId = exec.id;
    break;
  }
  if (!executionId) throw new Error("AI chat trace execution never finished");

  const detail = (await (await request(`/rest/executions/${executionId}`)).json()) as {
    data?: { customData?: { response_ai_agent?: string } };
  };
  if (!detail.data?.customData?.response_ai_agent) throw new Error("AI chat trace did not reach AI Agent node");
}

async function traceN8n(): Promise<Set<string>> {
  if (!fs.existsSync(WORKFLOW_JSON)) {
    throw new Error(`workflow.json not found at ${WORKFLOW_JSON}`);
  }

  const minimal = parseEnv(await fs.promises.readFile(MINIMAL_ENV, "utf8"));
  const port = minimal.N8N_PORT || "5678";
  const traceDir = path.join(BUILD_DIR, ".n8n-diet-trace");
  const logs = path.join(BUILD_DIR, "logs.txt");
  const llamafileBaseUrl = process.env.LLAMAFILE_BASE_URL || "http://127.0.0.1:8080/v1";
  const llamaBg = await startLlamafile();
  const hooksFile = path.join(os.tmpdir(), "diet-hooks.js");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "hooks.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: hooksFile,
    external: ["n8n", "router/lib/layer"],
  });

  await fs.promises.rm(traceDir, { recursive: true, force: true });
  await fs.promises.mkdir(traceDir, { recursive: true });
  const logStream = fs.createWriteStream(logs);
  const host = `127.0.0.1:${port}`;
  const baseUrl = `http://${host}`;

  const { NODE_OPTIONS: _buildTsx, ...hostEnv } = process.env;
  $.env = {
    ...hostEnv,
    ...minimal,
    N8N_USER_FOLDER: traceDir,
    N8N_DIAGNOSTICS_ENABLED: "true",
    NODE_DEBUG: "module",
    EXTERNAL_HOOK_FILES: hooksFile,
    ...(process.platform === "win32" ? { EXTERNAL_HOOK_FILES_SEPARATOR: ";" } : {}),
  };

  const proc = $`node ${n8nCliFromBuild()}`.stdio("pipe", "pipe", "ignore").quiet();
  proc.stdout.pipe(logStream, { end: false });
  proc.stderr.pipe(logStream, { end: false });

  try {
    await waitOn({
      resources: [`tcp:${host}`, `http-get://${host}/healthz`],
      timeout: Number(process.env.SERVER_WAIT_MS || 180_000),
      interval: 2000,
    });
    await waitForN8nReady(baseUrl);
    await runAiChatTrace(baseUrl, llamafileBaseUrl);

    const logBody = await fs.promises.readFile(logs, "utf8");
    assertNoMissingModules(logBody);
    return modulesFromTraceLog(logBody);
  } catch (err) {
    const logBody = await fs.promises.readFile(logs, "utf8").catch(() => "");
    if (logBody) console.error(chalk.red("n8n trace log (last 12k):\n"), logBody.slice(-12_000));
    throw err;
  } finally {
    await stopBg(proc);
    if ("pid" in llamaBg) await stopWinPid(llamaBg.pid);
    else await stopBg(llamaBg.proc);
    logStream.end();
    await finished(logStream).catch(() => undefined);
  }
}

async function pruneNodeModules(target: DietTarget, keep: Set<string>) {
  const { keep: keepTok, nativeExt } = TARGET[target];

  for (const name of await fs.promises.readdir(BUILD_NM)) {
    if (name.startsWith("n8n-") || name.startsWith("acorn-") || keep.has(name)) continue;
    await fs.promises.rm(path.join(BUILD_NM, name), { recursive: true, force: true });
  }

  for (const tok of PLATFORM_TOKENS) {
    if (keepPlatformToken(tok, keepTok)) continue;
    await rmGlobs(BUILD_NM, [`**/*${tok}*`]);
  }
  for (const p of await glob("**/prebuilds/*", { cwd: BUILD_NM, absolute: true })) {
    if (!keepTok.includes(path.basename(p))) await fs.promises.rm(p, { recursive: true, force: true });
  }

  await rmGlobs(BUILD_NM, PRUNE_GLOBS);
  if (target.startsWith("linux")) await rmGlobs(BUILD_NM, ["**/*musl*", "**/*-musl"]);

  for (const f of await glob("**/*.node", { cwd: BUILD_NM, absolute: true })) {
    const t = await fileTypeFromFile(f);
    if (t?.ext !== nativeExt) await fs.promises.rm(f, { force: true });
  }
  await rmGlobs(
    BUILD_NM,
    target.startsWith("linux") ? ["**/*.{dll,dylib}"] : target.startsWith("win") ? ["**/*.dylib"] : ["**/*.dll"],
  );

  for (const f of await glob("**/*.browser.*", { cwd: BUILD_NM, absolute: true }))
    if (!f.endsWith(".browser.js")) await fs.promises.rm(f, { force: true });

  await fs.promises.rm(path.join(BUILD_NM, "sqlite3/deps"), { recursive: true, force: true });
  await fs.promises.rm(path.join(BUILD_NM, ".cache"), { recursive: true, force: true });
  await fs.promises.rm(path.join(BUILD_NM, "@n8n/task-runner-python/tests"), { recursive: true, force: true });
  await fs.promises.rm(path.join(BUILD_DIR, ".n8n-diet-trace"), { recursive: true, force: true });
  await fs.promises.rm(path.join(BUILD_DIR, "logs.txt"), { force: true });
}

async function applyDiet(target: DietTarget) {
  console.log(chalk.green("Applying diet..."));
  await inBuild(async () => {
    await pruneNodeModules(target, await traceN8n());
  });
  console.log(chalk.green("Diet applied"));
}

async function applyPatches() {
  console.log(chalk.green("Applying patches..."));
  await inBuild(async () => {
    // Evaluations is unused and disabled in diet-n8n, so we hide it.
    const hideEvaluationsSnippet = `<script type="module">/*Hide Evaluations:*/(function(){"use strict";const e=()=>{document.querySelectorAll('div[data-test-id="radio-button-evaluation"]').forEach(o=>{const t=o.closest("label");t&&t.style.setProperty("display","none","important")})};e(),new MutationObserver(e).observe(document.body,{childList:!0,subtree:!0})})();</script>`;
    // Almost all settings and help entries are unused in diet-n8n, so we hide them too.
    const hideSettingsHelpSnippet = `<script type="module">/*Hide Settings Help:*/(function(){"use strict";const t=()=>{document.querySelectorAll('div[data-test-id="main-sidebar-help"]').forEach(r=>{let e=r.parentElement;e&&(e=e.parentElement),e&&e.style.setProperty("display","none","important")})};t(),new MutationObserver(t).observe(document.body,{childList:!0,subtree:!0})})();</script>`;
    const editorHtml = path.join(BUILD_NM, "n8n-editor-ui/dist/index.html");
    const editorHtmlOrig = await fs.promises.readFile(editorHtml, "utf8");
    await fs.promises.writeFile(
      editorHtml,
      editorHtmlOrig.replace("</body>", [hideEvaluationsSnippet, hideSettingsHelpSnippet, "</body>"].join("\n")),
    );
  });
  console.log(chalk.green("Patches applied"));
}

async function packageDist(target: DietTarget) {
  console.log(chalk.green("Packaging dist..."));
  const { version } = n8nPkg();
  const chunksDir = path.join(DIST_DIR, "chunks");
  const { chunkNames, totalBytes } = await writeNodeModulesChunks(chunksDir);
  console.log(chalk.green(`Compressed node_modules (${totalBytes} bytes, ${chunkNames.length} chunks)`));
  const sums = await Promise.all(
    chunkNames.map(async (name) => {
      const data = await fs.promises.readFile(path.join(chunksDir, name));
      return `${crypto.createHash("sha256").update(data).digest("hex")}  ${name}`;
    }),
  );
  await fs.promises.writeFile(path.join(DIST_DIR, ".n8n-version"), `${version}\n`);
  await fs.promises.writeFile(path.join(DIST_DIR, "sha256sums.txt"), `${sums.join("\n")}\n`);

  await esbuild.build({
    entryPoints: [path.join(ROOT, "extract.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(DIST_DIR, "extract.js"),
    minify: true,
  });
  await esbuild.build({
    entryPoints: [path.join(ROOT, "launch.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(DIST_DIR, "launch.js"),
    minify: true,
  });
  await esbuild.build({
    entryPoints: [path.join(ROOT, "hooks.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(DIST_DIR, "hooks.js"),
    external: ["n8n", "router/lib/layer"],
    minify: true,
  });

  await fs.promises.chmod(path.join(DIST_DIR, "extract.js"), 0o755);
  let minimalBody = await fs.promises.readFile(MINIMAL_ENV, "utf8");
  if (target === "win-x64") {
    minimalBody = minimalBody
      .replace("N8N_NATIVE_PYTHON_RUNNER=true", "N8N_NATIVE_PYTHON_RUNNER=false")
      .replace("N8N_PYTHON_ENABLED=true", "N8N_PYTHON_ENABLED=false");
  }
  await fs.promises.writeFile(path.join(DIST_DIR, "minimal.env"), minimalBody);

  const { os, cpu } = TARGET[target];
  await fs.promises.writeFile(
    path.join(DIST_DIR, "package.json"),
    `${JSON.stringify(
      {
        name: "diet-n8n",
        version,
        bin: { "diet-n8n": "./launch.js" },
        scripts: { postinstall: "node extract.js", start: "node launch.js" },
        os,
        cpu,
      },
      null,
      2,
    )}\n`,
  );
  console.log(chalk.green(`Packaged n8n ${version}, ${chunkNames.length} chunks, ${target}`));
}

async function main() {
  applySupplyChainEnv();
  await prepare();
  await ensureDependencies();
  await assertSupplyChainConfig();
  const version = await installUpstream();
  await installPythonTaskRunner(version);
  await updateMinimalEnv();
  const target = resolveDietTarget();
  await applyDiet(target);
  await applyPatches();
  await packageDist(target);
}

main().catch((err) => {
  console.error(chalk.red(err));
  process.exit(1);
});
