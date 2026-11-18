#!/usr/bin/env node
// Compares an MCP Registry record with server.json on the fields that decide how clients install
// and run the server. The registry omits default values when it stores a record (isRequired: false,
// empty lists, ...), so both sides are normalized the same way before comparing.
// Usage: node scripts/registry-record.mjs <lookup.json> [server.json]
//   exit 0: same install configuration; exit 1: differs (prints both sides).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const INSTALL_FIELDS = ['name', 'version', 'packages', 'remotes'];

// Drops false, null, '' and empty arrays/objects, and sorts object keys.
export function normalize(value) {
  if (Array.isArray(value)) {
    const items = value.map(normalize).filter((v) => v !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = normalize(value[key]);
      if (v !== undefined) out[key] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value === false || value === null || value === '' ? undefined : value;
}

export function installConfig(server) {
  return normalize(Object.fromEntries(INSTALL_FIELDS.map((k) => [k, server?.[k]]))) ?? {};
}

// `record`: the registry's response ({ server, _meta }) or a bare server object.
export function sameInstall(record, serverJson) {
  const published = installConfig(record?.server ?? record);
  const local = installConfig(serverJson);
  return { same: JSON.stringify(published) === JSON.stringify(local), published, local };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [lookup, serverFile = 'server.json'] = process.argv.slice(2);
  const { same, published, local } = sameInstall(
    JSON.parse(fs.readFileSync(lookup, 'utf8')),
    JSON.parse(fs.readFileSync(serverFile, 'utf8')),
  );
  if (!same) {
    console.log('Published record (install fields):', JSON.stringify(published, null, 2));
    console.log(`${serverFile} (install fields):`, JSON.stringify(local, null, 2));
    process.exit(1);
  }
}
