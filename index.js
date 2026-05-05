#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const n8nPath = path.join(__dirname, 'node_modules', 'n8n', 'bin', 'n8n');

if (!fs.existsSync(n8nPath)) {
  console.error(`diet-n8n: n8n CLI not found at ${n8nPath}`);
  console.error('Run `node extract.js` or reinstall the package.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [n8nPath, ...process.argv.slice(2)], {
  stdio: 'inherit'
});

process.exit(result.status ?? 0);
