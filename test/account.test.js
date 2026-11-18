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
    get timers() { return timers.size; },
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
  const CHROME = path.join(BASE, 'chrome'); // checkCanLogin() requires an executable file
  if (!options.noChrome) fs.writeFileSync(CHROME, '#!/bin/sh\n', { mode: 0o755 });
  const time = clock();
  const chrome = new EventEmitter();
  // fd 3: commands from us (NUL-terminated JSON); fd 4: Chrome's replies.
  const toChrome = new EventEmitter();
  const fromChrome = new EventEmitter();
  const requests = [];
  const cookies = options.cookies ?? [
    { name: '_connect_session', value: 'c', domain: 'connect.raspberrypi.com', path: '/', expires: -1, size: 17, session: true, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: '_identity_session', value: 'i', domain: 'id.raspberrypi.com', path: '/', expires: -1, size: 18, session: true, httpOnly: true, secure: true },
    { name: 'unrelated', value: 'u', domain: 'example.com', path: '/' },
  ];
  toChrome.write = (data) => {
    for (const raw of String(data).split('\0').filter(Boolean)) {
      const { id, method } = JSON.parse(raw);
      requests.push(method);
      const reply = (msg) => queueMicrotask(() => fromChrome.emit('data', JSON.stringify({ id, ...msg }) + '\0'));
      const answer = options.answer?.(method, requests.filter((m) => m === method).length);
      if (answer === 'silent') continue;
      if (answer) reply(answer);
      else if (method === 'Target.getTargets') reply({ result: { targetInfos: options.tabs ?? [{ type: 'page', url: `${CONNECT_URL}/devices` }] } });
      else if (method === 'Storage.getCookies') reply(options.cdpError ? { error: { message: 'CDP unavailable' } } : { result: { cookies } });
    }
    return true;
  };
  Object.assign(chrome, {
    pid: 4242, stderr: new EventEmitter(), stdio: [null, null, null, toChrome, fromChrome], exitCode: null, signalCode: null,
  });
  const exit = (signal) => { chrome.signalCode = signal; chrome.emit('exit'); };
  const kills = [];
  chrome.kill = (signal = 'SIGTERM') => {
    kills.push(signal);
    if (signal === 'SIGKILL') {
      if (options.ignoreKill) return;
      if (options.killDelay) setTimeout(() => exit(signal), options.killDelay); // the exit event comes later
      else exit(signal);
    } else if (!options.ignoreTerm) exit(signal);
  };
  let spawns = 0;
  const fsMock = options.fs ? options.fs(fs) : fs;
  const auth = await load('src/auth.js', {
    'node:fs': { default: fsMock }, 'node:path': { default: path },
    'node:child_process': { spawn: (...args) => { spawns++; options.onSpawn?.(...args); return chrome; } },
    './browser.js': { BASE, PROFILE_DIR, SESSION_FILE, CONNECT_URL, chromePath: () => CHROME },
  }, {
    ...time.globals,
    queueMicrotask,
    process: { platform: 'linux', env: options.env ?? { DISPLAY: ':test' } },
  });
  return { auth, BASE, SESSION_FILE, PROFILE_DIR, CHROME, chrome, time, kills, requests, exit,
    get spawns() { return spawns; }, get attachments() { return requests.filter((m) => m === 'Storage.getCookies').length; } };
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
  let spawned;
  const f = await authFixture(t, { onSpawn(binary, args, options) { spawned = { binary, args, stdio: plain(options.stdio) }; } });
  let saved = 0;
  const first = f.auth.startLogin({ onSaved: () => saved++ });
  const second = f.auth.startLogin({ onSaved: () => assert.fail('duplicate callback') });
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(first.promise, second.promise);
  assert.equal(first.startedAt, second.startedAt);
  assert.equal(f.auth.loginState().loginInProgress, true);
  // No TCP debug port: other local accounts cannot attach. Commands go over fds 3/4 instead.
  assert.equal(spawned.binary, f.CHROME);
  assert.ok(spawned.args.includes('--remote-debugging-pipe'));
  assert.ok(!spawned.args.some((a) => a.startsWith('--remote-debugging-port') || a.startsWith('--remote-debugging-address')));
  assert.deepEqual(spawned.stdio, ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']);
  await f.time.tick(5000);
  assert.equal((await first.promise).ok, true);
  const session = JSON.parse(fs.readFileSync(f.SESSION_FILE, 'utf8'));
  assert.deepEqual(session.cookies.map((c) => c.name), ['_connect_session', '_identity_session']);
  // Saved in the shape Playwright's addCookies() takes: no CDP-only fields such as size or session.
  assert.deepEqual(session.cookies[0], { name: '_connect_session', value: 'c', domain: 'connect.raspberrypi.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' });
  assert.deepEqual(fs.readdirSync(f.BASE).filter((n) => n.endsWith('.tmp')), []);
  assert.equal(session.savedAt, new Date(5000).toISOString());
  assert.equal(fs.statSync(f.SESSION_FILE).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.PROFILE_DIR).mode & 0o777, 0o700);
  assert.equal(saved, 1);
  assert.equal(f.spawns, 1);
  assert.deepEqual(f.kills, ['SIGTERM']);
  assert.equal(f.auth.loginState().loginInProgress, false);
  assert.equal(f.auth.loginState().lastLogin.ok, true);
});

