// Run with: node --experimental-vm-modules --test test/account.test.js
// VM modules isolate ESM dependencies without changing production code or requiring Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { z } from 'zod';

const CONNECT_URL = 'https://connect.raspberrypi.com';
const plain = (value) => JSON.parse(JSON.stringify(value));

async function load(file, dependencies, globals = {}) {
  const context = vm.createContext({ URL, console, ...globals });
  const module = new vm.SourceTextModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { context });
  await module.link((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    const exports = dependencies[name];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

function clock() {
  let now = 0;
  const timers = new Map();
  let id = 0;
  class DateMock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  return {
    globals: {
      Date: DateMock,
      setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; },
      clearTimeout(key) { timers.delete(key); },
    },
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
      await flush();
    },
  };
}

async function authFixture(t, options = {}) {
  const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'rpi-auth-test-'));
  t.after(() => fs.rmSync(BASE, { recursive: true, force: true }));
  const SESSION_FILE = path.join(BASE, 'session.json');
  const PROFILE_DIR = path.join(BASE, 'profile');
  const time = clock();
  const chrome = new EventEmitter();
  Object.assign(chrome, { stderr: new EventEmitter(), exitCode: null, signalCode: null });
  const kills = [];
  chrome.kill = (signal = 'SIGTERM') => {
    kills.push(signal);
    if (!options.ignoreTerm || signal === 'SIGKILL') {
      chrome.signalCode = signal;
      chrome.emit('exit');
    }
  };
  let spawns = 0;
  let closes = 0;
  let attachments = 0;
  const cookies = options.cookies ?? [
    { name: '_connect_session', domain: 'connect.raspberrypi.com' },
    { name: '_identity_session', domain: 'id.raspberrypi.com' },
    { name: 'unrelated', domain: 'example.com' },
  ];
  const auth = await load('src/auth.js', {
    'node:fs': { default: fs }, 'node:path': { default: path },
    'node:child_process': { spawn: (...args) => { spawns++; options.onSpawn?.(...args); return chrome; } },
    'playwright-core': { chromium: { async connectOverCDP() {
      attachments++;
      if (options.cdpError) throw new Error('CDP unavailable');
      return { contexts: () => [{ cookies: async () => cookies }], close: async () => { closes++; } };
    } } },
    './browser.js': { BASE, PROFILE_DIR, SESSION_FILE, CONNECT_URL, chromePath: () => '/fake/chrome' },
  }, {
    ...time.globals,
    process: { platform: 'linux', env: options.env ?? { DISPLAY: ':test' } },
    fetch: options.fetch ?? (async () => ({ json: async () => options.tabs ?? [{ type: 'page', url: `${CONNECT_URL}/devices` }] })),
  });
  return { auth, BASE, SESSION_FILE, PROFILE_DIR, chrome, time, kills,
    get spawns() { return spawns; }, get closes() { return closes; }, get attachments() { return attachments; } };
}

test('savedSession handles absent, malformed, missing-date and valid session files', async (t) => {
  const f = await authFixture(t);
  assert.equal(f.auth.savedSession(), null);
  for (const content of ['{', '{}', '{"savedAt":"2026-01-01T00:00:00Z"}']) {
    fs.writeFileSync(f.SESSION_FILE, content);
    assert.equal(f.auth.savedSession().savedAt, content.includes('2026') ? '2026-01-01T00:00:00Z' : null);
  }
});

for (const env of [{}, { DISPLAY: ':0' }, { WAYLAND_DISPLAY: 'wayland-0' }]) {
  test(`display guard: ${JSON.stringify(env)}`, async (t) => {
    const f = await authFixture(t, { env });
    if (Object.keys(env).length) assert.doesNotThrow(() => f.auth.checkDisplay());
    else {
      assert.throws(() => f.auth.startLogin(), /No display.*DISPLAY\/WAYLAND_DISPLAY/);
      assert.equal(f.spawns, 0);
      assert.equal(fs.existsSync(f.PROFILE_DIR), false);
    }
  });
}

