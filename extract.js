#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { XzReadableStream } = require('xz-decompress');
const tar = require('tar-fs');

const DEST_DIR = process.argv[2] || __dirname;
function resolvePath(rel) {
  const distPath = path.join(__dirname, 'dist', rel);
  if (fs.existsSync(distPath)) return distPath;
  const directPath = path.join(__dirname, rel);
  if (fs.existsSync(directPath)) return directPath;
  return directPath; // Default to pkg context
}
const CHUNKS_DIR = resolvePath('chunks');
const SUMS_FILE = resolvePath('sha256sums.txt');
const N8N_MARKER = path.join(DEST_DIR, 'node_modules', 'n8n', 'package.json');

if (fs.existsSync(N8N_MARKER)) {
  console.log('diet-n8n: n8n already extracted, skipping.');
  process.exit(0);
}

let sums;
try {
  const lines = fs.readFileSync(SUMS_FILE, 'utf-8').trim().split('\n');
  sums = {};
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) sums[parts[1]] = parts[0];
  }
} catch (err) {
  console.error(`diet-n8n: Failed to read checksums: ${err.message}`);
  process.exit(1);
}

let chunkFiles;
try {
  chunkFiles = fs.readdirSync(CHUNKS_DIR)
    .filter(f => f.startsWith('node_modules.tar.xz.'))
    .sort();
} catch (err) {
  console.error(`diet-n8n: Failed to read chunks directory: ${err.message}`);
  process.exit(1);
}

if (chunkFiles.length === 0) {
  console.error(`diet-n8n: No chunk files found in ${CHUNKS_DIR}`);
  process.exit(1);
}

console.log(`diet-n8n: Verifying ${chunkFiles.length} chunks...`);

const chunks = chunkFiles.map(file => {
  const filePath = path.join(CHUNKS_DIR, file);
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch (err) {
    console.error(`diet-n8n: Failed to read ${file}: ${err.message}`);
    process.exit(1);
  }

  const hash = crypto.createHash('sha256').update(data).digest('hex');
  if (hash !== sums[file]) {
    console.error(`diet-n8n: SHA256 mismatch for ${file}`);
    console.error(`  expected: ${sums[file]}`);
    console.error(`  actual:   ${hash}`);
    process.exit(1);
  }

  return data;
});

const compressed = Buffer.concat(chunks);

console.log(`diet-n8n: Verified, decompressing (${(compressed.length / 1024 / 1024).toFixed(1)} MB)...`);

const webStream = new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array(compressed));
    controller.close();
  }
});

const decompressedStream = new XzReadableStream(webStream);
const nodeStream = Readable.fromWeb(decompressedStream);

const extract = tar.extract(DEST_DIR, {
  ignore: (name) => {
    const relative = path.relative(DEST_DIR, name);
    return !relative.startsWith('node_modules');
  }
});

nodeStream.pipe(extract);

extract.on('finish', () => {
  console.log('diet-n8n: Extraction complete.');
});

extract.on('error', (err) => {
  console.error(`diet-n8n: Extraction failed: ${err.message}`);
  process.exit(1);
});
