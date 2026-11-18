// Account handling: sign in (a visible Chrome window where the user signs in by hand), sign out
// (session + Chrome profile moved to a backup folder, or deleted) and status.
// Connect uses session-only cookies (deleted when Chrome closes), so once the user reaches the
// device list we read the cookies and save them for the MCP. We talk to the sign-in Chrome over
// --remote-debugging-pipe (file descriptors private to this process), not a TCP debug port that any
// local account could connect to. While the user signs in we only list the tabs; nothing is attached
// to the page.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromePath, BASE, PROFILE_DIR, CONNECT_URL, SESSION_FILE } from './browser.js';

const LOGIN_TIMEOUT = 10 * 60 * 1000;
const KILL_GRACE = 5000; // per signal: SIGTERM, then SIGKILL
const CDP_TIMEOUT = 10_000;

// Signed in = a Connect tab showing the device list. The start page ("/") also sets an anonymous
// _connect_session cookie before the user signs in, so it doesn't count.
const CONNECT_ORIGIN = new URL(CONNECT_URL).origin;
const CONNECT_HOST = new URL(CONNECT_URL).hostname;
const ID_HOST = 'id.raspberrypi.com';
const ID_COOKIES = ['_identity_session', 'session_id'];
const loggedIn = (u) => {
  try { const url = new URL(u); return url.origin === CONNECT_ORIGIN && /^\/devices\/?$/.test(url.pathname); }
  catch { return false; }
};
const cookieHost = (c) => String(c.domain || '').replace(/^\./, '').toLowerCase();
const isProviderCookie = (c) => cookieHost(c) === 'raspberrypi.com' || cookieHost(c).endsWith('.raspberrypi.com');
const isSignedIn = (cookies) =>
  cookies.some((c) => c.name === '_connect_session' && cookieHost(c) === CONNECT_HOST)
  && cookies.some((c) => ID_COOKIES.includes(c.name) && cookieHost(c) === ID_HOST);
// CDP cookie -> the shape Playwright's addCookies() takes (it rejects CDP-only fields like size).
const toSaved = (c) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires ?? -1,
  httpOnly: !!c.httpOnly, secure: !!c.secure, ...(c.sameSite ? { sameSite: c.sameSite } : {}),
});

const hasExited = (chrome) => chrome.exitCode !== null || chrome.signalCode !== null;

// Kill Chrome and wait until the process is seen to exit, so its profile folder is no longer in use.
// Rejects if it is still running after SIGKILL: callers must then leave the profile where it is.
// Concurrent callers share one attempt; after a failed attempt the next call tries again.
function stopChrome(chrome) {
  if (hasExited(chrome) || chrome.pid === undefined) return Promise.resolve(); // exited or never started
  chrome.stopping ??= killAndWait(chrome).catch((e) => { chrome.stopping = null; throw e; });
  return chrome.stopping;
}

function killAndWait(chrome) {
  return new Promise((res, rej) => {
    let killTimer;
    const onExit = () => { clearTimeout(termTimer); clearTimeout(killTimer); res(); };
    chrome.once('exit', onExit);
    const termTimer = setTimeout(() => {
      chrome.kill('SIGKILL');
      killTimer = setTimeout(() => {
        chrome.off('exit', onExit);
        rej(new Error(`Chrome (pid ${chrome.pid}) is still running after SIGKILL; its profile was left in place.`));
      }, KILL_GRACE);
    }, KILL_GRACE);
    chrome.kill();
  });
}

// Minimal Chrome DevTools Protocol client over --remote-debugging-pipe: Chrome reads commands from
// fd 3 and writes replies to fd 4, each message a JSON object ended by a NUL byte.
function cdpPipe(chrome) {
  const [, , , toChrome, fromChrome] = chrome.stdio;
  let buf = '';
  let seq = 0;
  const waiting = new Map();
  const failAll = (message) => { for (const done of waiting.values()) done({ error: { message } }); waiting.clear(); };
  fromChrome.setEncoding?.('utf8');
  fromChrome.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\0')) >= 0;) {
      let msg = null;
      try { msg = JSON.parse(buf.slice(0, i)); } catch { /* ignore a malformed message */ }
      buf = buf.slice(i + 1);
      const done = msg && waiting.get(msg.id);
      if (done) { waiting.delete(msg.id); done(msg); }
    }
  });
  fromChrome.on('error', () => {});
  toChrome.on('error', () => {});
  chrome.on('exit', () => failAll('Chrome exited'));
  return (method, params = {}, ms = CDP_TIMEOUT) => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); rej(new Error(`Chrome did not answer ${method} within ${ms / 1000}s`)); }, ms);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) rej(new Error(`${method}: ${msg.error.message}`)); else res(msg.result);
    });
    toChrome.write(JSON.stringify({ id, method, params }) + '\0');
  });
}

