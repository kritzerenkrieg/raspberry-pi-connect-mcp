// scripts/registry-record.mjs: comparing a published MCP Registry record with server.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, sameInstall, decide, lookup } from '../scripts/registry-record.mjs';

const plain = (v) => JSON.parse(JSON.stringify(v));

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
  assert.deepEqual(plain(normalize({ b: false, a: [{ y: '', x: 1 }], c: [], d: null, e: {} })), { a: [{ x: 1 }] });
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
  assert.deepEqual(plain(normalize(remote({ region: {} }).remotes)), [{ type: 'streamable-http', url: 'https://{region}.x', variables: { region: {} } }]);
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

test('lookup asks for the exact version including deleted ones, retries, and its result decides', async () => {
  const urls = [];
  const replies = [() => { throw new Error('down'); }, () => ({ status: 502 }), () => ({ status: 200, json: async () => meta('active') })];
  const fetch = async (url, opts) => { urls.push(url); assert.ok(opts.signal instanceof AbortSignal); return replies[urls.length - 1](); };
  const r = await lookup(local, { fetch, wait: 0 });
  assert.equal(r.status, 200);
  assert.equal(decide(r.status, r.body, local).action, 'skip');
  assert.equal(urls.length, 3);
  assert.equal(urls[0], 'https://registry.modelcontextprotocol.io/v0/servers/io.github.someone%2Fserver/versions/1.0.0?include_deleted=true');
});

test('lookup does not retry a 404', async () => {
  let n = 0;
  const r = await lookup(local, { fetch: async () => { n++; return { status: 404 }; }, wait: 0 });
  assert.deepEqual([r.status, n], [404, 1]);
});

// A 200 whose body never finishes: it only ends when the request's signal aborts.
const stalled = (signal) => ({
  status: 200,
  json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
});

test('lookup retries 429 and a body that never finishes, then reports a timeout', async () => {
  // AbortSignal.timeout() uses an unref'ed timer: keep the event loop alive with a referenced
  // watchdog, which also fails the test if the deadline never ends the body.
  let watchdog;
  const deadline = new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('the request deadline never fired')), 5000); });
  let n = 0;
  let r;
  try {
    r = await Promise.race([
      lookup(local, { fetch: async (url, { signal }) => (++n === 1 ? { status: 429 } : stalled(signal)), wait: 0, timeout: 20 }),
      deadline,
    ]);
  } finally {
    clearTimeout(watchdog);
  }
  assert.equal(n, 3);
  assert.equal(r.error, 'timeout');
  assert.match(decide(r.status, r.body, local, r.error).message, /timed out/);
});

test('lookup reports a 200 with invalid JSON as such, not as a connection failure', async () => {
  const r = await lookup(local, { fetch: async () => ({ status: 200, json: async () => JSON.parse('<html>') }), wait: 0 });
  assert.deepEqual([r.status, r.error], [200, 'invalid-json']);
  const d = decide(r.status, r.body, local, r.error);
  assert.equal(d.action, 'stop');
  assert.match(d.message, /HTTP 200 with a body that is not valid JSON/);
});

test('lookup reports a body that breaks after HTTP 200 as a body failure, not a connection failure', async () => {
  const r = await lookup(local, { fetch: async () => ({ status: 200, json: async () => { throw new TypeError('terminated'); } }), wait: 0 });
  assert.deepEqual([r.status, r.error], [200, 'body']);
  assert.match(decide(r.status, r.body, local, r.error).message, /HTTP 200 but the body could not be read/);
});

test('lookup reports a refused connection as a network error', async () => {
  const r = await lookup(local, { fetch: async () => { throw new TypeError('fetch failed'); }, wait: 0 });
  assert.equal(r.error, 'network');
  assert.match(decide(r.status, r.body, local, r.error).message, /could not connect/);
});

test('lookup does not retry 401', async () => {
  let n = 0;
  const r = await lookup(local, { fetch: async () => { n++; return { status: 401 }; }, wait: 0 });
  assert.deepEqual([r.status, n, decide(r.status, r.body, local).action], [401, 1, 'stop']);
});

const withInput = (input) => {
  const s = structuredClone(local);
  Object.assign(s.packages[0].environmentVariables[0], input);
  return s;
};

test('an empty-string choice is kept: adding one is a difference', () => {
  assert.equal(sameInstall(withInput({ choices: ['auto'] }), withInput({ choices: ['auto', ''] })).same, false);
  assert.equal(sameInstall(withInput({ choices: [] }), local).same, true, 'an empty list is omitted by the registry');
});

test('for an environment variable, value: "" equals no value (Input.Value is omitempty)', () => {
  assert.equal(sameInstall(withInput({}), withInput({ value: '' })).same, true);
  assert.equal(sameInstall(withInput({}), withInput({ value: 'x' })).same, false);
});

test('a variables entry named __proto__ is compared like any other key', () => {
  const remote = (variables) => ({ ...local, remotes: [{ type: 'streamable-http', url: 'https://{__proto__}.x', variables }] });
  assert.equal(sameInstall(remote(undefined), remote(JSON.parse('{"__proto__": {}}'))).same, false);
  assert.equal(sameInstall(remote(JSON.parse('{"__proto__": {}}')), remote(JSON.parse('{"__proto__": {}}'))).same, true);
});

const withArgument = (arg) => {
  const s = structuredClone(local);
  s.packages[0].packageArguments = [{ type: 'positional', ...arg }];
  return s;
};

test('for an argument, an explicit empty value or valueHint differs from omitted (argument.go keeps them)', () => {
  assert.equal(sameInstall(withArgument({ valueHint: 'file' }), withArgument({ valueHint: 'file', value: '' })).same, false);
  assert.equal(sameInstall(withArgument({ value: 'x' }), withArgument({ value: 'x', valueHint: '' })).same, false);
  assert.equal(sameInstall(withArgument({ value: '' }), withArgument({ value: '' })).same, true);
  assert.equal(sameInstall(withArgument({ value: 'x', isRepeated: false }), withArgument({ value: 'x' })).same, true);
});

test('a variable named "variables" is an input like any other', () => {
  const remote = (value) => ({ ...local, remotes: [{ type: 'streamable-http', url: 'https://{variables}.x', variables: { variables: { value } } }] });
  assert.equal(sameInstall(remote('us'), remote('eu')).same, false);
  assert.equal(sameInstall(remote('us'), remote('us')).same, true);
  assert.deepEqual(plain(normalize(remote('us').remotes)), [{ type: 'streamable-http', url: 'https://{variables}.x', variables: { variables: { value: 'us' } } }]);
});
