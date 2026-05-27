import assert from "assert";
import crypto from "crypto";
import https from "https";
import path from "path";
import { finished } from "stream/promises";
import { pipeline } from "stream/promises";
import { Writable } from "stream";
import zlib from "zlib";
import fs from "fs";
import * as tar from "tar";
import { parse as parseEnv } from "dotenv";
import esbuild from "esbuild";
import { fileTypeFromFile } from "file-type";
import { glob } from "glob";
import lzma from "lzma-native";
import waitOn from "wait-on";

import { $, cd, chalk, within } from "zx";

const PYTHON_BIN = process.env.DIET_N8N_PYTHON_BIN || "python3";
const BUILD = () => path.resolve(__dirname, "build");
const DIST = () => path.resolve(__dirname, "dist");
const CHUNK = 10 * 1024 * 1024;

type DietTarget = "linux-x64" | "linux-arm64" | "win-x64" | "mac-x64" | "mac-arm64";

const KEEP_TOKENS: Record<DietTarget, string[]> = {
  "linux-x64": ["linux-x64", "linux-x64-gnu"],
  "linux-arm64": ["linux-arm64", "linux-arm64-gnu"],
  "win-x64": ["win32-x64"],
  "mac-x64": ["darwin-x64"],
  "mac-arm64": ["darwin-arm64"],
};

const NATIVE_EXT: Record<DietTarget, string> = {
  "linux-x64": "elf",
  "linux-arm64": "elf",
  "win-x64": "exe",
  "mac-x64": "macho",
  "mac-arm64": "macho",
};

const PKG_OS_CPU: Record<DietTarget, { os: string[]; cpu: string[] }> = {
  "linux-x64": { os: ["linux"], cpu: ["x64"] },
  "linux-arm64": { os: ["linux"], cpu: ["arm64"] },
  "win-x64": { os: ["win32"], cpu: ["x64"] },
  "mac-x64": { os: ["darwin"], cpu: ["x64"] },
  "mac-arm64": { os: ["darwin"], cpu: ["arm64"] },
};

const ALL_PLATFORM_TOKENS = [
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

function resolveDietTarget(): DietTarget {
  const env = process.env.DIET_TARGET;
  if (env) {
    assert(env in KEEP_TOKENS, `invalid DIET_TARGET: ${env}`);
    return env as DietTarget;
  }
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "win32" && arch === "x64") return "win-x64";
  if (platform === "darwin" && arch === "x64") return "mac-x64";
  if (platform === "darwin" && arch === "arm64") return "mac-arm64";
  throw new Error(`unsupported host platform: ${platform}/${arch}`);
}

