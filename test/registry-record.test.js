// scripts/registry-record.mjs: comparing a published MCP Registry record with server.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, sameInstall, decide, lookup } from '../scripts/registry-record.mjs';

const env = (name, extra = {}) => ({ name, description: `about ${name}`, ...extra });
const local = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: 'io.github.someone/server',
  title: 'Server',
  description: 'local description',
  version: '1.0.0',
  packages: [{
    registryType: 'npm', identifier: 'server', version: '1.0.0', transport: { type: 'stdio' },
    environmentVariables: [env('A', { isRequired: false, isSecret: false }), env('B', { isSecret: false })],
  }],
};
// What the registry stores: defaults dropped, keys reordered, its own _meta added.
const record = {
  server: {
    version: '1.0.0', name: 'io.github.someone/server', description: 'other text', $schema: local.$schema,
    packages: [{
      transport: { type: 'stdio' }, version: '1.0.0', identifier: 'server', registryType: 'npm',
      environmentVariables: [env('A'), env('B')],
    }],
  },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: '2026-01-01T00:00:00Z' } },
};

test('normalize drops defaults and sorts keys', () => {
  assert.deepEqual(normalize({ b: false, a: [{ y: '', x: 1 }], c: [], d: null, e: {} }), { a: [{ x: 1 }] });
});

test('a stored record matches its server.json despite dropped defaults and other metadata', () => {
  assert.equal(sameInstall(record, local).same, true);
});

for (const [label, change] of [
  ['package version', (s) => { s.packages[0].version = '1.0.1'; }],
  ['package identifier', (s) => { s.packages[0].identifier = 'other'; }],
  ['transport', (s) => { s.packages[0].transport = { type: 'streamable-http', url: 'https://x' }; }],
  ['a required variable', (s) => { s.packages[0].environmentVariables[0].isRequired = true; }],
  ['an extra variable', (s) => { s.packages[0].environmentVariables.push(env('C')); }],
  ['remotes', (s) => { s.remotes = [{ type: 'streamable-http', url: 'https://x' }]; }],
]) {
  test(`a different ${label} is a different install configuration`, () => {
    const changed = structuredClone(local);
    change(changed);
    assert.equal(sameInstall(record, changed).same, false);
  });
}

test('format "string" is the default; other formats still count', () => {
  const withFormat = structuredClone(record);
  withFormat.server.packages[0].environmentVariables[0].format = 'string';
  assert.equal(sameInstall(withFormat, local).same, true);
  withFormat.server.packages[0].environmentVariables[0].format = 'number';
  assert.equal(sameInstall(withFormat, local).same, false);
});

test('an empty variables entry is kept, so adding one is a difference', () => {
  const remote = (variables) => ({ ...local, remotes: [{ type: 'streamable-http', url: 'https://{region}.x', variables }] });
  assert.deepEqual(normalize(remote({ region: {} }).remotes), [{ type: 'streamable-http', url: 'https://{region}.x', variables: { region: {} } }]);
  assert.equal(sameInstall(remote(undefined), remote({ region: {} })).same, false);
  assert.equal(sameInstall(remote({ region: { isRequired: false } }), remote({ region: {} })).same, true);
});

const meta = (status) => ({ ...record, _meta: { 'io.modelcontextprotocol.registry/official': { status } } });
for (const [label, status, body, server, action] of [
  ['absent', 404, null, local, 'publish'],
  ['same record, active', 200, meta('active'), local, 'skip'],
  ['same record, deprecated', 200, meta('deprecated'), local, 'skip'],
  ['different record', 200, meta('active'), { ...local, remotes: [{ type: 'sse', url: 'https://x' }] }, 'stop'],
  ['deleted', 200, meta('deleted'), local, 'stop'],
  ['unknown status', 200, meta('weird'), local, 'stop'],
  ['server error', 503, null, local, 'stop'],
  ['network error', 0, null, local, 'stop'],
]) {
  test(`decide: ${label} -> ${action}`, () => {
    assert.equal(decide(status, body, server).action, action);
  });
}

test('lookup asks for the exact version including deleted ones, and retries 5xx and network errors', async () => {
  const urls = [];
  const replies = [() => { throw new Error('down'); }, () => ({ status: 502 }), () => ({ status: 200, json: async () => meta('active') })];
  const fetch = async (url) => { urls.push(url); return replies[urls.length - 1](); };
  const r = await lookup(local, { fetch, wait: 0 });
  assert.equal(r.status, 200);
  assert.equal(urls.length, 3);
  assert.equal(urls[0], 'https://registry.modelcontextprotocol.io/v0/servers/io.github.someone%2Fserver/versions/1.0.0?include_deleted=true');
});

test('lookup does not retry a 404', async () => {
  let n = 0;
  const r = await lookup(local, { fetch: async () => { n++; return { status: 404 }; }, wait: 0 });
  assert.deepEqual([r.status, n], [404, 1]);
});