test('successful login saves only provider cookies privately, shares pending work and calls onSaved once', async (t) => {
  const f = await authFixture(t, { onSpawn(binary, args, options) {
    assert.equal(binary, '/fake/chrome');
    assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
    assert.deepEqual(plain(options.stdio), ['ignore', 'ignore', 'pipe']);
  } });
  let saved = 0;
  const first = f.auth.startLogin({ onSaved: () => saved++ });
  const second = f.auth.startLogin({ onSaved: () => assert.fail('duplicate callback') });
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(first.promise, second.promise);
  assert.equal(first.startedAt, second.startedAt);
  assert.equal(f.auth.loginState().loginInProgress, true);
  await f.time.tick(5000);
  assert.equal((await first.promise).ok, true);
  const session = JSON.parse(fs.readFileSync(f.SESSION_FILE, 'utf8'));
  assert.deepEqual(session.cookies.map((c) => c.name), ['_connect_session', '_identity_session']);
  assert.equal(session.savedAt, new Date(5000).toISOString());
  assert.equal(fs.statSync(f.SESSION_FILE).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.PROFILE_DIR).mode & 0o777, 0o700);
  assert.equal(saved, 1);
  assert.equal(f.spawns, 1);
  assert.equal(f.closes, 1);
  assert.equal(f.auth.loginState().loginInProgress, false);
  assert.equal(f.auth.loginState().lastLogin.ok, true);
});

for (const cookies of [
  [{ name: '_connect_session', domain: 'connect.raspberrypi.com' }],
  [{ name: '_identity_session', domain: 'id.raspberrypi.com' }],
  [{ name: '_connect_session', domain: 'connect.raspberrypi.com' }, { name: 'session_id', domain: 'connect.raspberrypi.com' }],
]) {
  test(`does not save incomplete authentication: ${cookies.map((c) => c.name + '@' + c.domain).join(', ')}`, async (t) => {
    const f = await authFixture(t, { cookies });
    const login = f.auth.startLogin();
    await f.time.tick(5000);
    assert.equal(fs.existsSync(f.SESSION_FILE), false);
    assert.equal(f.closes, 1);
    f.chrome.kill();
    await f.time.tick(5000);
    assert.equal((await login.promise).ok, false);
  });
}

test('accepts the alternate Raspberry Pi ID session_id cookie', async (t) => {
  const f = await authFixture(t, { cookies: [
    { name: '_connect_session', domain: 'connect.raspberrypi.com' },
    { name: 'session_id', domain: 'id.raspberrypi.com' },
  ] });
  const login = f.auth.startLogin();
  await f.time.tick(5000);
  assert.equal((await login.promise).ok, true);
});

for (const tab of [
  { type: 'page', url: `${CONNECT_URL}/` },
  { type: 'page', url: `${CONNECT_URL}/sign-in` },
  { type: 'page', url: 'https://example.com/devices' },
  { type: 'service_worker', url: `${CONNECT_URL}/devices` },
]) {
  test(`ignores unauthenticated or unrelated tab ${tab.type} ${tab.url}`, async (t) => {
    const f = await authFixture(t, { tabs: [tab] });
    const login = f.auth.startLogin();
    await f.time.tick(2000);
    assert.equal(f.attachments, 0);
    f.chrome.kill();
    await f.time.tick(2000);
    assert.equal((await login.promise).ok, false);
    assert.equal(fs.existsSync(f.SESSION_FILE), false);
  });
}

test('retries a temporarily unavailable debug endpoint', async (t) => {
  let requests = 0;
  const f = await authFixture(t, { fetch: async () => {
    if (++requests === 1) throw new Error('not ready');
    return { json: async () => [{ type: 'page', url: `${CONNECT_URL}/devices` }] };
  } });
  const login = f.auth.startLogin();
  await f.time.tick(7000);
  assert.equal((await login.promise).ok, true);
  assert.equal(requests, 2);
});

test('early Chrome exit reports only the last five stderr lines and clears pending login', async (t) => {
  const f = await authFixture(t, { tabs: [] });
  const login = f.auth.startLogin();
  f.chrome.stderr.emit('data', 'hidden\na\nb\nc\nd\ne');
  f.chrome.exitCode = 1;
  f.chrome.emit('exit');
  await f.time.tick(2000);
  const result = await login.promise;
  assert.equal(result.ok, false);
  assert.match(result.message, /code 1/);
  assert.match(result.message, /Chrome output:\na\nb\nc\nd\ne$/);
  assert.doesNotMatch(result.message, /hidden/);
  assert.equal(f.auth.loginState().loginInProgress, false);
});

test('timeout kills Chrome and leaves no saved session', async (t) => {
  const f = await authFixture(t, { tabs: [] });
  const login = f.auth.startLogin();
  await f.time.tick(600_000);
  assert.match((await login.promise).message, /Timed out after 10 minutes/);
  assert.deepEqual(f.kills, ['SIGTERM']);
  assert.equal(fs.existsSync(f.SESSION_FILE), false);
});