// MCP clients may start the server with a minimal environment (the MCP SDK's stdio client passes
// only HOME, PATH, USER...): without a display Chrome exits at once, so say so instead.
export function checkDisplay() {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('No display: DISPLAY/WAYLAND_DISPLAY is not set for the MCP server, so the sign-in window ' +
      'cannot open. Add "env": {"DISPLAY": ":0"} to the server entry in the MCP client config, or run: npm run login');
  }
}

// Throws unless the sign-in window can open: a display, and a Chrome binary that exists and is
// executable. Run it before signing out, so a doomed login doesn't cost the current session.
export function checkCanLogin() {
  checkDisplay();
  const bin = chromePath();
  try { fs.accessSync(bin, fs.constants.X_OK); } catch (e) { throw new Error(chromeStartError(e, bin)); }
  return bin;
}

function chromeStartError(e, bin) {
  if (e.code === 'ENOENT') return `Chrome not found at ${bin}. Install it (see README) or set RPI_CONNECT_CHROME.`;
  if (e.code === 'EACCES') return `Chrome at ${bin} is not executable (EACCES).`;
  return `Could not start Chrome at ${bin}: ${e.message}`;
}

let pending = null; // { startedAt, chrome, promise }
let lastChrome = null; // the most recent sign-in Chrome, until it is seen to exit
let lastLogin = null; // result of the last finished login

export function savedSession() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try { return { savedAt: JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).savedAt || null }; }
  catch { return { savedAt: null }; }
}

export function loginState() {
  return { loginInProgress: !!pending, loginStartedAt: pending?.startedAt || null, lastLogin };
}

