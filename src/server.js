#!/usr/bin/env node
// MCP server exposing Raspberry Pi Connect remote shells.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Connect } from './connect.js';

const connect = new Connect();
const server = new McpServer({ name: 'rpi-connect', version: '0.1.0' });

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

const shutdown = async () => { await connect.shutdown(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
