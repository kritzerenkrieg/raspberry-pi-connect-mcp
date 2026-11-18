#!/usr/bin/env node
// Sets the release version in all six fields (package.json, package-lock.json x2, server.json x2,
// src/server.js). Every edit is computed and checked before any file is written.
// Usage: npm run set-version -- 0.2.1
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, withVersion } from './versions.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
let files;
try {
  files = withVersion(load(root), version || '');
} catch (e) {
  console.error(`${e.message}\nUsage: npm run set-version -- <major.minor.patch>   e.g. 0.2.1`);
  process.exit(1);
}
for (const [p, content] of Object.entries(files)) fs.writeFileSync(path.join(root, p), content);
console.log(`Set version ${version} in ${Object.keys(files).join(', ')}`);
