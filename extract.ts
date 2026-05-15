#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import createDebug from "debug";
import { XzReadableStream } from "xz-decompress";
import minimist from "minimist";
import which from "which";
import { globSync } from "glob";
import tar from "tar-fs";
import assert from "node:assert";

const dbg = createDebug("dietn8n");
const argv = minimist(process.argv.slice(2));

dbg.enabled = true;

function die(msg: string, exitCode: number = 1) {
  console.error(`diet-n8n: ${msg}`);
  process.exit(exitCode);
}

function findPython() {
  const python3 = which.sync("python3", { nothrow: true });
  if (python3) return python3;
  const python = which.sync("python", { nothrow: true });
  if (python) return python;
  return null;
}

enum PythonVersion {
  Python312 = "3.12",
  Python313 = "3.13",
  Unsupported = "unsupported",
}

function getPythonVersion(): PythonVersion {
  const python = findPython();
  assert(python, "python not found");
  dbg(`using Python ${python}`);
  const version = execFileSync(python, ["--version"], { encoding: "utf-8" }).trim();
  dbg(`Python version: ${version}`);
  if (version.match(/\s+3\.12/)) return PythonVersion.Python312;
  if (version.match(/\s+3\.13/)) return PythonVersion.Python313;
  return PythonVersion.Unsupported;
}

const DEST_DIR: string = path.resolve(argv.dest || argv.d || argv._[0] || __dirname);
dbg(`destination chosen: ${DEST_DIR}`);

if (!fs.existsSync(DEST_DIR)) {
  die(`destination directory ${DEST_DIR} does not exist`);
}

const CHUNKS_DIR = path.join(DEST_DIR, "chunks");
const SUMS_FILE = path.join(DEST_DIR, "sha256sums.txt");
const N8N_MARKER = path.join(DEST_DIR, "node_modules", "n8n", "package.json");

if (fs.existsSync(N8N_MARKER)) {
  die(`n8n already present at ${N8N_MARKER}`, 0);
}

dbg(`chunks dir: ${CHUNKS_DIR}`);
dbg(`checksums: ${SUMS_FILE}`);

const sums: Record<string, string> = {};
try {
  const lines = fs.readFileSync(SUMS_FILE, "utf-8").trim().split("\n");
  for (const line of lines) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) sums[parts[1]] = parts[0];
    else die(`invalid checksum line: ${line}`);
  }
  dbg(`loaded ${Object.keys(sums).length} expected checksums`);
} catch (err) {
  die(`failed to read checksums: ${err.message}`);
}

let chunkFiles: string[] = [];
try {
  chunkFiles = fs
    .readdirSync(CHUNKS_DIR)
    .filter((f: string) => f.startsWith("node_modules.tar.xz."))
    .sort();
} catch (err) {
  die(`failed to read chunks directory: ${err.message}`);
}

if (chunkFiles.length === 0) {
  die(`no chunk files found in ${CHUNKS_DIR}`);
}

dbg(`found ${chunkFiles.length} chunk file(s), verifying SHA-256...`);

const chunks: Buffer<ArrayBufferLike>[] = [];
for (let i = 0; i < chunkFiles.length; i++) {
  const file = chunkFiles[i];
  const filePath = path.join(CHUNKS_DIR, file);
  let data = Buffer.alloc(0);
  try {
    data = fs.readFileSync(filePath);
  } catch (err) {
    die(`failed to read ${file}: ${err.message}`);
  }

  const hash = crypto.createHash("sha256").update(data).digest("hex");
  if (hash !== sums[file]) {
    die(`diet-n8n: SHA256 mismatch for ${file}`);
  }

  chunks.push(data);
}

dbg("checksums OK");

const compressed = Buffer.concat(chunks);

dbg("decompressing xz and extracting tar, this may take a while...");

const webStream = new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array(compressed));
    controller.close();
  },
});

const decompressedStream = new XzReadableStream(webStream);
const nodeStream = Readable.fromWeb(decompressedStream as NodeWebReadableStream);

const extract = tar.extract(DEST_DIR, {
  ignore: (name) => {
    const relative = path.relative(DEST_DIR, name);
    return !relative.startsWith("node_modules");
  },
});

nodeStream.pipe(extract);

extract.on("finish", () => {
  dbg("extraction complete, setting up Python task runner...");

  const tr = path.join(DEST_DIR, "node_modules", "@n8n", "task-runner-python");
  const chosen = findPython();
  if (!chosen) {
    die("python not found, skipping Python task runner setup", 0);
  }
  assert(chosen, "python not found");
  const version = getPythonVersion();
  if (version === PythonVersion.Unsupported) {
    die("unsupported Python version, skipping Python task runner setup", 0);
  }

  fs.renameSync(path.join(tr, `.venv.${version}`), path.join(tr, ".venv"));
  const otherVenvs = globSync(path.join(tr, ".venv.*"));
  for (const otherVenv of otherVenvs) {
    dbg(`removing incompatible venv: ${otherVenv}`);
    fs.rmSync(otherVenv, { recursive: true });
  }
  execFileSync(chosen, ["-m", "venv", ".venv", "--upgrade"], { stdio: "inherit", cwd: tr });
  dbg("Python task runner setup complete");
});

extract.on("error", (err) => {
  die(`extraction failed: ${err.message}`);
});

nodeStream.on("error", (err) => {
  die(`upstream stream failed: ${err.message}`);
});
