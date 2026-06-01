import assert from "assert";
import crypto from "crypto";
import https from "https";
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

import { $, cd, chalk, within } from "zx";

const ROOT = __dirname;
const NPMRC = path.join(ROOT, ".npmrc");
const PIP_CONF = path.join(ROOT, "pip.conf");
const UV_CONF = path.join(ROOT, "uv.toml");
const BUILD_DIR = path.join(ROOT, "build");
const DIST_DIR = path.join(ROOT, "dist");
const MINIMAL_ENV = path.join(ROOT, "minimal.env");
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
async function writeNodeModulesChunks(
  chunksDir: string,
): Promise<{ chunkNames: string[]; totalBytes: number }> {
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
    await $`npm install n8n --omit=dev --no-audit --no-fund --save`;
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

async function traceN8n(): Promise<Set<string>> {
  const minimal = parseEnv(await fs.promises.readFile(MINIMAL_ENV, "utf8"));
  const port = minimal.N8N_PORT || "5678";
  const traceDir = path.join(BUILD_DIR, ".n8n-diet-trace");
  const logs = path.join(BUILD_DIR, "logs.txt");
  await fs.promises.rm(traceDir, { recursive: true, force: true });
  await fs.promises.mkdir(traceDir, { recursive: true });
  const logStream = fs.createWriteStream(logs);

  $.env = {
    ...process.env,
    ...minimal,
    N8N_USER_FOLDER: traceDir,
    N8N_DIAGNOSTICS_ENABLED: "true",
    NODE_DEBUG: "module",
  };

  const proc = $`node ${n8nCliFromBuild()}`.stdio("pipe", "pipe", "ignore").quiet();
  proc.stdout.pipe(logStream, { end: false });
  proc.stderr.pipe(logStream, { end: false });
  const host = `127.0.0.1:${port}`;
  await waitOn({ resources: [`tcp:${host}`], timeout: Number(process.env.SERVER_WAIT_MS || 180_000), interval: 1000 });
  await waitOn({
    resources: [`http-get://${host}/`, `http-get://${host}/healthz`],
    interval: 2000,
    window: 20_000,
  });
  await waitOn({
    resources: [`http-get://${host}/healthz`],
    interval: 1000,
    window: Number(process.env.POST_READY_MS || 15_000),
  });
  proc.kill("SIGTERM");
  await proc.nothrow();
  logStream.end();
  await finished(logStream);

  const keep = new Set<string>();
  for (const m of (await fs.promises.readFile(logs, "utf8")).matchAll(/node_modules\/(@[^\s/]+\/[^\s/]+|[^\s/@]+)/g))
    keep.add(m[1].split("/")[0]);
  return keep;
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
  await fs.promises.copyFile(MINIMAL_ENV, path.join(DIST_DIR, "minimal.env"));

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
