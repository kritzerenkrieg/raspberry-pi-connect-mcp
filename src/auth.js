// Account handling: sign in (a visible Chrome window where the user signs in by hand), sign out
// (session + Chrome profile moved to a backup folder, or deleted) and status.
// Connect uses session-only cookies (deleted when Chrome closes), so once the user reaches the
// device list we read the cookies over a localhost debug port and save them for the MCP.
// While the user is signing in we only poll the tab list URL; nothing is attached to the page.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { chromePath, BASE, PROFILE_DIR, CONNECT_URL, SESSION_FILE } from './browser.js';

const PORT = 9333;
const LOGIN_TIMEOUT = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Signed in = a Connect tab showing the device list. The start page ("/") also sets an anonymous
// _connect_session cookie before the user signs in, so it doesn't count.
const loggedIn = (u) => u.startsWith(CONNECT_URL) && /^\/devices/.test(new URL(u).pathname);
const ID_COOKIES = ['_identity_session', 'session_id'];

// Kill Chrome and wait until the process is gone, so its profile folder is no longer in use.
function stopChrome(chrome) {
  if (chrome.exitCode !== null || chrome.signalCode !== null) return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(() => { chrome.kill('SIGKILL'); res(); }, 5000);
    chrome.once('exit', () => { clearTimeout(t); res(); });
    chrome.kill();
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

let pending = null; // { startedAt, chrome, promise }
let lastLogin = null; // result of the last finished login

export function savedSession() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try { return { savedAt: JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).savedAt || null }; }
  catch { return { savedAt: null }; }
}

export function loginState() {
  return { loginInProgress: !!pending, loginStartedAt: pending?.startedAt || null, lastLogin };
}

// Opens Chrome for the user to sign in. Returns { started, startedAt, promise }; the promise resolves
// to { ok, message } when the session is saved, the window is closed or 10 minutes pass.
export function startLogin({ onSaved } = {}) {
  if (pending) return { started: false, startedAt: pending.startedAt, promise: pending.promise };
  checkDisplay();
  fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  const chrome = spawn(
    chromePath(),
    [`--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
     '--no-first-run', '--no-default-browser-check', CONNECT_URL],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chrome.stderrTail = '';
  chrome.stderr.on('data', (d) => { chrome.stderrTail = (chrome.stderrTail + d).slice(-1500); });
  const p = { startedAt: new Date().toISOString(), chrome };
  p.promise = waitForLogin(chrome)
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

async function waitForLogin(chrome) {
  let exited = false;
  chrome.on('exit', () => { exited = true; });
  chrome.on('error', () => { exited = true; });
  const deadline = Date.now() + LOGIN_TIMEOUT;
  let browser;
  try {
    while (!exited && Date.now() < deadline) {
      await sleep(2000);
      let tabs;
      try { tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { continue; }
      if (!tabs.some((t) => t.type === 'page' && loggedIn(t.url))) continue;

      await sleep(3000); // let the app finish setting cookies
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      const cookies = (await browser.contexts()[0].cookies()).filter((c) => c.domain.includes('raspberrypi.com'));
      const signedIn = cookies.some((c) => c.name === '_connect_session')
        && cookies.some((c) => c.domain.includes('id.raspberrypi.com') && ID_COOKIES.includes(c.name));
      if (!signedIn) { await browser.close().catch(() => {}); browser = null; continue; }
      fs.writeFileSync(SESSION_FILE, JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 1), { mode: 0o600 });
      return { ok: true, message: `Signed in; saved ${cookies.length} cookies to ${SESSION_FILE}` };
    }
    if (!exited) return { ok: false, message: 'Timed out after 10 minutes.' };
    const quick = Date.now() - (deadline - LOGIN_TIMEOUT) < 10_000; // exited on its own, not closed by the user
    const tail = chrome.stderrTail.trim().split('\n').slice(-5).join('\n');
    return {
      ok: false,
      message: quick
        ? `Chrome exited right after starting (code ${chrome.exitCode ?? chrome.signalCode}). Nothing saved.` +
          (tail ? `\nChrome output:\n${tail}` : '')
        : 'Chrome was closed before sign-in completed. Nothing saved.',
    };
  } finally {
    try {
      await browser?.close().catch(() => {});
    } finally {
      await stopChrome(chrome);
    }
  }
}

// Signs out: stops a running login, then moves the session file and Chrome profile (which keeps the
// Raspberry Pi ID login and would sign the old account straight back in) into old-account_<time>/,
// or deletes them with del=true. Waits for a running login to finish shutting down first, so the
// profile is not moved while Chrome still writes to it and a following startLogin() opens a new window.
export async function logout({ del = false } = {}) {
  if (pending) {
    const p = pending;
    await stopChrome(p.chrome);
    await p.promise; // its finally() clears `pending`
  }
  const items = [SESSION_FILE, PROFILE_DIR].filter((p) => fs.existsSync(p));
  if (!items.length) return { signedOut: true, message: 'Was not signed in.' };
  if (del) {
    for (const p of items) fs.rmSync(p, { recursive: true, force: true });
    return { signedOut: true, deleted: items };
  }
  const d = new Date(); // local time, so the folder name matches the clock
  const n = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${n(d.getMonth() + 1)}${n(d.getDate())}_${n(d.getHours())}${n(d.getMinutes())}${n(d.getSeconds())}`;
  const dir = path.join(BASE, `old-account_${stamp}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const p of items) fs.renameSync(p, path.join(dir, path.basename(p)));
  return {
    signedOut: true,
    backup: dir,
    restore: `move the contents of ${dir} back to ${BASE} (after logout of the current account)`,
  };
}
