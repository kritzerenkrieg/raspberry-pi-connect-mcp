#!/usr/bin/env node
// Release gate: fails unless the tag is vX.Y.Z, all six version fields equal X.Y.Z, the npm entry in
// server.json is unambiguous and package.json mcpName matches server.json name.
// Usage: node scripts/check-release.mjs v0.2.1     (no tag: checks the files only)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, releaseProblems } from './versions.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2];
const s = load(root);
const problems = releaseProblems(s, tag);
if (problems.length) {
  for (const p of problems) console.log(`::error::${p}`);
  process.exit(1);
}
console.log(`OK: ${tag ? `tag ${tag}, ` : ''}version ${s.pkg.version} in all six fields; mcpName ${s.pkg.mcpName}`);
