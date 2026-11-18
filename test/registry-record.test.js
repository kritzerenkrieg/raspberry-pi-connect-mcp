// scripts/registry-record.mjs: comparing a published MCP Registry record with server.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, sameInstall } from '../scripts/registry-record.mjs';

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