test('CDP failure becomes a failed login result', async (t) => {
  const f = await authFixture(t, { cdpError: true });
  const login = f.auth.startLogin();
  await f.time.tick(5000);
  assert.deepEqual(plain(await login.promise), { ok: false, message: 'CDP unavailable' });
  assert.equal(f.auth.loginState().lastLogin.ok, false);
  assert.equal(f.auth.loginState().loginInProgress, false);
  f.chrome.kill();
});

for (const del of [false, true]) {
  test(`logout ${del ? 'deletes' : 'backs up'} session and nested Chrome profile`, async (t) => {
    const f = await authFixture(t);
    fs.writeFileSync(f.SESSION_FILE, '{"cookies":[]}');
    fs.mkdirSync(f.PROFILE_DIR);
    fs.writeFileSync(path.join(f.PROFILE_DIR, 'Preferences'), 'profile contents');
    const result = await f.auth.logout({ del });
    assert.equal(result.signedOut, true);
    assert.equal(fs.existsSync(f.SESSION_FILE), false);
    assert.equal(fs.existsSync(f.PROFILE_DIR), false);
    if (del) assert.deepEqual(plain(result.deleted), [f.SESSION_FILE, f.PROFILE_DIR]);
    else {
      assert.match(path.basename(result.backup), /^old-account_\d{8}_\d{6}$/);
      assert.equal(fs.readFileSync(path.join(result.backup, 'session.json'), 'utf8'), '{"cookies":[]}');
      assert.equal(fs.readFileSync(path.join(result.backup, 'profile', 'Preferences'), 'utf8'), 'profile contents');
      assert.equal(fs.statSync(result.backup).mode & 0o777, 0o700);
      assert.ok(result.restore.includes(result.backup));
    }
    assert.match((await f.auth.logout()).message, /Was not signed in/);
  });
}

test('logout waits for pending login and allows a new login afterwards', async (t) => {
  const f = await authFixture(t, { tabs: [], ignoreTerm: true });
  const first = f.auth.startLogin();
  let finished = false;
  const signingOut = f.auth.logout({ del: true }).then(() => { finished = true; });
  await f.time.tick(4000);
  assert.equal(finished, false);
  assert.equal(fs.existsSync(f.PROFILE_DIR), true);
  await f.time.tick(4000);
  await signingOut;
  assert.equal((await first.promise).ok, false);
  assert.ok(f.kills.includes('SIGKILL'));
  assert.equal(f.auth.loginState().loginInProgress, false);
  assert.equal(f.auth.startLogin().started, true);
  f.chrome.emit('exit');
  await f.time.tick(2000);
});

async function connectFixture() {
  let stamp = 1;
  const contexts = [];
  const { Connect } = await load('src/connect.js', {
    'node:fs': { default: { statSync() { if (stamp === null) throw new Error('ENOENT'); return { mtimeMs: stamp }; } } },
    './browser.js': { CONNECT_URL, SESSION_FILE: '/fake/session', launch: async () => {
      if (stamp === null) throw new Error('Not signed in. Use the login tool');
      const ctx = new EventEmitter();
      ctx.closed = 0;
      ctx.close = async () => { ctx.closed++; ctx.emit('close'); };
      contexts.push(ctx);
      return ctx;
    } },
  }, { process: { env: {} } });
  return { connect: new Connect(), contexts, setStamp(value) { stamp = value; } };
}

test('context reuses unchanged session, then clears browser, shells and devices on account change', async () => {
  const f = await connectFixture();
  const old = await f.connect.context();
  assert.equal(await f.connect.context(), old);
  f.connect.sessions.set('old', {});
  f.connect.devicesCache = [{ name: 'old' }];
  f.setStamp(2);
  assert.notEqual(await f.connect.context(), old);
  assert.equal(old.closed, 1);
  assert.equal(f.contexts.length, 2);
  assert.equal(f.connect.sessions.size, 0);
  assert.equal(f.connect.devicesCache, null);
});

test('session deletion invalidates existing context before reporting sign-in required', async () => {
  const f = await connectFixture();
  const old = await f.connect.context();
  f.setStamp(null);
  await assert.rejects(f.connect.context(), /login tool/);
  assert.equal(old.closed, 1);
  assert.equal(f.connect.ctx, null);
});

test('reset is safe without a context and tolerates browser-close failure', async () => {
  const { connect } = await connectFixture();
  await connect.reset();
  connect.ctx = { close: async () => { throw new Error('already closed'); } };
  connect.sessions.set('device', {});
  connect.devicesCache = [{}];
  await connect.reset();
  assert.equal(connect.ctx, null);
  assert.equal(connect.sessions.size, 0);
  assert.equal(connect.devicesCache, null);
});

