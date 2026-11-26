// Run with: node --experimental-vm-modules --test test/connect.test.js
// run()'s keystrokes are checked against a real bash; the browser is not needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const win = {}; // the page's window, for run() against a fake page
let context;
async function loadConnect() {
  context = vm.createContext({ URL, console, process: { env: {} }, window: win });
  const module = new vm.SourceTextModule(fs.readFileSync(new URL('../src/connect.js', import.meta.url), 'utf8'), { context });
  await module.link((name) => {
    const exports = {
      'node:fs': { default: { statSync: () => ({ mtimeMs: 1 }) } },
      './browser.js': { CONNECT_URL: 'https://connect.raspberrypi.com', SESSION_FILE: '/fake/session', launch: async () => { throw new Error('no browser'); } },
    }[name];
    assert.ok(exports, `Unexpected dependency: ${name}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [k, v] of Object.entries(exports)) this.setExport(k, v);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

const { commandInput, scanOutput, Connect } = await loadConnect();
const bash = (input, args = []) => {
  const r = spawnSync('bash', ['--norc', '--noprofile', ...args], { input, encoding: 'utf8', cwd: '/tmp' });
  return r.stdout + r.stderr;
};

test('the end marker is not swallowed by a command that reads the terminal', () => {
  // The old keystrokes: the end marker as a second line, which read (like sudo) consumed.
  const old = ` printf '\\n__RPS_%s__\\n' a1; read -r x; echo "got:$x"\n printf '\\n__RPE_%s_%s__\\n' a1 $?\n`;
  assert.equal(scanOutput(bash(old), 'a1'), null);

  const out = bash(commandInput('a1', 'read -r x; echo "got:$x"') + 'next line\n');
  assert.deepEqual({ ...scanOutput(out, 'a1') }, { exitCode: 0 });
  assert.match(out, /got:next line/);
});

test('exit code, cwd and variables carry over, as in a shell', () => {
  const out = bash(commandInput('b1', 'cd /; V=7; false') + commandInput('b2', 'echo "$PWD $V"'));
  assert.equal(scanOutput(out, 'b1').exitCode, 1);
  assert.equal(scanOutput(out, 'b2').exitCode, 0);
  assert.match(out, /__RPS_b2__\n\/ 7\n/);
});

test('heredocs, trailing comments and empty commands', () => {
  const out = bash(commandInput('c1', "cat <<'EOF'\nhello\nEOF") + commandInput('c2', 'echo hi # note') + commandInput('c3', '  '));
  assert.match(out, /__RPS_c1__\nhello\n/);
  assert.match(out, /__RPS_c2__\nhi\n/);
  for (const n of ['c1', 'c2', 'c3']) assert.equal(scanOutput(out, n).exitCode, 0);
});

test('a syntax error ends the command instead of waiting for a marker that never comes', () => {
  const out = bash(commandInput('d1', 'echo ('), ['-i']);
  assert.doesNotMatch(out, /__RPE_d1_/);
  assert.deepEqual({ ...scanOutput(out, 'd1') }, { exitCode: 2, syntaxError: true });
  // As a terminal delivers it, after readline turns bracketed paste off.
  const term = '$  { echo (\r\n\x1b[?2004l\rbash: syntax error near unexpected token `newline\'';
  assert.equal(scanOutput(term, 'd1'), null); // the line is not complete yet
  assert.equal(scanOutput(`${term}\r\n`, 'd1').exitCode, 2);
  assert.equal(scanOutput('bash: -c: line 1: syntax error near x\n', 'd1'), null); // a script's error, not the shell's
});

test('offline devices fail at once after a fresh list; the remote shell flag does not block', async () => {
  const connect = new Connect();
  let lists = 0;
  const devices = [
    { id: 'u1', name: 'Pi Off', online: false, remoteShell: true, lastSeen: '2 days ago' },
    { id: 'u2', name: 'Pi Renamed', online: true, remoteShell: false },
  ];
  connect.stamp = 1; // the session file's stamp, so resolve() keeps the cache
  connect.devicesCache = devices;
  connect.listDevices = async () => { lists++; connect.devicesCache = devices; return devices; };
  connect.context = async () => { throw new Error('browser reached'); };
  await assert.rejects(connect.session('Pi Off'), /Pi Off is offline \(last seen: 2 days ago\)/);
  assert.equal(lists, 1);
  await assert.rejects(connect.session('Pi Renamed'), /browser reached/); // it goes on to open the shell
  assert.equal(lists, 1);
});

test('text that looks like a syntax error, printed by the command, does not end it', () => {
  const raw = '\r\n__RPS_e1__\r\nbash: syntax error near unexpected token `x\'\r\nstill running';
  assert.equal(scanOutput(raw, 'e1'), null);
  assert.equal(scanOutput(`${raw}\r\n__RPE_e1_0__\r\n`, 'e1').exitCode, 0);
});

test('run returns the output of the snapshot that showed the end, even if the buffer is trimmed after', async () => {
  win.__out = 'x'.repeat(50);
  win.__term = { input(d) {
    const n = /__RPS_%s__\\n' (\w+);/.exec(d)?.[1];
    if (n) win.__out += `\r\n__RPS_${n}__\r\nhello\r\n__RPE_${n}_3__\r\n`;
  } };
  const page = {
    isClosed: () => false,
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => fn(arg),
    waitForFunction: async (expr) => {
      const value = vm.runInContext(expr, context);
      win.__out = win.__out.slice(-5); // the write hook trims the buffer before run reads it again
      return { jsonValue: async () => JSON.parse(JSON.stringify(value)) };
    },
  };
  const connect = new Connect();
  connect.session = async () => ({ page, name: 'Pi', queue: Promise.resolve(), seq: 0 });
  assert.deepEqual({ ...(await connect.run('Pi', 'echo hello')) }, { device: 'Pi', exitCode: 3, output: 'hello' });
});
