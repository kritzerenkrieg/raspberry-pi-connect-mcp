// Drives Raspberry Pi Connect's web remote shell (xterm.js over WebRTC) with a headless browser.
import { launch, CONNECT_URL } from './browser.js';

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

class ExpiredError extends Error {
  constructor() { super('Raspberry Pi Connect session expired. Ask the user to run: node scripts/login.js'); }
}

export class Connect {
  ctx = null;
  sessions = new Map(); // deviceId -> { page, name, queue }
  devicesCache = null;

  async context() {
    if (!this.ctx) {
      this.ctx = await launch();
      this.ctx.on('close', () => { this.ctx = null; this.sessions.clear(); });
    }
    return this.ctx;
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
    const devices = this.devicesCache || (await this.listDevices());
    const q = device.trim().toLowerCase();
    let m = devices.filter((d) => d.id === q || d.name.toLowerCase() === q);
    if (!m.length) m = devices.filter((d) => d.name.toLowerCase().includes(q));
    if (m.length === 0 && this.devicesCache) { this.devicesCache = null; return this.resolve(device); }
    if (m.length === 0) throw new Error(`No device matches "${device}". Use list_devices.`);
    if (m.length > 1) throw new Error(`"${device}" is ambiguous: ${m.map((d) => d.name).join(', ')}`);
    const d = m[0];
    const allow = process.env.RPI_CONNECT_ALLOW;
    if (allow && !allow.split(',').some((a) => a.trim() && d.name.toLowerCase().includes(a.trim().toLowerCase()))) {
      throw new Error(`Device "${d.name}" is not in RPI_CONNECT_ALLOW.`);
    }
    return d;
  }

  async session(device) {
    const d = await this.resolve(device);
    const existing = this.sessions.get(d.id);
    if (existing && !existing.page.isClosed() && (await this.alive(existing.page))) return existing;
    if (existing) await existing.page.close().catch(() => {});

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
      // Markers are produced by printf so they never appear literally in the echoed command line.
      const line = ` printf '\\n__RPS_%s__\\n' ${n}; ${command}\n printf '\\n__RPE_%s_%s__\\n' ${n} $?\n`;
      await this.input(s, line);
      const startRe = new RegExp(`__RPS_${n}__\\n`);
      const endRe = new RegExp(`\\n__RPE_${n}_(\\d+)__`);
      const deadline = Date.now() + timeoutSec * 1000;
      let text = '';
      while (Date.now() < deadline) {
        await s.page.waitForTimeout(250);
        text = stripAnsi(await s.page.evaluate((i) => window.__out.slice(i), start));
        const e = endRe.exec(text);
        if (e) {
          const sm = startRe.exec(text);
          const body = text.slice(sm ? sm.index + sm[0].length : 0, e.index);
          return { device: s.name, exitCode: Number(e[1]), output: cleanBody(body) };
        }
      }
      const sm = startRe.exec(text);
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

  async shutdown() {
    await this.ctx?.close().catch(() => {});
  }
}

// Drop the prompt + echoed second printf line that may trail the output.
function cleanBody(body) {
  const lines = body.split('\n');
  while (lines.length && (/__RPE_/.test(lines.at(-1)) || /printf '\\n__RP/.test(lines.at(-1)) || !lines.at(-1).trim())) lines.pop();
  return lines.join('\n');
}