async function rmGlob(nm: string, pattern: string) {
  for (const p of await glob(pattern, { cwd: nm, absolute: true, dot: true }))
    await fs.promises.rm(p, { recursive: true, force: true });
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

async function prepare() {
  console.log(chalk.green("Preparing build environment..."));
  await within(async () => {
    cd(__dirname);
    await fs.promises.rm("dist", { recursive: true, force: true });
    await fs.promises.rm("build", { recursive: true, force: true });
    await fs.promises.mkdir(path.join(DIST(), "chunks"), { recursive: true });
    await fs.promises.mkdir("build", { recursive: true });
  });
}

async function ensureDependencies() {
  console.log(chalk.green("Ensuring dependencies are installed..."));
  await within(async () => {
    cd(__dirname);
    const pythonVersion = (await $`${PYTHON_BIN} --version`).stdout;
    assert(pythonVersion.match(/3\.12|3\.13/), "Python 3.12 or 3.13 is required");
    console.log(chalk.green(`${pythonVersion} is installed`));
    const nodeVersion = (await $`node --version`).stdout;
    assert(nodeVersion.match(/v24/), "node 24 is required");
    console.log(chalk.green(`Node ${nodeVersion} is installed`));
    const pipVersion = (await $`pip --version`).stdout;
    assert(pipVersion.match(/pip/), "pip is required");
    console.log(chalk.green(`${pipVersion} is installed`));
    const venvVersion = (await $`${PYTHON_BIN} -m venv --help`).exitCode;
    assert(venvVersion === 0, "venv is required");
    console.log(chalk.green(`Venv is installed`));
    const uvVersion = (await $`uv --version`).stdout;
    assert(uvVersion.match(/uv/), "uv is required");
    console.log(chalk.green(`${uvVersion} is installed`));
    console.log(chalk.green("Dependencies are present"));
  });
}

async function installUpstream() {
  let n8nVersion = "";
  console.log(chalk.green("Installing upstream n8n..."));
  await within(async () => {
    cd(BUILD());
    await $`npm init -y`;
    await $`npm install n8n --omit=dev --no-audit --no-fund --save`;
    console.log(chalk.green("Upstream n8n installed"));
    const { version } = require(path.join(BUILD(), "node_modules", "n8n", "package.json"));
    assert(typeof version === "string", "n8n version is required");
    n8nVersion = version;
  });
  assert(n8nVersion.length > 0, "n8n version is required");
  console.log(chalk.green(`n8n ${n8nVersion} is installed`));
  return n8nVersion;
}

async function installPythonTaskRunner(n8nVersion: string) {
  console.log(chalk.green("Installing Python task runner..."));
  await within(async () => {
    cd(BUILD());

    const taskRunnerDir = path.resolve("node_modules/@n8n/task-runner-python");
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
    await fs.promises.rm(path.join(taskRunnerDir, ".venv.3.12", "bin"), { recursive: true, force: true });
    await fs.promises.rm(path.join(taskRunnerDir, ".venv.3.13", "bin"), { recursive: true, force: true });
    await $`uv cache clean`;

    console.log(chalk.green("Python task runner installed"));
  });
}

async function updateMinimalEnv() {
  console.log(chalk.green("Updating minimal.env..."));
  await within(async () => {
    const { ModuleRegistry } = require("./build/node_modules/@n8n/backend-common/dist/modules/module-registry.js");
    const { defaultModules } = new ModuleRegistry();
    const skippedModules: string[] = defaultModules
      .filter((module: string) => !["community-packages", "workflow-builder"].includes(module))
      .sort();
    const minimalEnv = path.resolve(__dirname, "minimal.env");
    const minimalEnvContent = await fs.promises.readFile(minimalEnv, "utf8");
    await fs.promises.writeFile(
      minimalEnv,
      minimalEnvContent.replace(/N8N_DISABLED_MODULES=.*$/m, `N8N_DISABLED_MODULES=${skippedModules.join(",")}`),
    );
    console.log(chalk.green("minimal.env updated"));
  });
}

async function traceN8n(): Promise<Set<string>> {
  const minimal = parseEnv(await fs.promises.readFile(path.resolve(__dirname, "minimal.env"), "utf8"));
  const port = minimal.N8N_PORT || "5678";
  const traceDir = path.resolve(".n8n-diet-trace");
  const logs = path.resolve("logs.txt");
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

  const proc = $`node node_modules/n8n/bin/n8n`.stdio("pipe", "pipe", "ignore").quiet();
  proc.stdout.pipe(logStream, { end: false });
  proc.stderr.pipe(logStream, { end: false });
  const base = `127.0.0.1:${port}`;
  await waitOn({
    resources: [`tcp:${base}`],
    timeout: Number(process.env.SERVER_WAIT_MS || 180_000),
    interval: 1000,
  });
  await waitOn({
    resources: [`http-get://${base}/`, `http-get://${base}/healthz`],
    interval: 2000,
    window: 20_000,
  });
  await waitOn({ resources: [`http-get://${base}/healthz`], interval: 1000, window: Number(process.env.POST_READY_MS || 15_000) });
  proc.kill("SIGTERM");
  await proc.nothrow();
  logStream.end();
  await finished(logStream);

  const text = await fs.promises.readFile(logs, "utf8");
  assert(text.length > 0, "logs.txt is empty");
  const keep = new Set<string>();
  const re = /node_modules\/(@[^\s/]+\/[^\s/]+|[^\s/@]+)/g;
  for (const m of text.matchAll(re)) keep.add(m[1].split("/")[0]);
  assert(keep.size > 0, "diet keep-set is empty");
  return keep;
}

async function pruneNodeModules(target: DietTarget, keep: Set<string>) {
  const nm = "node_modules";
  const keepTok = new Set(KEEP_TOKENS[target]);

  for (const name of await fs.promises.readdir(nm)) {
    if (name.startsWith("n8n-") || name.startsWith("acorn-") || keep.has(name)) continue;
    await fs.promises.rm(path.join(nm, name), { recursive: true, force: true });
  }

  for (const tok of ALL_PLATFORM_TOKENS) {
    if ([...keepTok].some((k) => tok === k || tok.startsWith(`${k}-`))) continue;
    await rmGlob(nm, `**/*${tok}*`);
  }
  for (const p of await glob("**/prebuilds/*", { cwd: nm, absolute: true }))
    if (![...keepTok].includes(path.basename(p))) await fs.promises.rm(p, { recursive: true, force: true });

  await rmGlob(nm, "**/*.{js.map,css.map}");
  await rmGlob(nm, "**/*.flow");
  await rmGlob(nm, "**/{__tests__,__test__,testdata,test-data,fixtures,fixture,__mocks__,test,coverage,benchmark,benchmarks,e2e,__snapshots__,demo,demos,.github}");
  await rmGlob(nm, "**/*.{test,spec,bench}.*");
  await rmGlob(nm, "**/*.{d.ts,d.ts.map}");

  const wantExt = NATIVE_EXT[target];
  for (const f of await glob("**/*.node", { cwd: nm, absolute: true })) {
    const t = await fileTypeFromFile(f);
    if (t?.ext !== wantExt) await fs.promises.rm(f, { force: true });
  }
  if (target.startsWith("linux")) await rmGlob(nm, "**/*.{dll,dylib}");
  else if (target.startsWith("win")) await rmGlob(nm, "**/*.dylib");
  else await rmGlob(nm, "**/*.dll");

  if (target.startsWith("linux")) {
    await rmGlob(nm, "**/*musl*");
    await rmGlob(nm, "**/*-musl");
  }

  await rmGlob(nm, "**/*.bc.js");
  for (const f of await glob("**/*.browser.*", { cwd: nm, absolute: true }))
    if (!f.endsWith(".browser.js")) await fs.promises.rm(f, { force: true });
  await rmGlob(nm, "**/*.{tar.gz,o,lo,la,a,obj}");
  await rmGlob(nm, "**/{CMakeCache.txt,Makefile,cmake_install.cmake}");
  await rmGlob(nm, "**/*.cmake");
  await rmGlob(nm, "**/{CMakeFiles,cmake,node-gyp}");
  await fs.promises.rm(path.join(nm, "sqlite3/deps"), { recursive: true, force: true });
  await rmGlob(nm, "**/{CHANGELOG*,changelog*,CHANGE*,README*,readme*,AUTHORS*,CONTRIBUTORS*,PATENTS*}");
  await rmGlob(nm, "**/{LICENSE,LICENSE.*,LICENSE-*,LICENCE,LICENCE.*,LICENCE-*}");
  await rmGlob(nm, "**/{.npmignore,.gitignore,.editorconfig,.gitattributes,.eslintrc*,.prettierrc*,.jshintrc,tsconfig.json,babel.config*,.babelrc*,rollup.config*,webpack.config*,jest.config*,karma.conf*,.nycrc*,lint-staged*,.huskyrc*,.lintstagedrc*}");
  await fs.promises.rm(path.join(nm, ".cache"), { recursive: true, force: true });
  await rmGlob(nm, "**/.cache");

  const trp = path.join(nm, "@n8n/task-runner-python");
  await fs.promises.rm(path.join(trp, "tests"), { recursive: true, force: true });
  await rmGlob(trp, "**/{__pycache__,.pytest_cache,.ruff_cache,.mypy_cache}");

  await fs.promises.rm(path.resolve(".n8n-diet-trace"), { recursive: true, force: true });
  await fs.promises.rm(path.resolve("logs.txt"), { force: true });
}

async function applyDiet() {
  console.log(chalk.green("Applying diet..."));
  await within(async () => {
    cd(BUILD());
    const target = resolveDietTarget();
    const keep = await traceN8n();
    await pruneNodeModules(target, keep);
    console.log(chalk.green("Diet applied"));
  });
}

async function packageDist() {
  console.log(chalk.green("Packaging dist..."));
  const buildDir = BUILD();
  const distDir = DIST();
  const chunksDir = path.join(distDir, "chunks");
  const { version } = require(path.join(buildDir, "node_modules", "n8n", "package.json"));

  const parts: Buffer[] = [];
  await pipeline(
    tar.c({ cwd: buildDir }, ["node_modules"]),
    lzma.createCompressor({ preset: 9 | (1 << 31) }),
    new Writable({
      write(chunk, _, cb) {
        parts.push(Buffer.from(chunk));
        cb();
      },
    }),
  );
  const xz = Buffer.concat(parts);
  const prefix = path.join(chunksDir, "node_modules.tar.xz.");
  for (let i = 0, off = 0; off < xz.length; i++, off += CHUNK) {
    await fs.promises.writeFile(`${prefix}${splitSuffix(i)}`, xz.subarray(off, off + CHUNK));
  }

  await fs.promises.writeFile(path.join(distDir, ".n8n-version"), `${version}\n`);
  const chunkNames = (await fs.promises.readdir(chunksDir)).filter((f) => f.startsWith("node_modules.tar.xz.")).sort();
  const sums: string[] = [];
  for (const name of chunkNames) {
    const data = await fs.promises.readFile(path.join(chunksDir, name));
    sums.push(`${crypto.createHash("sha256").update(data).digest("hex")}  ${name}`);
  }
  await fs.promises.writeFile(path.join(distDir, "sha256sums.txt"), `${sums.join("\n")}\n`);
  for (const line of sums) {
    const [hash, file] = line.split(/\s{2}/);
    const data = await fs.promises.readFile(path.join(chunksDir, file));
    assert(crypto.createHash("sha256").update(data).digest("hex") === hash);
  }

  await esbuild.build({
    entryPoints: [path.resolve(__dirname, "extract.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(distDir, "extract.js"),
    minify: true,
  });
  await fs.promises.chmod(path.join(distDir, "extract.js"), 0o755);
  await fs.promises.copyFile(path.resolve(__dirname, "minimal.env"), path.join(distDir, "minimal.env"));

  const target = resolveDietTarget();
  const { os, cpu } = PKG_OS_CPU[target];
  await fs.promises.writeFile(
    path.join(distDir, "package.json"),
    `${JSON.stringify(
      {
        name: "diet-n8n",
        version,
        bin: { "diet-n8n": "./node_modules/n8n/bin/n8n" },
        scripts: { postinstall: "node extract.js" },
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
  await prepare();
  await ensureDependencies();
  const n8nVersion = await installUpstream();
  await installPythonTaskRunner(n8nVersion);
  await updateMinimalEnv();
  await applyDiet();
  await packageDist();
}

main().catch((err) => {
  console.error(chalk.red(err));
  process.exit(1);
});
