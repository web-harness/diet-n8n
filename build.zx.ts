import assert from "assert";
import https from "https";
import path from "path";
import zlib from "zlib";
import fs from "fs";
import * as tar from "tar";

import { $, cd, chalk, within } from "zx";

const PYTHON_BIN = process.env.DIET_N8N_PYTHON_BIN || "python3";

async function prepare() {
  console.log(chalk.green("Preparing build environment..."));
  await within(async () => {
    cd(__dirname);
    await fs.promises.rm("dist", { recursive: true, force: true });
    await fs.promises.rm("build", { recursive: true, force: true });
    await fs.promises.mkdir("dist", { recursive: true });
    await fs.promises.mkdir("build", { recursive: true });
  });
}

async function ensureDependencies() {
  console.log(chalk.green("Ensuring dependencies are installed..."));
  await within(async () => {
    cd(__dirname);
    // check for python 3.12 OR 3.13, pip, venv, uv, and node 24
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
    cd(path.resolve(__dirname, "build"));
    await $`npm init -y`;
    await $`npm install n8n --omit=dev --no-audit --no-fund --save`;
    console.log(chalk.green("Upstream n8n installed"));
    const { version } = require(path.resolve(__dirname, "build", "node_modules", "n8n", "package.json"));
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
    cd(path.resolve(__dirname, "build"));

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
    const minimalEnvContentUpdated = minimalEnvContent.replace(
      /N8N_DISABLED_MODULES=.*$/m,
      `N8N_DISABLED_MODULES=${skippedModules.join(",")}`,
    );
    await fs.promises.writeFile(minimalEnv, minimalEnvContentUpdated);
    console.log(chalk.green("minimal.env updated"));
  });
}

async function main() {
  await prepare();
  await ensureDependencies();
  const n8nVersion = await installUpstream();
  await installPythonTaskRunner(n8nVersion);
  await updateMinimalEnv();
}

main().catch((err) => {
  console.error(chalk.red(err));
  process.exit(1);
});