for (const cookies of [
  [{ name: '_connect_session', domain: 'connect.raspberrypi.com' }],
  [{ name: '_identity_session', domain: 'id.raspberrypi.com' }],
  [{ name: '_connect_session', domain: 'connect.raspberrypi.com' }, { name: 'session_id', domain: 'connect.raspberrypi.com' }],
  // Lookalike domains must not satisfy either requirement.
  [{ name: '_connect_session', domain: 'connect.raspberrypi.com' }, { name: '_identity_session', domain: 'id.raspberrypi.com.evil.example' }],
  [{ name: '_connect_session', domain: 'notraspberrypi.com' }, { name: '_identity_session', domain: 'id.raspberrypi.com' }],
  [{ name: '_connect_session', domain: 'raspberrypi.com' }, { name: '_identity_session', domain: 'id.raspberrypi.com' }],
]) {
  test(`does not save incomplete authentication: ${cookies.map((c) => c.name + '@' + c.domain).join(', ')}`, async (t) => {
    const f = await authFixture(t, { cookies });
    const login = f.auth.startLogin();
    await f.time.tick(5000);
    assert.equal(fs.existsSync(f.SESSION_FILE), false);
    assert.equal(f.attachments, 1);
    f.chrome.kill();
    await f.time.tick(5000);
    assert.equal((await login.promise).ok, false);
  });
}

