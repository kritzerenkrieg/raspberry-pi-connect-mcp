// Drives Raspberry Pi Connect's web remote shell (xterm.js over WebRTC) with a headless browser.
import fs from 'node:fs';
import { launch, CONNECT_URL, SESSION_FILE } from './browser.js';

const sessionStamp = () => { try { return fs.statSync(SESSION_FILE).mtimeMs; } catch { return null; } };

const CONNECT_TIMEOUT = 120_000; // relay connections can take ~30s to come up

// Strip ANSI/VT escape sequences and normalise newlines.
export function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (window title etc.)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=>78DEHM]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// The keystrokes run() types for one command. Markers are produced by printf so they never appear
// literally in the echoed command line. The command and the end marker are one compound command:
// bash reads all of it before running any of it, so the end marker is never left as typed-ahead
// input for the command to swallow. (It was a separate line once, and sudo, ssh and anything else
// that reads or flushes the terminal ate it, leaving run() waiting out its whole timeout.)
// A group, not a subshell, so cd and variables still carry over to the next command. The start
// marker is part of it too: it prints only once the shell has read (and echoed) the whole input.
export function commandInput(n, command) {
  const cmd = command.trim() ? command : ':';
  return ` printf '\\n__RPS_%s__\\n' ${n}; { ${cmd}\n}; printf '\\n__RPE_%s_%s__\\n' ${n} $?\n`;
}

