// Browser launcher. Chrome for Testing, headless by default, loaded with the session cookies the
// user created by signing in manually (scripts/login.js). No fingerprint or bot-detection evasion:
// if Cloudflare challenges or the session expires, the user signs in again by hand.
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const CONNECT_URL = 'https://connect.raspberrypi.com';
const BASE = path.join(os.homedir(), '.config', 'rpi-connect-mcp');
export const PROFILE_DIR = process.env.RPI_CONNECT_PROFILE || path.join(BASE, 'chrome-profile');
export const SESSION_FILE = process.env.RPI_CONNECT_SESSION || path.join(BASE, 'session.json');

export function chromePath() {
  if (process.env.RPI_CONNECT_CHROME) return process.env.RPI_CONNECT_CHROME;
  const root = path.join(os.homedir(), '.cache', 'rpi-connect-mcp', 'chrome');
  const builds = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d.startsWith('linux-')).sort() : [];
  if (!builds.length) throw new Error(`No Chrome found under ${root}; set RPI_CONNECT_CHROME`);
  return path.join(root, builds.at(-1), 'chrome-linux64', 'chrome');
}

export async function launch({ headless = process.env.RPI_CONNECT_HEADED !== '1' } = {}) {
  if (!fs.existsSync(SESSION_FILE)) throw new Error('Not signed in. Run: node scripts/login.js');
  const browser = await chromium.launch({ executablePath: chromePath(), headless });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).cookies);
  ctx.on('close', () => browser.close().catch(() => {}));
  return ctx;
}
