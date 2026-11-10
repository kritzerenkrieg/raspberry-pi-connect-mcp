#!/usr/bin/env node
// Interactive login. Starts Chrome as a normal process; the user signs in by hand.
// Connect uses session-only cookies (deleted when Chrome closes), so once the user reaches the
// device list we read the cookies over a localhost debug port and save them for the MCP.
// While the user is signing in we only poll the tab list URL; nothing is attached to the page.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { chromePath, PROFILE_DIR, CONNECT_URL, SESSION_FILE } from '../src/browser.js';

const PORT = 9333;
fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
const chrome = spawn(
  chromePath(),
  [`--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
   '--no-first-run', '--no-default-browser-check', CONNECT_URL],
  { stdio: 'ignore' },
);
let exited = false;
chrome.on('exit', () => { exited = true; });
console.log('Sign in in the Chrome window. It will close by itself once your device list is showing.');

const loggedIn = (u) => u.startsWith(CONNECT_URL) && !/sign-in|auth|callback/.test(new URL(u).pathname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const deadline = Date.now() + 10 * 60 * 1000;
while (!exited && Date.now() < deadline) {
  await sleep(2000);
  let tabs;
  try { tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { continue; }
  if (!tabs.some((t) => t.type === 'page' && loggedIn(t.url))) continue;

  await sleep(3000); // let the app finish setting cookies
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const cookies = (await browser.contexts()[0].cookies()).filter((c) => c.domain.includes('raspberrypi.com'));
  if (!cookies.some((c) => c.name === '_connect_session')) { await browser.close().catch(() => {}); continue; }
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 1), { mode: 0o600 });
  console.log(`Saved ${cookies.length} cookies to ${SESSION_FILE}`);
  await browser.close().catch(() => {});
  chrome.kill();
  process.exit(0);
}
console.log(exited ? 'Chrome was closed before login completed. Nothing saved.' : 'Timed out after 10 minutes.');
chrome.kill();
process.exit(1);
