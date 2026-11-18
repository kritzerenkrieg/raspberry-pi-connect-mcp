#!/usr/bin/env node
// Sets the release version in all six fields (package.json, package-lock.json x2, server.json x2,
// src/server.js). Every edit is computed and checked before any file is written; if a write
// itself fails, it reports which files were already updated.
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
// Validation happened above, so nothing is written for a bad version or a missing field. A write
// error (disk full, permissions) can still stop halfway: then say exactly which files changed.
const written = [];
for (const [p, content] of Object.entries(files)) {
  try {
    fs.writeFileSync(path.join(root, p), content);
    written.push(p);
  } catch (e) {
    console.error(`Writing ${p} failed: ${e.message}`);
    console.error(written.length
      ? `Already updated to ${version}: ${written.join(', ')}. Not updated: ${Object.keys(files).filter((f) => !written.includes(f)).join(', ')}.\nFix the write error, then run the same command again (it is safe to repeat).`
      : 'No files were changed.');
    process.exit(1);
  }
}
console.log(`Set version ${version} in ${written.join(', ')}`);
