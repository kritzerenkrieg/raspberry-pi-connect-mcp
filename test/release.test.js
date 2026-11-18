// Release tooling: scripts/versions.mjs (used by set-version and the release workflow's gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, fields, releaseProblems, withVersion } from '../scripts/versions.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const FILES = ['package.json', 'package-lock.json', 'server.json', 'src/server.js'];

// A temporary copy of the four version files, edited by `edit(json, text)` before loading.
function fixture(t, edit = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpi-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  for (const f of FILES) fs.copyFileSync(path.join(repo, f), path.join(root, f));
  const json = Object.fromEntries(['package.json', 'package-lock.json', 'server.json'].map((f) => [f, JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'))]));
  const text = { 'src/server.js': fs.readFileSync(path.join(root, 'src/server.js'), 'utf8') };
  edit(json, text);
  for (const [f, j] of Object.entries(json)) fs.writeFileSync(path.join(root, f), JSON.stringify(j, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'src/server.js'), text['src/server.js']);
  return root;
}
const v = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

test('the repository passes its own release gate for its tag', () => {
  assert.deepEqual(releaseProblems(load(repo), `v${v}`), []);
  assert.equal(fields(load(repo)).length, 6);
});

for (const tag of ['0.2.0', 'v0.2', 'v0.3.0-rc.1', 'v01.2.3', `v${v}.1`]) {
  test(`gate rejects tag ${tag}`, () => {
    assert.match(releaseProblems(load(repo), tag).join('\n'), /is not vX\.Y\.Z/);
  });
}

test('gate rejects a tag for another version', () => {
  assert.match(releaseProblems(load(repo), 'v99.0.0').join('\n'), /does not match package.json version/);
});

test('gate checks the top-level package-lock.json version', (t) => {
  const root = fixture(t, (j) => { j['package-lock.json'].version = '0.0.1'; });
  assert.match(releaseProblems(load(root), `v${v}`).join('\n'), /package-lock.json version is "0.0.1"/);
});

test('gate checks the package-lock.json packages[""] version', (t) => {
  const root = fixture(t, (j) => { j['package-lock.json'].packages[''].version = '0.0.2'; });
  const problems = releaseProblems(load(root), `v${v}`);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /package-lock.json packages\[""\]\.version is "0.0.2"/);
});

test('gate finds the npm entry by type and name, not position', (t) => {
  const root = fixture(t, (j) => { j['server.json'].packages.unshift({ registryType: 'pypi', identifier: 'other', version: '9.9.9' }); });
  assert.deepEqual(releaseProblems(load(root), `v${v}`), []);
});

for (const [label, edit] of [
  ['missing', (j) => { j['server.json'].packages = [{ registryType: 'pypi', identifier: 'x', version: v }]; }],
  ['ambiguous', (j) => { j['server.json'].packages.push({ ...j['server.json'].packages[0] }); }],
]) {
  test(`gate rejects a ${label} npm entry in server.json`, (t) => {
    assert.match(releaseProblems(load(fixture(t, edit)), `v${v}`).join('\n'), /expected exactly one packages\[\] entry/);
  });
}

test('gate rejects an mcpName that differs from server.json name', (t) => {
  const root = fixture(t, (j) => { j['package.json'].mcpName = 'io.github.someone/else'; });
  assert.match(releaseProblems(load(root), `v${v}`).join('\n'), /mcpName .* differs from server.json name/);
});

test('withVersion sets all six fields', (t) => {
  const root = fixture(t);
  for (const [f, content] of Object.entries(withVersion(load(root), '1.2.3'))) fs.writeFileSync(path.join(root, f), content);
  assert.deepEqual(fields(load(root)).map(([, value]) => value), Array(6).fill('1.2.3'));
  assert.deepEqual(releaseProblems(load(root), 'v1.2.3'), []);
});

for (const bad of ['0.2.1-rc..1', '0.2.1-rc.1', '01.2.3', '1.2', 'v1.2.3', '']) {
  test(`withVersion rejects "${bad}"`, () => {
    assert.throws(() => withVersion(load(repo), bad), /is not a plain X\.Y\.Z version/);
  });
}

// Standalone src/server.js fixtures: independent of how the real file is formatted.
const server = (body) => (j, text) => { text['src/server.js'] = `import { McpServer } from 'x';\n${body}\nawait server.connect();\n`; };
const decl = (ver, q = "'") => `new McpServer({ name: ${q}rpi-connect${q}, version: ${q}${ver}${q} })`;
const readAll = (root) => FILES.map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
const setTo = (root, version) => {
  for (const [f, content] of Object.entries(withVersion(load(root), version))) fs.writeFileSync(path.join(root, f), content);
  return fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
};

test('withVersion throws before any write when the McpServer declaration is missing', (t) => {
  const root = fixture(t, server(`const server = new McpServer({ name: 'other', version: '${v}' });`));
  const before = readAll(root);
  assert.throws(() => withVersion(load(root), '1.2.3'), /expected exactly one live McpServer declaration .* found 0/);
  assert.deepEqual(readAll(root), before);
});

for (const [label, comment] of [['//', (d) => `// const server = ${d};`], ['/* */', (d) => `/* const server = ${d}; */`]]) {
  test(`gate and set-version ignore a ${label} commented-out declaration`, (t) => {
    const live = `const server = new McpServer({\n  name: "rpi-connect",\n  version: "${v}",\n});`;
    const root = fixture(t, server(`${comment(decl('0.0.1'))}\n${live}`));
    assert.deepEqual(releaseProblems(load(root), `v${v}`), []);
    const src = setTo(root, '1.2.3');
    assert.ok(src.includes(comment(decl('0.0.1'))), 'the comment is left alone');
    assert.ok(src.includes('  version: "1.2.3",\n});'), 'the live declaration is updated, keeping quotes and trailing comma');
    assert.deepEqual(releaseProblems(load(root), 'v1.2.3'), []);
  });
}

test('a // inside a string or regex on the same line is not a comment', (t) => {
  const root = fixture(t, server(`const url = 'https://example.com', re = /a\\/\\//; const server = ${decl(v)};`));
  assert.deepEqual(releaseProblems(load(root), `v${v}`), []);
  assert.ok(setTo(root, '1.2.3').includes(decl('1.2.3')));
});

test('a declaration in a line comment after the live one is ignored', (t) => {
  const root = fixture(t, server(`const server = ${decl(v, '"')}; // was ${decl('0.0.1')}`));
  assert.deepEqual(releaseProblems(load(root), `v${v}`), []);
  assert.ok(setTo(root, '1.2.3').includes(`${decl('1.2.3', '"')}; // was ${decl('0.0.1')}`));
});

test('gate rejects two live McpServer declarations', (t) => {
  const root = fixture(t, server(`const server = ${decl(v)};\nconst other = ${decl(v)};`));
  assert.match(releaseProblems(load(root), `v${v}`).join('\n'), /found 2/);
});

test('gate checks the registry namespace against the repository owner', () => {
  const s = load(repo);
  const owner = s.server.name.split('/')[0].replace(/^io\.github\./, '');
  assert.deepEqual(releaseProblems(s, `v${v}`, owner), []);
  assert.match(releaseProblems(s, `v${v}`, 'someone-else').join('\n'), /not in the io\.github\.someone-else\/ namespace/);
});

test('a declaration inside a string is not the live one', (t) => {
  // CodeRabbit's example: the string matches the other fields, the live constructor does not.
  const root = fixture(t, server(`const example = "${decl(v)}";\nconst server = new McpServer({ name: "rpi-connect", version: "0.1.0", });`));
  assert.match(releaseProblems(load(root), `v${v}`).join('\n'), /src\/server.js McpServer version is "0.1.0"/);
  const src = setTo(root, '1.2.3');
  assert.ok(src.includes(`const example = "${decl(v)}";`), 'the string is left alone');
  assert.ok(src.includes('version: "1.2.3", });'), 'the live constructor is updated');
});

test('a declaration inside a template literal is not the live one', (t) => {
  const root = fixture(t, server(`const doc = \`${decl('0.0.1')}\`;\nconst server = ${decl(v)};`));
  assert.deepEqual(releaseProblems(load(root), `v${v}`), []);
});
