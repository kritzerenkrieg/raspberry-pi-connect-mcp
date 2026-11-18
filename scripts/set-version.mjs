#!/usr/bin/env node
// Sets the release version everywhere it is written down: package.json, package-lock.json,
// server.json (server and npm package entry) and the version the MCP server reports.
// Usage: npm run set-version -- 0.2.1
import fs from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version || '')) {
  console.error('Usage: npm run set-version -- <major.minor.patch>   e.g. 0.2.1');
  process.exit(1);
}

const file = (p) => new URL(`../${p}`, import.meta.url);
const editJson = (p, fn) => {
  const j = JSON.parse(fs.readFileSync(file(p), 'utf8'));
  fn(j);
  fs.writeFileSync(file(p), JSON.stringify(j, null, 2) + '\n');
};

editJson('package.json', (j) => { j.version = version; });
editJson('package-lock.json', (j) => { j.version = version; j.packages[''].version = version; });
editJson('server.json', (j) => {
  j.version = version;
  for (const p of j.packages) if (p.registryType === 'npm' && p.identifier === 'raspberry-pi-connect-mcp') p.version = version;
});

const src = fs.readFileSync(file('src/server.js'), 'utf8');
const re = /(new McpServer\(\{ name: 'rpi-connect', version: ')[^']*('\s*\}\))/;
if (!re.test(src)) { console.error('src/server.js: McpServer version line not found'); process.exit(1); }
fs.writeFileSync(file('src/server.js'), src.replace(re, `$1${version}$2`));

console.log(`Set version ${version} in package.json, package-lock.json, server.json, src/server.js`);