test('accepts the alternate Raspberry Pi ID session_id cookie', async (t) => {
  const f = await authFixture(t, { cookies: [
    { name: '_connect_session', domain: 'connect.raspberrypi.com' },
    { name: 'session_id', domain: '.id.raspberrypi.com' }, // leading dot: domain cookie
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
  { type: 'page', url: 'https://connect.raspberrypi.com.evil.example/devices' },
  { type: 'page', url: `${CONNECT_URL}/devices-old` },
  { type: 'page', url: `${CONNECT_URL}/devices/some-device-id` },
  { type: 'page', url: 'http://connect.raspberrypi.com/devices' },
  { type: 'page', url: 'not a url' },
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

for (const url of [`${CONNECT_URL}/devices/`, `${CONNECT_URL}/devices?page=2`]) {
  test(`accepts the device list ${url}`, async (t) => {
    const f = await authFixture(t, { tabs: [{ type: 'page', url }] });
    const login = f.auth.startLogin();
    await f.time.tick(5000);
    assert.equal((await login.promise).ok, true);
  });
}

test('retries when Chrome does not answer the tab list yet', async (t) => {
  const f = await authFixture(t, { answer: (method, n) => (method === 'Target.getTargets' && n === 1 ? { error: { message: 'not ready' } } : null) });
  const login = f.auth.startLogin();
  await f.time.tick(7000);
  assert.equal((await login.promise).ok, true);
  assert.equal(f.requests.filter((m) => m === 'Target.getTargets').length, 2);
});

test('a silent Chrome times out per command, and the login deadline still applies', async (t) => {
  const f = await authFixture(t, { answer: () => 'silent' });
  const login = f.auth.startLogin();
  await f.time.tick(600_000);
  assert.match((await login.promise).message, /Timed out after 10 minutes/);
  assert.equal(fs.existsSync(f.SESSION_FILE), false);
});

test('cookies are not saved when the deadline passes while reading them', async (t) => {
  // The device list shows just before the deadline; the 3 s cookie wait would end after it.
  const f = await authFixture(t, { answer: (method, n) => (method === 'Target.getTargets' && n < 299 ? { result: { targetInfos: [] } } : null) });
  const login = f.auth.startLogin();
  await f.time.tick(600_000);
  assert.equal(f.requests.filter((m) => m === 'Target.getTargets').length, 299); // at 598 s
  assert.equal(f.attachments, 0);
  assert.match((await login.promise).message, /Timed out after 10 minutes/);
  assert.equal(fs.existsSync(f.SESSION_FILE), false);
});

test('a new session atomically replaces an old one and gets mode 600', async (t) => {
  const f = await authFixture(t);
  fs.writeFileSync(f.SESSION_FILE, '{"savedAt":"old","cookies":[]}', { mode: 0o644 });
  fs.chmodSync(f.SESSION_FILE, 0o644);
  const login = f.auth.startLogin();
  await f.time.tick(5000);
  assert.equal((await login.promise).ok, true);
  assert.notEqual(JSON.parse(fs.readFileSync(f.SESSION_FILE, 'utf8')).savedAt, 'old');
  assert.equal(fs.statSync(f.SESSION_FILE).mode & 0o777, 0o600);
});

test('a failed session write keeps the old session and leaves no temporary file', async (t) => {
  const f = await authFixture(t, { fs: (real) => ({ ...real, constants: real.constants, renameSync(from, to) {
    if (String(from).endsWith('.tmp')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return real.renameSync(from, to);
  } }) });
  fs.writeFileSync(f.SESSION_FILE, '{"savedAt":"old","cookies":[]}');
  const login = f.auth.startLogin();
  await f.time.tick(5000);
  assert.deepEqual(plain(await login.promise), { ok: false, message: 'disk full' });
  assert.equal(JSON.parse(fs.readFileSync(f.SESSION_FILE, 'utf8')).savedAt, 'old');
  assert.deepEqual(fs.readdirSync(f.BASE).filter((n) => n.endsWith('.tmp')), []);
});

for (const [setup, pattern] of [
  [(f) => fs.rmSync(f.CHROME), /Chrome not found at .*chrome\. Install it/],
  [(f) => fs.chmodSync(f.CHROME, 0o644), /Chrome at .*chrome is not executable \(EACCES\)/],
]) {
  test(`login refuses before spawning when Chrome is unusable: ${pattern}`, async (t) => {
    const f = await authFixture(t);
    setup(f);
    assert.throws(() => f.auth.checkCanLogin(), pattern);
    assert.throws(() => f.auth.startLogin(), pattern);
    assert.equal(f.spawns, 0);
  });
}

test('a Chrome startup error is reported, not mistaken for an early exit', async (t) => {
  const f = await authFixture(t);
  const login = f.auth.startLogin();
  f.chrome.pid = undefined; // spawn failed: the process never started
  f.chrome.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
  await f.time.tick(2000);
  assert.match((await login.promise).message, /is not executable \(EACCES\)/);
  assert.deepEqual(f.kills, []);
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
  assert.deepEqual(plain(await login.promise), { ok: false, message: 'Storage.getCookies: CDP unavailable' });
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
      assert.equal(result.restore, `After signing out of the current account: mv '${path.join(result.backup, 'session.json')}' '${f.SESSION_FILE}' && mv '${path.join(result.backup, 'profile')}' '${f.PROFILE_DIR}'`);
    }
    assert.match((await f.auth.logout()).message, /Was not signed in/);
  });
}

test('logout waits for pending login and allows a new login afterwards', async (t) => {
  const f = await authFixture(t, { tabs: [], ignoreTerm: true, killDelay: 2000 });
  const first = f.auth.startLogin();
  let finished = false;
  const signingOut = f.auth.logout({ del: true }).then(() => { finished = true; });
  await f.time.tick(4000);
  assert.equal(finished, false);
  assert.equal(fs.existsSync(f.PROFILE_DIR), true);
  await f.time.tick(1500); // SIGKILL sent at 5 s; Chrome has not exited yet
  assert.deepEqual(f.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(finished, false);
  assert.equal(f.auth.loginState().loginInProgress, true);
  assert.equal(fs.existsSync(f.PROFILE_DIR), true);
  await f.time.tick(1000); // exit at 7 s
  await signingOut;
  assert.equal((await first.promise).ok, false);
  assert.equal(fs.existsSync(f.PROFILE_DIR), false);
  assert.equal(f.auth.loginState().loginInProgress, false);
  assert.equal(f.auth.startLogin().started, true);
  f.chrome.emit('exit');
  await f.time.tick(2000);
});

test('logout leaves the profile in place when Chrome survives SIGKILL', async (t) => {
  const f = await authFixture(t, { tabs: [], ignoreTerm: true, ignoreKill: true });
  const login = f.auth.startLogin();
  fs.writeFileSync(f.SESSION_FILE, '{"cookies":[]}');
  const signingOut = f.auth.logout();
  await f.time.tick(10_000);
  await assert.rejects(signingOut, /still running after SIGKILL; its profile was left in place/);
  assert.equal(fs.existsSync(f.PROFILE_DIR), true);
  assert.equal(fs.existsSync(f.SESSION_FILE), true);
  await f.time.tick(10_000); // the cancelled login's own shutdown attempt also gives up
  assert.deepEqual(plain(await login.promise), { ok: false, message: 'Chrome (pid 4242) is still running after SIGKILL; its profile was left in place.' });
  // pending is cleared, but the live Chrome is still tracked: a second logout refuses as well.
  const again = f.auth.logout();
  await f.time.tick(10_000);
  await assert.rejects(again, /still running after SIGKILL/);
  assert.equal(fs.existsSync(f.PROFILE_DIR), true);
  f.exit('SIGKILL');
});

test('a failed profile move is undone, so logout moves nothing (EXDEV)', async (t) => {
  const f = await authFixture(t, { fs: (real) => ({ ...real, constants: real.constants, renameSync(from, to) {
    if (from === path.join(path.dirname(String(from)), 'profile') && !String(from).includes('old-account_')) {
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    }
    return real.renameSync(from, to);
  } }) });
  fs.writeFileSync(f.SESSION_FILE, '{"cookies":[]}');
  fs.mkdirSync(f.PROFILE_DIR);
  await assert.rejects(f.auth.logout(), /Sign-out failed, nothing was moved: cross-device link not permitted\. .*different filesystem.*delete=true/);
  assert.equal(fs.readFileSync(f.SESSION_FILE, 'utf8'), '{"cookies":[]}');
  assert.equal(fs.existsSync(f.PROFILE_DIR), true);
  assert.deepEqual(fs.readdirSync(f.BASE).filter((n) => n.startsWith('old-account_')), []);
});

test('logout never reuses a backup folder from the same second', async (t) => {
  const f = await authFixture(t); // the mocked clock stands still, so every backup gets the same stamp
  const dirs = [];
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(f.SESSION_FILE, `{"n":${n}}`);
    fs.mkdirSync(path.join(f.PROFILE_DIR, 'Default'), { recursive: true });
    dirs.push((await f.auth.logout()).backup);
  }
  assert.equal(new Set(dirs).size, 3);
  assert.match(dirs[1], /_2$/);
  assert.match(dirs[2], /_3$/);
  dirs.forEach((d, i) => {
    assert.equal(fs.readFileSync(path.join(d, 'session.json'), 'utf8'), `{"n":${i + 1}}`);
    assert.equal(fs.existsSync(path.join(d, 'profile', 'Default')), true);
  });
});

async function connectFixture({ beforeLaunch } = {}) {
  let stamp = 1;
  const contexts = [];
  const { Connect } = await load('src/connect.js', {
    'node:fs': { default: { statSync() { if (stamp === null) throw new Error('ENOENT'); return { mtimeMs: stamp }; } } },
    './browser.js': { CONNECT_URL, SESSION_FILE: '/fake/session', launch: async () => {
      await beforeLaunch?.();
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

test('reset during a browser launch discards that browser; concurrent callers share the relaunch', async () => {
  let release;
  const gates = [new Promise((r) => { release = r; })];
  const f = await connectFixture({ beforeLaunch: () => gates.shift() });
  const first = f.connect.context();
  const concurrent = f.connect.context();
  await f.connect.reset(); // e.g. login(fresh=true) while a tool call is starting the browser
  release();
  const ctx = await first;
  assert.equal(await concurrent, ctx);
  assert.equal(f.contexts.length, 2);
  assert.equal(f.contexts[0].closed, 1);
  assert.equal(ctx, f.contexts[1]);
  assert.equal(f.connect.ctx, ctx);
});

test('an unknown device fails after at most one refetch instead of looping', async () => {
  const { connect } = await connectFixture();
  let fetches = 0;
  connect.listDevices = async () => { fetches++; connect.devicesCache = [{ id: 'a', name: 'lab' }]; return connect.devicesCache; };
  await connect.context();
  await assert.rejects(connect.resolve('ES-SG12'), /No device matches "ES-SG12"/); // no cache: one fetch
  assert.equal(fetches, 1);
  await assert.rejects(connect.resolve('ES-SG12'), /No device matches/); // cached: refetch once
  assert.equal(fetches, 2);
  assert.equal((await connect.resolve('lab')).name, 'lab');
  assert.equal(fetches, 2);
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

for (const scenario of ['connect-email', 'id-email', 'no-email', 'device-named-like-email', 'expired', 'navigation-error', 'fallback-error']) {
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
        const menu = scenario === 'connect-email' ? 'Account pi+lab@example.com Sign out'
          : scenario === 'id-email' && visits.length === 2 ? 'pi@example.org' : null;
        // The device list names a device like an email; only the user menu identifies the account.
        const document = {
          body: { textContent: 'Devices: lab@example.net', innerText: 'Devices: lab@example.net' },
          querySelectorAll: (selector) => {
            assert.equal(selector, '[id*="user-menu"], [class*="user-menu"]');
            return menu ? [{ textContent: menu }] : [];
          },
        };
        // Execute the actual browser callback against a minimal DOM.
        return vm.runInNewContext(`(${fn.toString()})()`, { document });
      },
      async close() { closed++; },
    };
    connect.context = async () => ({ newPage: async () => page });
    if (scenario === 'expired') await assert.rejects(connect.accountEmail(), /session expired.*login tool/);
    else if (scenario === 'navigation-error') await assert.rejects(connect.accountEmail(), /navigation failed/);
    else assert.equal(await connect.accountEmail(), scenario === 'connect-email' ? 'pi+lab@example.com' : scenario === 'id-email' ? 'pi@example.org' : null);
    assert.equal(closed, 1);
    assert.equal(visits.length, ['id-email', 'no-email', 'device-named-like-email', 'fallback-error'].includes(scenario) ? 2 : 1);
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
    checkCanLogin: () => { calls.push('display'); },
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
  f.connect.accountEmail = async () => { throw Object.assign(new Error('session expired'), { expired: true }); };
  const expired = await f.call('account');
  assert.equal(expired.signedIn, false);
  assert.equal(expired.error, 'session expired');
});

test('account reports an unknown status, not sign-out, when the lookup fails for another reason', async () => {
  const f = await serverFixture({ savedSession: () => ({ savedAt: 'saved-date' }) });
  f.connect.listDevices = async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); };
  const account = await f.call('account');
  assert.equal(account.signedIn, null);
  assert.equal(account.savedAt, 'saved-date');
  assert.equal(account.error, 'net::ERR_INTERNET_DISCONNECTED');
});

test('account reads again when the session changes mid-lookup, never mixing two accounts', async () => {
  let session = { savedAt: 'A' };
  const f = await serverFixture({ savedSession: () => session });
  let reads = 0;
  f.connect.accountEmail = async () => (++reads === 1 ? 'a@example.com' : 'b@example.com');
  f.connect.listDevices = async () => {
    if (reads === 1) session = { savedAt: 'B' }; // a terminal login switches account between the two reads
    return [{ name: reads === 1 ? 'b-device-read-too-late' : 'b-device' }];
  };
  const account = await f.call('account');
  assert.deepEqual([account.savedAt, account.email, account.devices], ['B', 'b@example.com', ['b-device']]);
  // If it keeps changing, say so instead of returning a mixed answer.
  let n = 0;
  const g = await serverFixture({ savedSession: () => ({ savedAt: `S${++n}` }) });
  const churn = await g.call('account');
  assert.equal(churn.signedIn, null);
  assert.equal(churn.email, undefined);
  assert.equal(churn.devices, undefined);
  assert.match(churn.error, /session changed while it was being read/);
});

test('fresh login validates display and Chrome before resetting or logging out the current account', async () => {
  const f = await serverFixture({ checkCanLogin() { throw new Error('No display'); } });
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

test('fresh login that fails to start after signing out still returns the backup and restore command', async () => {
  const f = await serverFixture({
    logout: async () => ({ signedOut: true, backup: '/b', restore: "mv '/b/session.json' '/s'" }),
    startLogin: () => { throw new Error('Chrome not found at /x'); },
  });
  const result = await f.call('login', { fresh: true, wait_sec: 0 });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.logout, { signedOut: true, backup: '/b', restore: "mv '/b/session.json' '/s'" });
  assert.deepEqual(result.result, { ok: false, message: 'Chrome not found at /x' });
});

test('login clears its wait timer when sign-in finishes first', async () => {
  const f = await serverFixture();
  const result = await f.call('login', { wait_sec: 600 });
  assert.equal(result.result.ok, true);
  assert.equal(f.time.timers, 0);
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
        checkCanLogin: () => { calls.push('checkCanLogin'); },
        logout: async () => { calls.push('logout'); return { signedOut: true }; },
        startLogin: () => { calls.push('login'); return { promise: Promise.resolve({ ok, message: 'login result' }) }; },
      } }, {
        console: { log: (message) => calls.push(message) },
        process: { argv: ['node', 'login.js', ...(fresh ? ['--fresh'] : [])], exit: (code) => calls.push(['exit', code]) },
      });
      assert.equal(calls[0], 'checkCanLogin');
      if (fresh) assert.equal(calls[1], 'logout');
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
