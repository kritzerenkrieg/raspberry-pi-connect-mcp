#!/usr/bin/env node
// The MCP Registry side of a release: looks up server.json's exact name and version (deleted
// versions included) and decides what to do. Used twice by the release workflow: by the npm job
// before `npm publish` (so a registry conflict stops the release before npm uses up the version) and
// by the mcp-registry job (for records created in between).
//
// Usage: node scripts/registry-record.mjs [server.json] [--out <file>]
//   exit 0: "publish" (absent) or "skip" (already there with the same install configuration),
//           written to <file> if given (stdout stays free for the log and annotations)
//   exit 1: an ::error:: for a conflict, a deleted version, or a failed lookup.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REGISTRY = 'https://registry.modelcontextprotocol.io';
export const INSTALL_FIELDS = ['name', 'version', 'packages', 'remotes'];

// Canonical form for comparing: sorted keys; drops the values the registry omits when it stores a
// record (false, null, '', empty arrays/objects) and `format: "string"` (the schema's default).
// Entries of a `variables` map are kept even when empty: their presence decides URL substitution.
export function normalize(value, key) {
  if (key === 'format' && value === 'string') return undefined;
  if (Array.isArray(value)) {
    const items = value.map((v) => normalize(v)).filter((v) => v !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = normalize(value[k], k);
      if (v !== undefined) out[k] = v;
      else if (key === 'variables' && value[k] && typeof value[k] === 'object') out[k] = {};
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

// From the lookup's HTTP status and parsed body: { action: 'publish' | 'skip' | 'stop', message }.
export function decide(status, body, serverJson) {
  const v = serverJson.version;
  if (status === 404) return { action: 'publish', message: `Version ${v} is not in the MCP Registry` };
  if (status !== 200) return { action: 'stop', message: `MCP Registry lookup returned HTTP ${status}; not publishing` };
  const state = body?._meta?.['io.modelcontextprotocol.registry/official']?.status ?? 'unknown';
  if (state === 'deleted') return { action: 'stop', message: `Version ${v} was deleted from the MCP Registry and can't be published again. Release the next patch version.` };
  if (state !== 'active' && state !== 'deprecated') return { action: 'stop', message: `MCP Registry returned version ${v} with status '${state}'; not publishing` };
  const cmp = sameInstall(body, serverJson);
  if (!cmp.same) {
    return {
      action: 'stop',
      message: `Version ${v} is already in the MCP Registry with a different install configuration; it can't be replaced. Release the next patch version.`,
      details: `Published (install fields): ${JSON.stringify(cmp.published, null, 2)}\nserver.json (install fields): ${JSON.stringify(cmp.local, null, 2)}`,
    };
  }
  return { action: 'skip', message: `Version ${v} is already in the MCP Registry (${state}) with this server.json` };
}

// Exact name + version lookup with retries for network errors and 5xx.
export async function lookup(serverJson, { fetch = globalThis.fetch, tries = 3, wait = 2000 } = {}) {
  const url = `${REGISTRY}/v0/servers/${encodeURIComponent(serverJson.name)}/versions/${encodeURIComponent(serverJson.version)}?include_deleted=true`;
  let last = 0;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(url);
      last = res.status;
      if (res.status === 200) return { status: 200, body: await res.json() };
      if (res.status < 500) return { status: res.status, body: null };
    } catch {
      last = 0; // network error: retry
    }
  }
  return { status: last, body: null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt === -1 ? null : args.splice(outAt, 2)[1];
  const serverJson = JSON.parse(fs.readFileSync(args[0] || 'server.json', 'utf8'));
  const { status, body } = await lookup(serverJson);
  const d = decide(status, body, serverJson);
  if (d.details) console.log(d.details);
  if (d.action === 'stop') {
    console.log(`::error::${d.message}`);
    process.exit(1);
  }
  console.log(`${d.message}: ${d.action}`);
  if (out) fs.writeFileSync(out, `${d.action}\n`);
}
