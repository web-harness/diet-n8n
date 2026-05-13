#!/usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import createDebug from "debug";
import { XzReadableStream } from "xz-decompress";
import tar from "tar-fs";

const dbg = createDebug("dietn8n:extract");
const dbgProgress = createDebug("dietn8n:extract:progress");

const DEST_DIR = process.argv[2] || __dirname;

function die(msg: string) {
  console.error(`diet-n8n: ${msg}`);
  process.exit(1);
}

function resolvePath(rel: string) {
  const distPath = path.join(__dirname, "dist", rel);
  if (fs.existsSync(distPath)) return distPath;
  const directPath = path.join(__dirname, rel);
  if (fs.existsSync(directPath)) return directPath;
  return directPath; // Default to pkg context
}
const CHUNKS_DIR = resolvePath("chunks");
const SUMS_FILE = resolvePath("sha256sums.txt");
const N8N_MARKER = path.join(DEST_DIR, "node_modules", "n8n", "package.json");

const tStart = Date.now();

if (fs.existsSync(N8N_MARKER)) {
  dbg(`n8n already present at ${N8N_MARKER}, skipping extract.`);
  process.exit(0);
}

dbg(`destination: ${DEST_DIR}`);
dbg(`chunks dir:  ${CHUNKS_DIR}`);
dbg(`checksums:   ${SUMS_FILE}`);

const sums: Record<string, string> = {};
try {
  const lines = fs.readFileSync(SUMS_FILE, "utf-8").trim().split("\n");
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) sums[parts[1]] = parts[0];
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

const tVerify = Date.now();
const chunks: Buffer<ArrayBufferLike>[] = [];
for (let i = 0; i < chunkFiles.length; i++) {
  const file = chunkFiles[i];
  const filePath = path.join(CHUNKS_DIR, file);
  dbgProgress(`verify ${i + 1}/${chunkFiles.length}: ${file}`);
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
const verifyMs = Date.now() - tVerify;
const verifiedBytes = chunks.reduce((n, b) => n + b.length, 0);
dbg(
  `checksums OK — ${chunkFiles.length} chunk(s), ${(verifiedBytes / 1024 / 1024).toFixed(1)} MB in ${(verifyMs / 1000).toFixed(2)}s`,
);

const compressed = Buffer.concat(chunks);

dbg(`decompressing xz and extracting tar (${(compressed.length / 1024 / 1024).toFixed(1)} MB compressed)...`);

const webStream = new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array(compressed));
    controller.close();
  },
});

const decompressedStream = new XzReadableStream(webStream);
const nodeStream = Readable.fromWeb(decompressedStream as NodeWebReadableStream);

const tExtract = Date.now();
let streamedBytes = 0;
let lastProgressAt = 0;
const progressEveryMs = 300;

const byteTap = new Transform({
  transform(chunk, _enc, cb) {
    streamedBytes += chunk.length;
    const now = Date.now();
    if (now - lastProgressAt >= progressEveryMs) {
      lastProgressAt = now;
      const mb = (streamedBytes / 1024 / 1024).toFixed(1);
      dbgProgress(`extract stream ${mb} MB (tar payload)`);
    }
    cb(null, chunk);
  },
  flush(cb) {
    cb();
  },
});

const extract = tar.extract(DEST_DIR, {
  ignore: (name) => {
    const relative = path.relative(DEST_DIR, name);
    return !relative.startsWith("node_modules");
  },
});

nodeStream.pipe(byteTap).pipe(extract);

extract.on("finish", () => {
  const extractMs = Date.now() - tExtract;
  const totalMs = Date.now() - tStart;
  const mb = (streamedBytes / 1024 / 1024).toFixed(1);
  dbg(
    `extraction complete — ${mb} MB tar stream in ${(extractMs / 1000).toFixed(2)}s (total ${(totalMs / 1000).toFixed(2)}s)`,
  );
});

extract.on("error", (err) => {
  die(`extraction failed: ${err.message}`);
});

nodeStream.on("error", (err) => {
  die(`upstream stream failed: ${err.message}`);
});

byteTap.on("error", (err) => {
  die(`stream tap failed: ${err.message}`);
});
