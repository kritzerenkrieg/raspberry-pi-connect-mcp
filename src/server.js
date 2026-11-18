#!/usr/bin/env node
// MCP server exposing Raspberry Pi Connect remote shells.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Connect } from './connect.js';
import { startLogin, logout, savedSession, loginState, checkCanLogin } from './auth.js';

const connect = new Connect();
const server = new McpServer({ name: 'rpi-connect', version: '0.2.0' });

const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const wrap = (fn) => async (args) => {
  try { return await fn(args); } catch (e) { return { ...text(`Error: ${e.message}`), isError: true }; }
};
const device = z.string().describe('Device name (or unique substring of it) or device UUID, as shown by list_devices');

server.tool(
  'list_devices',
  'List devices on the Raspberry Pi Connect account with online status and whether remote shell is allowed.',
  {},
  wrap(async () => text(await connect.listDevices())),
);

server.tool(
  'run_command',
  'Run a shell command on a device through its Connect remote shell and return output + exit code. ' +
    'The shell session persists between calls (cwd, env vars). First call to a device takes ~30s to connect. ' +
    'Commands that wait for input (sudo password, editors, confirmations) will time out; use send_keys/read_screen for those.',
  {
    device,
    command: z.string().describe('Shell command line (bash) to run'),
    timeout_sec: z.number().int().min(1).max(1800).default(60).describe('Max seconds to wait for completion'),
  },
  wrap(async ({ device, command, timeout_sec }) => text(await connect.run(device, command, timeout_sec))),
);

server.tool(
  'send_keys',
  'Send raw keystrokes to a device shell (for interactive programs). Supports escapes: "\\n" Enter, "\\x03" Ctrl-C, ' +
    '"\\x04" Ctrl-D, "\\t" Tab, "\\x1b" Esc, "\\x1b[A" Up. Returns the current screen.',
  { device, keys: z.string().describe('Keys to send; JSON-style escapes are interpreted') },
  wrap(async ({ device, keys }) => {
    const data = keys.replace(/\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\([ntre\\])/g, (_, x, u, c) =>
      x ? String.fromCharCode(parseInt(x, 16)) : u ? String.fromCharCode(parseInt(u, 16))
        : { n: '\r', t: '\t', r: '\r', e: '\x1b', '\\': '\\' }[c]);
    return text(await connect.send(device, data));
  }),
);

server.tool(
  'read_screen',
  'Read the current terminal screen (plus a little scrollback) of a device shell.',
  { device, lines: z.number().int().min(0).max(1000).default(0).describe('Last N lines (0 = screen + 20 lines)') },
  wrap(async ({ device, lines }) => text(await connect.screen(device, lines))),
);

server.tool(
  'close_session',
  'Close the remote shell session to a device.',
  { device },
  wrap(async ({ device }) => text((await connect.close(device)) ? 'closed' : 'no open session')),
);

server.tool(
  'account',
  'Show which Raspberry Pi Connect account is signed in (email when it can be read), when the session was ' +
    'saved, its device names, and whether a login is in progress.',
  {},
  wrap(async () => {
    // Email and devices must come from the same session: if it changes while we read (a login or
    // logout elsewhere), read again rather than pair one account's email with another's devices.
    for (let attempt = 1; ; attempt++) {
      const saved = savedSession();
      const out = { signedIn: !!saved, savedAt: saved?.savedAt || null, ...loginState() };
      if (!saved) return text(out);
      try {
        out.email = await connect.accountEmail();
        out.devices = (await connect.listDevices()).map((d) => d.name);
      } catch (e) {
        // Signed out only when the session is known to be invalid; a network error says nothing about it.
        out.signedIn = e.expired ? false : savedSession() ? null : false;
        out.error = e.message;
      }
      const now = savedSession();
      if (now?.savedAt === saved.savedAt && !!now === !!saved) return text(out);
      if (attempt === 2) return text({ ...out, signedIn: null, email: undefined, devices: undefined,
        error: 'The session changed while it was being read (login/logout elsewhere); call account again.' });
    }
  }),
);

server.tool(
  'login',
  'Sign in to Raspberry Pi Connect: opens a Chrome window on this computer where the USER signs in by hand ' +
    '(tell them to do so). Waits up to wait_sec for it; if still in progress, call account later. ' +
    'fresh=true signs out the current account first (switch account). The new session is used right away.',
  {
    fresh: z.boolean().default(false).describe('Sign out first (current session backed up), to switch account'),
    wait_sec: z.number().int().min(0).max(600).default(180).describe('Seconds to wait for the user to finish'),
  },
  wrap(async ({ fresh, wait_sec }) => {
    checkCanLogin(); // display and Chrome, before signing out, so a doomed login keeps the current session
    const out = {};
    if (fresh) { await connect.reset(); out.logout = await logout(); }
    let l;
    try {
      l = startLogin({ onSaved: () => connect.reset() });
    } catch (e) {
      if (!out.logout) throw e;
      // Signed out already: keep the backup location and restore command in the answer.
      return text({ ...out, result: { ok: false, message: e.message } });
    }
    out.status = l.started ? 'Chrome window opened: the user must sign in there' : 'login already in progress';
    let timer;
    const r = await Promise.race([l.promise, new Promise((res) => { timer = setTimeout(() => res(null), wait_sec * 1000); })]);
    clearTimeout(timer);
    out.result = r || { ok: null, message: `Still waiting after ${wait_sec}s; call account to check.` };
    return text(out);
  }),
);

server.tool(
  'logout',
  'Sign out of Raspberry Pi Connect. The session and Chrome profile are moved to a backup folder ' +
    '(old-account_<time>) so the account can be restored, or deleted with delete=true.',
  { delete: z.boolean().default(false).describe('Delete the session instead of backing it up') },
  wrap(async ({ delete: del }) => {
    await connect.reset();
    return text(await logout({ del }));
  }),
);

const shutdown = async () => { await connect.shutdown(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
