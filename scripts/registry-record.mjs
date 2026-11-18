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

// Canonical form for comparing, following how the registry (Go, v1.8.9 pkg/model) stores a record:
// - an object field that is false, '', 0, null, an empty list or an empty map is omitted
//   (`omitempty` on the optional fields: isRequired, isSecret, value, choices, ...);
// - except in packageArguments / runtimeArguments: Argument's own MarshalJSON (argument.go) keeps
//   an explicitly empty `value` or `valueHint`, so '' there differs from omitted;
// - list elements are kept as they are (a '' choice stays a choice);
// - every entry of a `variables` map is kept, even when empty (its presence decides substitution);
//   entries are input descriptors whatever their name (a variable may be called "variables");
// - `format: "string"` equals no format (the schema's default).
// Objects get sorted keys and a null prototype, so a key like "__proto__" stays an own property.
const isEmpty = (v) => v === undefined || v === false || v === null || v === '' || v === 0
  || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v && !Array.isArray(v) && Object.keys(v).length === 0);
const KEEP_EMPTY_IN_ARGUMENT = new Set(['value', 'valueHint']);

// `kind`: what `value` is. 'object' (a model struct), 'variables' (a name -> input map) or
// 'argument' (an entry of packageArguments / runtimeArguments).
export function normalize(value, kind = 'object') {
  if (Array.isArray(value)) return value.map((v) => (v && typeof v === 'object' ? normalize(v, kind) : v));
  if (!value || typeof value !== 'object') return value;
  const out = Object.create(null);
  for (const k of Object.keys(value).sort()) {
    if (kind === 'variables') {
      const v = normalize(value[k]);
      out[k] = v && typeof v === 'object' ? v : value[k] ?? Object.create(null);
      continue;
    }
    const childKind = k === 'variables' ? 'variables' : k === 'packageArguments' || k === 'runtimeArguments' ? 'argument' : 'object';
    const v = normalize(value[k], childKind);
    if (k === 'format' && v === 'string') continue;
    if (kind === 'argument' && KEEP_EMPTY_IN_ARGUMENT.has(k) && v === '') out[k] = v;
    else if (!isEmpty(v)) out[k] = v;
  }
  return out;
}

export function installConfig(server) {
  return normalize(Object.fromEntries(INSTALL_FIELDS.map((k) => [k, server?.[k]])));
}

// `record`: the registry's response ({ server, _meta }) or a bare server object.
export function sameInstall(record, serverJson) {
  const published = installConfig(record?.server ?? record);
  const local = installConfig(serverJson);
  return { same: JSON.stringify(published) === JSON.stringify(local), published, local };
}

// From the lookup's result: { action: 'publish' | 'skip' | 'stop', message }.
// `error`: why the last attempt failed ('timeout', 'invalid-json', 'body' or 'network'), if it did.
export function decide(status, body, serverJson, error) {
  const v = serverJson.version;
  if (error) {
    const what = {
      timeout: 'timed out',
      'invalid-json': `returned HTTP ${status} with a body that is not valid JSON`,
      body: `returned HTTP ${status} but the body could not be read`,
      network: 'could not connect',
    }[error] ?? error;
    return { action: 'stop', message: `MCP Registry lookup ${what} (after retries); not publishing` };
  }
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

// Exact name + version lookup. Up to `tries` attempts for network errors, timeouts, 429 and 5xx;
// any other status is returned at once. Each attempt has its own deadline covering the body too.
export const retryable = (status) => status === 0 || status === 429 || status >= 500;
export async function lookup(serverJson, { fetch = globalThis.fetch, tries = 3, wait = 2000, timeout = 30_000 } = {}) {
  const url = `${REGISTRY}/v0/servers/${encodeURIComponent(serverJson.name)}/versions/${encodeURIComponent(serverJson.version)}?include_deleted=true`;
  let last = { status: 0, body: null, error: 'network' };
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, wait));
    let status = 0;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      status = res.status;
      if (res.status === 200) return { status: 200, body: await res.json() };
      if (!retryable(res.status)) return { status: res.status, body: null };
      last = { status, body: null };
    } catch (e) {
      // Keep why it failed, for the log: a deadline, a 200 with a broken body, or the connection.
      // `status` is set once headers arrived, so a later failure is about reading the body (the
      // connection closing early, a bad Content-Encoding, ...), not about connecting.
      const error = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout'
        : e instanceof SyntaxError ? 'invalid-json'
          : status ? 'body' : 'network';
      last = { status, body: null, error };
    }
  }
  return last;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt === -1 ? null : args.splice(outAt, 2)[1];
  const serverJson = JSON.parse(fs.readFileSync(args[0] || 'server.json', 'utf8'));
  const { status, body, error } = await lookup(serverJson);
  const d = decide(status, body, serverJson, error);
  if (d.details) console.log(d.details);
  if (d.action === 'stop') {
    console.log(`::error::${d.message}`);
    process.exit(1);
  }
  console.log(`${d.message}: ${d.action}`);
  if (out) fs.writeFileSync(out, `${d.action}\n`);
}
