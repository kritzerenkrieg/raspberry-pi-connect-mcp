#!/usr/bin/env node
// Sets the release version in all six fields (package.json, package-lock.json x2, server.json x2,
// src/server.js). Every edit is computed and checked before any file is written; each file is
// replaced atomically, and a failed write reports which files were already updated.
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
// Validation happened above, so nothing is written for a bad version or a missing field. Each file
// is written to a temporary file next to it and renamed over it, so a failed write (disk full,
// permissions) leaves that file as it was and a rerun can still read it.
const written = [];
for (const [p, content] of Object.entries(files)) {
  const target = path.join(root, p);
  const tmp = `${target}.set-version-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: fs.statSync(target).mode });
    fs.renameSync(tmp, target);
    written.push(p);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    console.error(`Writing ${p} failed: ${e.message}`);
    console.error(written.length
      ? `Already updated to ${version}: ${written.join(', ')}. Unchanged: ${Object.keys(files).filter((f) => !written.includes(f)).join(', ')}.\nFix the write error, then run the same command again (it is safe to repeat).`
      : 'No files were changed.');
    process.exit(1);
  }
}
console.log(`Set version ${version} in ${written.join(', ')}`);
