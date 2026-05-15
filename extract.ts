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
import tar from "tar-fs";

const dbg = createDebug("dietn8n");
const argv = minimist(process.argv.slice(2));

function die(msg: string, exitCode: number = 1) {
  console.error(`diet-n8n: ${msg}`);
  process.exit(exitCode);
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

dbg("decompressing xz and extracting tar");

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
  const chosen = execFileSync(
    "sh",
    ["-c", 'if python3.13 -c "import sys"; then echo python3.13; else python3.12 -c "import sys"; echo python3.12; fi'],
    { encoding: "utf-8" },
  ).trim();
  dbg(`using Python ${chosen}`);
  const suffix = chosen === "python3.13" ? "3.13" : "3.12";
  fs.renameSync(path.join(tr, `.venv.${suffix}`), path.join(tr, ".venv"));
  const otherSuffix = chosen === "python3.13" ? "3.12" : "3.13";
  fs.rmSync(path.join(tr, `.venv.${otherSuffix}`), { recursive: true });
  execFileSync(chosen, ["-m", "venv", ".venv", "--upgrade"], { stdio: "inherit", cwd: tr });
  dbg("Python task runner setup complete");
});

extract.on("error", (err) => {
  die(`extraction failed: ${err.message}`);
});

nodeStream.on("error", (err) => {
  die(`upstream stream failed: ${err.message}`);
});