test('resolve discards cached devices after session change even before opening a browser', async () => {
  const f = await connectFixture();
  f.connect.stamp = 1;
  const old = { id: 'old', name: 'shared-name' };
  const current = { id: 'new', name: 'shared-name' };
  f.connect.devicesCache = [old];
  let lists = 0;
  f.connect.listDevices = async () => { lists++; return [current]; };
  assert.equal(await f.connect.resolve('shared-name'), old);
  assert.equal(lists, 0);
  f.setStamp(2);
  assert.equal(await f.connect.resolve('shared-name'), current);
  assert.equal(lists, 1);
});

for (const scenario of ['connect-email', 'id-email', 'no-email', 'expired', 'navigation-error', 'fallback-error']) {
  test(`accountEmail: ${scenario}, always closes the temporary page`, async () => {
    const { connect } = await connectFixture();
    const visits = [];
    let closed = 0;
    const page = {
      async goto(url) {
        visits.push(url);
        if (scenario === 'navigation-error' || (scenario === 'fallback-error' && visits.length === 2)) throw new Error('navigation failed');
      },
      url: () => scenario === 'expired' ? `${CONNECT_URL}/sign-in` : visits.at(-1),
      async evaluate(fn) {
        const innerText = scenario === 'connect-email' ? 'Account: pi+lab@example.com'
          : scenario === 'id-email' && visits.length === 2 ? 'pi@example.org' : 'No account email';
        // Execute the actual browser callback against a minimal DOM.
        return vm.runInNewContext(`(${fn.toString()})()`, { document: { body: { innerText } } });
      },
      async close() { closed++; },
    };
    connect.context = async () => ({ newPage: async () => page });
    if (scenario === 'expired') await assert.rejects(connect.accountEmail(), /session expired.*login tool/);
    else if (scenario === 'navigation-error') await assert.rejects(connect.accountEmail(), /navigation failed/);
    else assert.equal(await connect.accountEmail(), scenario === 'connect-email' ? 'pi+lab@example.com' : scenario === 'id-email' ? 'pi@example.org' : null);
    assert.equal(closed, 1);
    assert.equal(visits.length, ['id-email', 'no-email', 'fallback-error'].includes(scenario) ? 2 : 1);
  });
}

async function serverFixture(overrides = {}) {
  const tools = new Map();
  const calls = [];
  const time = clock();
  let savedCallback;
  const auth = {
    savedSession: () => null,
    loginState: () => ({ loginInProgress: false, loginStartedAt: null, lastLogin: null }),
    checkDisplay: () => { calls.push('display'); },
    logout: async (args) => { calls.push(['logout', args]); return { signedOut: true }; },
    startLogin: ({ onSaved }) => {
      calls.push('login'); savedCallback = onSaved;
      return { started: true, promise: Promise.resolve({ ok: true, message: 'signed in' }) };
    },
    ...overrides,
  };
  const connect = {
    reset: async () => { calls.push('reset'); },
    accountEmail: async () => 'pi@example.com',
    listDevices: async () => [{ id: 'one', name: 'lab' }, { id: 'two', name: 'kiosk' }],
  };
  await load('src/server.js', {
    '@modelcontextprotocol/sdk/server/mcp.js': { McpServer: class {
      tool(name, description, schema, handler) { tools.set(name, { schema: z.object(schema), handler }); }
      async connect() {}
    } },
    '@modelcontextprotocol/sdk/server/stdio.js': { StdioServerTransport: class {} },
    zod: { z },
    './connect.js': { Connect: class { constructor() { return connect; } } },
    './auth.js': auth,
  }, { ...time.globals, process: { on() {}, stdin: { on() {} } } });
  return { tools, calls, connect, time, onSaved: () => savedCallback(),
    async call(name, args = {}) {
      const tool = tools.get(name);
      const result = await tool.handler(tool.schema.parse(args));
      if (result.isError) return result;
      return JSON.parse(result.content[0].text);
    } };
}

test('account without saved session reports login state without querying Connect', async () => {
  const state = { loginInProgress: true, loginStartedAt: 'start', lastLogin: null };
  const f = await serverFixture({ loginState: () => state });
  f.connect.accountEmail = f.connect.listDevices = () => assert.fail('must not open browser');
  assert.deepEqual(await f.call('account'), { signedIn: false, savedAt: null, ...state });
});

test('account reports saved date, email and device names; expired sessions report the error', async () => {
  const f = await serverFixture({ savedSession: () => ({ savedAt: 'saved-date' }) });
  const account = await f.call('account');
  assert.equal(account.signedIn, true);
  assert.equal(account.savedAt, 'saved-date');
  assert.equal(account.email, 'pi@example.com');
  assert.deepEqual(account.devices, ['lab', 'kiosk']);
  f.connect.accountEmail = async () => { throw new Error('session expired'); };
  const expired = await f.call('account');
  assert.equal(expired.signedIn, false);
  assert.equal(expired.error, 'session expired');
});