// Whether a command's output (raw terminal stream after its input was sent) shows it finished.
// Self-contained: it also runs inside the page, from its source text.
export function scanOutput(raw, n) {
  const end = new RegExp(`__RPE_${n}_(\\d+)__`).exec(raw);
  if (end) return { exitCode: Number(end[1]) };
  // The start marker prints only once bash has parsed the whole input: from then on, any
  // "bash: syntax error" is the command's own output and the command may still be running.
  if (raw.includes(`__RPS_${n}__`)) return null;
  // Interactive bash's own parse error: nothing ran, so no end marker will come. In a terminal the
  // message follows escape codes and a carriage return (readline ending bracketed paste). Only a
  // whole line counts, so the snapshot that matched holds the complete error.
  if (/(^|\n)(\x1b\[[0-?]*[ -/]*[@-~]|\r)*-?bash: syntax error[^\n]*\n/.test(raw)) return { exitCode: 2, syntaxError: true };
  return null;
}

class ExpiredError extends Error {
  constructor() {
    super('Raspberry Pi Connect session expired. Use the login tool, then ask the user to sign in in the Chrome window.');
    this.expired = true; // lets callers tell an invalid session from a network error
  }
}

export class Connect {
  ctx = null;
  sessions = new Map(); // deviceId -> { page, name, queue }
  devicesCache = null;

  launching = null; // promise of a browser launch in progress, shared by concurrent callers
  generation = 0; // bumped by reset(), so a launch that was in progress when it ran is discarded

  async context() {
    for (;;) {
      // Reload when the session file changed (login/logout from the tools or a terminal): no reconnect needed.
      const stamp = sessionStamp();
      if (this.ctx && stamp !== this.stamp) await this.reset();
      if (this.ctx) return this.ctx;
      if (!this.launching) {
        const generation = this.generation;
        this.launching = (async () => {
          try {
            const ctx = await launch();
            // reset() ran during the launch: this browser may hold the old session, so close it and
            // let the loop launch again with the current session file.
            if (generation !== this.generation) { await ctx.close().catch(() => {}); return; }
            this.ctx = ctx;
            this.stamp = stamp;
            ctx.on('close', () => {
              if (this.ctx === ctx) { this.ctx = null; this.sessions.clear(); }
            });
          } finally {
            this.launching = null;
          }
        })();
      }
      await this.launching;
    }
  }

  async listDevices() {
    const ctx = await this.context();
    const page = await ctx.newPage();
    try {
      const devices = [];
      const seen = new Set();
      const queue = [`${CONNECT_URL}/devices`];
      while (queue.length) {
        const url = queue.shift();
        if (seen.has(url)) continue;
        seen.add(url);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (page.url().includes('/sign-in')) throw new ExpiredError();
        const { rows, pages } = await page.evaluate(() => ({
          rows: [...document.querySelectorAll('tr')]
            .map((tr) => {
              const a = tr.querySelector('a[href^="/devices/"]');
              if (!a) return null;
              const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim());
              return {
                id: a.getAttribute('href').split('/')[2],
                name: a.innerText.trim(),
                clientVersion: (cells[1] || '').split('\n')[0],
                lastSeen: cells[2] || '',
                online: /online/i.test(cells[2] || ''),
                remoteShell: !!tr.querySelector('[title="Remote shell access is allowed"]'),
                screenSharing: !!tr.querySelector('[title="Screen sharing is allowed"]'),
              };
            })
            .filter(Boolean),
          pages: [...document.querySelectorAll('a[href*="page="]')].map((a) => a.href),
        }));
        for (const r of rows) if (!devices.some((d) => d.id === r.id)) devices.push(r);
        for (const p of pages) if (p.startsWith(CONNECT_URL) && !seen.has(p)) queue.push(p);
      }
      this.devicesCache = devices;
      return devices;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async resolve(device) {
    if (sessionStamp() !== this.stamp) this.devicesCache = null; // account may have changed
    const cached = this.devicesCache;
    const devices = cached || (await this.listDevices());
    const q = device.trim().toLowerCase();
    let m = devices.filter((d) => d.id === q || d.name.toLowerCase() === q);
    if (!m.length) m = devices.filter((d) => d.name.toLowerCase().includes(q));
    // Not found in a cached list: it may be new, so fetch once more. (A fresh list also fills the cache,
    // so test where this list came from; testing the cache here looped forever on an unknown device.)
    if (m.length === 0 && cached) { this.devicesCache = null; return this.resolve(device); }
    if (m.length === 0) throw new Error(`No device matches "${device}". Use list_devices.`);
    if (m.length > 1) throw new Error(`"${device}" is ambiguous: ${m.map((d) => d.name).join(', ')}`);
    return checkAllowed(m[0]);
  }

  async session(device) {
    let d = await this.resolve(device);
    const existing = this.sessions.get(d.id);
    if (existing && !existing.page.isClosed() && (await this.alive(existing.page))) return existing;
    if (existing) await existing.page.close().catch(() => {});

    // Opening a shell on an offline device only fails after CONNECT_TIMEOUT. The list may be stale
    // (the device just came online), so check a fresh one before giving up. (The list's remote shell
    // flag is not checked: it can read false while the shell works, e.g. just after a rename.)
    if (!d.online) {
      // By its id only: a name match could pick a different device. Its name may have changed, so the
      // allowlist is checked again.
      const fresh = (await this.listDevices()).find((x) => x.id === d.id);
      if (!fresh) throw new Error(`${d.name} is no longer on this account. Use list_devices.`);
      d = checkAllowed(fresh);
      if (!d.online) throw new Error(`${d.name} is offline (last seen: ${d.lastSeen || 'unknown'}).`);
    }

    const ctx = await this.context();
    const page = await ctx.newPage();
    await page.goto(`${CONNECT_URL}/devices/${d.id}/remote-shell-session`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/sign-in')) { await page.close(); throw new ExpiredError(); }
    try {
      await page.waitForSelector('.xterm', { timeout: CONNECT_TIMEOUT });
    } catch {
      const status = await page.locator('[data-shell-target=status]').innerText().catch(() => '');
      await page.close();
      throw new Error(`Could not open remote shell on ${d.name} (online: ${d.online}). Status: ${status || 'unknown'}`);
    }
    // Hook the terminal's write() so we capture the full raw output stream, not just the viewport.
    await page.evaluate(() => {
      const el = document.querySelector('[data-controller=shell]');
      const c = window.Stimulus.getControllerForElementAndIdentifier(el, 'shell');
      const term = c.terminal;
      window.__term = term;
      window.__out = '';
      const dec = new TextDecoder();
      const orig = term.write.bind(term);
      term.write = (data, cb) => {
        window.__out += typeof data === 'string' ? data : dec.decode(data, { stream: true });
        if (window.__out.length > 4_000_000) window.__out = window.__out.slice(-2_000_000);
        return orig(data, cb);
      };
    });
    const s = { page, name: d.name, id: d.id, queue: Promise.resolve(), seq: 0 };
    this.sessions.set(d.id, s);
    // The terminal shows before the shell has connected, and keystrokes sent then can be dropped
    // (the command never runs; only prompts come back). Wait for the shell's first output, its prompt.
    await page.waitForFunction(() => window.__out.length > 0, null, { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(500);
    // Non-interactive-friendly defaults for this shell only.
    await this.input(s, ' export PAGER=cat SYSTEMD_PAGER=cat GIT_PAGER=cat SYSTEMD_COLORS=0\n');
    await page.waitForTimeout(300);
    return s;
  }

  async alive(page) {
    return page.evaluate(() => {
      const st = document.querySelector('[data-shell-target=status]');
      const rc = document.querySelector('[data-shell-target=reconnect]');
      return !!window.__term && st?.classList.contains('hidden') && rc?.classList.contains('hidden');
    }).catch(() => false);
  }

  // Send raw input (may contain control chars like \x03 for Ctrl-C) to the remote shell.
  async input(s, data) {
    await s.page.evaluate((d) => {
      const t = window.__term;
      if (typeof t.input === 'function') t.input(d, true);
      else t._core.coreService.triggerDataEvent(d, true);
    }, data);
  }

  serialize(s, fn) {
    const run = s.queue.then(fn, fn);
    s.queue = run.catch(() => {});
    return run;
  }

  async run(device, command, timeoutSec = 60) {
    const s = await this.session(device);
    return this.serialize(s, async () => {
      const n = `${Date.now().toString(36)}${++s.seq}`;
      const start = await s.page.evaluate(() => window.__out.length);
      await this.input(s, commandInput(n, command));
      // Watch for the end inside the page, rather than copying the whole output back on every poll.
      // The output comes from the same snapshot that showed the end: a later read could find it
      // trimmed away by the write hook.
      const watch = `(() => { const t = window.__out.slice(${start}); ` +
        `const r = (${scanOutput})(t, ${JSON.stringify(n)}); return r && { ...r, raw: t }; })()`;
      const done = await s.page
        .waitForFunction(watch, null, { timeout: timeoutSec * 1000, polling: 100 })
        .then(async (h) => {
          // The handle keeps the snapshot alive in the page until it is disposed.
          try { return await h.jsonValue(); } finally { await h.dispose().catch(() => {}); }
        }, (e) => { if (s.page.isClosed()) throw e; return null; });
      const text = stripAnsi(done ? done.raw : await s.page.evaluate((i) => window.__out.slice(i), start));
      const startRe = new RegExp(`__RPS_${n}__\\n`);
      const sm = startRe.exec(text);
      if (done?.syntaxError) {
        // Nothing ran; the output is the echoed input and bash's error, whose whole line is in the snapshot.
        const err = text.split('\n').find((l) => /^-?bash: syntax error/.test(l));
        return { device: s.name, exitCode: 2, output: err || cleanBody(text) };
      }
      if (done) {
        const e = new RegExp(`\\n?__RPE_${n}_\\d+__`).exec(text);
        const body = text.slice(sm ? sm.index + sm[0].length : 0, e ? e.index : undefined);
        return { device: s.name, exitCode: done.exitCode, output: cleanBody(body) };
      }
      return {
        device: s.name,
        exitCode: null,
        timedOut: true,
        output: cleanBody(sm ? text.slice(sm.index + sm[0].length) : text),
        note: `Still running after ${timeoutSec}s (or waiting for input). Use read_screen / send_keys (e.g. "\\x03" for Ctrl-C).`,
      };
    });
  }

  async screen(device, lines = 0) {
    const s = await this.session(device);
    return s.page.evaluate((lines) => {
      const b = window.__term.buffer.active;
      const out = [];
      for (let i = 0; i < b.length; i++) {
        const l = b.getLine(i);
        const txt = l.translateToString(true);
        if (l.isWrapped && out.length) out[out.length - 1] += txt; else out.push(txt);
      }
      while (out.length && !out.at(-1).trim()) out.pop();
      return (lines > 0 ? out.slice(-lines) : out.slice(-(window.__term.rows + 20))).join('\n');
    }, lines);
  }

  async send(device, data) {
    const s = await this.session(device);
    await this.input(s, data);
    await s.page.waitForTimeout(800);
    return this.screen(device);
  }

  async close(device) {
    const d = await this.resolve(device);
    const s = this.sessions.get(d.id);
    if (!s) return false;
    await s.page.close().catch(() => {});
    this.sessions.delete(d.id);
    return true;
  }

  // Drop the browser, shell sessions and device cache, so the next call loads the current session file.
  async reset() {
    this.generation++;
    const ctx = this.ctx;
    this.ctx = null;
    this.sessions.clear();
    this.devicesCache = null;
    await ctx?.close().catch(() => {});
  }

  // Best effort: the signed-in account's email, from the user menu of the Connect page, else of the
  // Raspberry Pi ID page. Only the user menu counts (a device may be named like an email); else null.
  async accountEmail() {
    const ctx = await this.context();
    const page = await ctx.newPage();
    const find = () => page.evaluate(() => {
      const re = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
      for (const el of document.querySelectorAll('[id*="user-menu"], [class*="user-menu"]')) {
        const m = (el.textContent || '').match(re); // textContent: the menu is usually collapsed (hidden)
        if (m) return m[0];
      }
      return null;
    });
    try {
      await page.goto(`${CONNECT_URL}/devices`, { waitUntil: 'domcontentloaded' });
      if (page.url().includes('/sign-in')) throw new ExpiredError();
      let email = await find();
      if (!email) {
        await page.goto('https://id.raspberrypi.com/profile', { waitUntil: 'domcontentloaded' }).catch(() => {});
        email = await find().catch(() => null);
      }
      return email;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async shutdown() {
    await this.ctx?.close().catch(() => {});
  }
}

function checkAllowed(d) {
  const allow = process.env.RPI_CONNECT_ALLOW;
  if (allow && !allow.split(',').some((a) => a.trim() && d.name.toLowerCase().includes(a.trim().toLowerCase()))) {
    throw new Error(`Device "${d.name}" is not in RPI_CONNECT_ALLOW.`);
  }
  return d;
}

// Drop the prompt + echoed second printf line that may trail the output.
function cleanBody(body) {
  const lines = body.split('\n');
  while (lines.length && (/__RPE_/.test(lines.at(-1)) || /printf '\\n__RP/.test(lines.at(-1)) || !lines.at(-1).trim())) lines.pop();
  return lines.join('\n');
}