// Write the whole file next to the destination, then rename it over: readers never see a partial
// file, a failed write leaves the old session intact, and the new file is created with mode 600.
function writeSession(cookies) {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${SESSION_FILE}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 1), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, SESSION_FILE);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Opens Chrome for the user to sign in. Returns { started, startedAt, promise }; the promise resolves
// to { ok, message } when the session is saved, the window is closed or 10 minutes pass.
export function startLogin({ onSaved } = {}) {
  if (pending) return { started: false, startedAt: pending.startedAt, promise: pending.promise };
  const bin = checkCanLogin();
  fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  const chrome = spawn(
    bin,
    [`--user-data-dir=${PROFILE_DIR}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', CONNECT_URL],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  );
  chrome.bin = bin;
  chrome.stderrTail = '';
  chrome.stderr.on('data', (d) => { chrome.stderrTail = (chrome.stderrTail + d).slice(-1500); });
  lastChrome = chrome;
  chrome.once('exit', () => { if (lastChrome === chrome) lastChrome = null; });
  const p = { startedAt: new Date().toISOString(), chrome, ctl: { cancelled: false, wake: () => {} } };
  p.promise = waitForLogin(chrome, p.ctl)
    .catch((e) => ({ ok: false, message: e.message }))
    .then((r) => {
      lastLogin = { ...r, finishedAt: new Date().toISOString() };
      if (r.ok) onSaved?.();
      return r;
    })
    .finally(() => { if (pending === p) pending = null; });
  pending = p;
  return { started: true, startedAt: p.startedAt, promise: p.promise };
}

async function waitForLogin(chrome, ctl) {
  let exited = false;
  let startError = null;
  chrome.on('exit', () => { exited = true; });
  chrome.on('error', (e) => { exited = true; startError = e; });
  const send = cdpPipe(chrome);
  const startedAt = Date.now();
  const deadline = startedAt + LOGIN_TIMEOUT;
  const left = () => deadline - Date.now();
  // Waits that end early when Chrome exits or logout cancels the sign-in.
  const sleep = (ms) => new Promise((res) => {
    const done = () => { clearTimeout(timer); chrome.off('exit', done); ctl.wake = () => {}; res(); };
    const timer = setTimeout(done, ms);
    chrome.once('exit', done);
    ctl.wake = done;
  });
  const stop = () => exited || ctl.cancelled || left() <= 0;
  try {
    while (!stop()) {
      await sleep(Math.min(2000, left()));
      if (stop()) break;
      let targets;
      try { ({ targetInfos: targets } = await send('Target.getTargets', {}, Math.min(CDP_TIMEOUT, left()))); }
      catch { continue; } // not answering yet, or exited (checked above)
      if (!targets.some((t) => t.type === 'page' && loggedIn(t.url))) continue;

      await sleep(Math.min(3000, left())); // let the app finish setting cookies
      if (stop()) break;
      const { cookies: all } = await send('Storage.getCookies', {}, Math.min(CDP_TIMEOUT, left()));
      const cookies = all.filter(isProviderCookie);
      if (!isSignedIn(cookies)) continue;
      if (stop()) break; // the deadline (and a logout) also bound saving
      writeSession(cookies.map(toSaved));
      return { ok: true, message: `Signed in; saved ${cookies.length} cookies to ${SESSION_FILE}` };
    }
    if (ctl.cancelled) return { ok: false, message: 'Sign-in cancelled by logout. Nothing saved.' };
    if (startError) return { ok: false, message: chromeStartError(startError, chrome.bin) };
    if (!exited) return { ok: false, message: 'Timed out after 10 minutes.' };
    const quick = Date.now() - startedAt < 10_000; // exited on its own, not closed by the user
    const tail = chrome.stderrTail.trim().split('\n').slice(-5).join('\n');
    return {
      ok: false,
      message: quick
        ? `Chrome exited right after starting (code ${chrome.exitCode ?? chrome.signalCode}). Nothing saved.` +
          (tail ? `\nChrome output:\n${tail}` : '')
        : 'Chrome was closed before sign-in completed. Nothing saved.',
    };
  } finally {
    await stopChrome(chrome);
  }
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Signs out: stops a running login, then moves the session file and Chrome profile (which keeps the
// Raspberry Pi ID login and would sign the old account straight back in) into old-account_<time>/,
// or deletes them with del=true. Waits for the sign-in Chrome to exit first, so the profile is not
// moved while Chrome still writes to it and a following startLogin() opens a new window. If Chrome
// won't exit, or a move fails, nothing is moved (moves already made are undone).
export async function logout({ del = false } = {}) {
  const p = pending;
  if (p) { p.ctl.cancelled = true; p.ctl.wake(); }
  if (lastChrome) await stopChrome(lastChrome); // throws if it won't exit: the profile stays put
  if (p) await p.promise; // its finally() clears `pending`
  const items = [SESSION_FILE, PROFILE_DIR].filter((x) => fs.existsSync(x));
  if (!items.length) return { signedOut: true, message: 'Was not signed in.' };
  if (del) {
    for (const x of items) fs.rmSync(x, { recursive: true, force: true });
    return { signedOut: true, deleted: items };
  }
  const d = new Date(); // local time, so the folder name matches the clock
  const n = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${n(d.getMonth() + 1)}${n(d.getDate())}_${n(d.getHours())}${n(d.getMinutes())}${n(d.getSeconds())}`;
  // Create the folder exclusively, so a second backup in the same second (or a repeated DST hour)
  // gets old-account_<stamp>_2 instead of overwriting the first one.
  fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
  let dir;
  for (let i = 1; ; i++) {
    dir = path.join(BASE, `old-account_${stamp}${i > 1 ? `_${i}` : ''}`);
    try { fs.mkdirSync(dir, { mode: 0o700 }); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const moved = []; // [original path, backup path]
  try {
    for (const from of items) {
      const to = path.join(dir, path.basename(from));
      fs.renameSync(from, to);
      moved.push([from, to]);
    }
  } catch (e) {
    const stuck = [];
    for (const [from, to] of moved.reverse()) {
      try { fs.renameSync(to, from); } catch { stuck.push(`${from} is now at ${to}`); }
    }
    if (!stuck.length) fs.rmSync(dir, { recursive: true, force: true });
    const hint = e.code === 'EXDEV'
      ? ` The session or profile is on a different filesystem than ${BASE}; use delete=true, or keep RPI_CONNECT_SESSION/RPI_CONNECT_PROFILE under ${BASE}.`
      : '';
    throw new Error(stuck.length
      ? `Sign-out failed (${e.message}) and could not be fully undone: ${stuck.join('; ')}. Move it back by hand.`
      : `Sign-out failed, nothing was moved: ${e.message}.${hint}`);
  }
  return {
    signedOut: true,
    backup: dir,
    // Each item goes back to the path it came from (which may be an RPI_CONNECT_* override).
    restore: `After signing out of the current account: ${moved.map(([from, to]) => `mv ${shellQuote(to)} ${shellQuote(from)}`).join(' && ')}`,
  };
}