test('fresh login validates display before resetting or logging out the current account', async () => {
  const f = await serverFixture({ checkDisplay() { throw new Error('No display'); } });
  const result = await f.call('login', { fresh: true, wait_sec: 0 });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Error: No display');
  assert.deepEqual(f.calls, []);
});

test('fresh login resets, backs up account, starts login and refreshes after saving', async () => {
  const f = await serverFixture();
  const result = await f.call('login', { fresh: true, wait_sec: 0 });
  assert.deepEqual(f.calls.slice(0, 2), ['display', 'reset']);
  assert.equal(f.calls[2][0], 'logout');
  assert.equal(f.calls[3], 'login');
  assert.equal(result.logout.signedOut, true);
  assert.equal(result.result.ok, true);
  await f.onSaved();
  assert.equal(f.calls.at(-1), 'reset');
});

test('pending login returns promptly at wait_sec=0 and reports an existing login', async () => {
  const f = await serverFixture({ startLogin: () => ({ started: false, promise: new Promise(() => {}) }) });
  const request = f.call('login', { wait_sec: 0 });
  await f.time.tick(0);
  const result = await request;
  assert.equal(result.status, 'login already in progress');
  assert.equal(result.result.ok, null);
  assert.match(result.result.message, /Still waiting after 0s; call account/);
});

test('login exposes failure results without converting them into transport errors', async () => {
  const f = await serverFixture({ startLogin: () => ({ started: true, promise: Promise.resolve({ ok: false, message: 'Chrome closed' }) }) });
  const result = await f.call('login', { wait_sec: 0 });
  assert.deepEqual(result.result, { ok: false, message: 'Chrome closed' });
});

for (const del of [false, true]) {
  test(`logout tool resets Connect before forwarding delete=${del}`, async () => {
    const f = await serverFixture();
    assert.deepEqual(await f.call('logout', del ? { delete: true } : {}), { signedOut: true });
    assert.deepEqual(plain(f.calls), ['reset', ['logout', { del }]]);
  });
}

test('new tool schemas enforce defaults, types, and login wait boundaries', async () => {
  const f = await serverFixture();
  const login = f.tools.get('login').schema;
  assert.deepEqual(login.parse({}), { fresh: false, wait_sec: 180 });
  for (const wait_sec of [0, 600]) assert.equal(login.parse({ wait_sec }).wait_sec, wait_sec);
  for (const wait_sec of [-1, 601, 0.5, '180', null]) assert.equal(login.safeParse({ wait_sec }).success, false);
  assert.equal(login.safeParse({ fresh: 'true' }).success, false);
  assert.deepEqual(f.tools.get('logout').schema.parse({}), { delete: false });
  assert.equal(f.tools.get('logout').schema.safeParse({ delete: 'true' }).success, false);
});

for (const fresh of [false, true]) {
  for (const ok of [false, true]) {
    test(`CLI wrapper: fresh=${fresh}, login succeeds=${ok}`, async () => {
      const calls = [];
      await load('scripts/login.js', { '../src/auth.js': {
        logout: async () => { calls.push('logout'); return { signedOut: true }; },
        startLogin: () => { calls.push('login'); return { promise: Promise.resolve({ ok, message: 'login result' }) }; },
      } }, {
        console: { log: (message) => calls.push(message) },
        process: { argv: ['node', 'login.js', ...(fresh ? ['--fresh'] : [])], exit: (code) => calls.push(['exit', code]) },
      });
      if (fresh) assert.equal(calls[0], 'logout');
      else assert.equal(calls.includes('logout'), false);
      assert.ok(calls.includes('login result'));
      assert.ok(calls.indexOf('login') < calls.indexOf('login result'));
      assert.deepEqual(calls.at(-1), ['exit', ok ? 0 : 1]);
    });
  }
}

test('browser launch without a saved session points callers to the login tool before starting Chrome', async () => {
  const { launch, BASE } = await load('src/browser.js', {
    'node:fs': { default: { existsSync: () => false } },
    'node:os': { default: { homedir: () => '/fake/home' } },
    'node:path': { default: path },
    'playwright-core': { chromium: { launch: () => assert.fail('Chrome must not start') } },
  }, { process: { env: {} } });
  assert.equal(BASE, '/fake/home/.config/rpi-connect-mcp');
  await assert.rejects(launch(), /Not signed in\. Use the login tool/);
});
