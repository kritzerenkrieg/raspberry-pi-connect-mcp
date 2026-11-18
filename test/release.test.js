// Release tooling: scripts/versions.mjs (used by set-version and the release workflow's gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES, load, fields, releaseProblems, withVersion } from '../scripts/versions.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

// A temporary copy of the three version files, edited by `edit(json)` before loading.
function fixture(t, edit = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpi-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const f of FILES) fs.copyFileSync(path.join(repo, f), path.join(root, f));
  const json = Object.fromEntries(['package.json', 'package-lock.json', 'server.json'].map((f) => [f, JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'))]));
  edit(json);
  for (const [f, j] of Object.entries(json)) fs.writeFileSync(path.join(root, f), JSON.stringify(j, null, 2) + '\n');
  return root;
}
const v = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

test('the repository passes its own release gate for its tag', () => {
  assert.deepEqual(releaseProblems(load(repo), `v${v}`), []);
  assert.equal(fields(load(repo)).length, 5);
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

test('withVersion sets all five fields', (t) => {
  const root = fixture(t);
  for (const [f, content] of Object.entries(withVersion(load(root), '1.2.3'))) fs.writeFileSync(path.join(root, f), content);
  assert.deepEqual(fields(load(root)).map(([, value]) => value), Array(5).fill('1.2.3'));
  assert.deepEqual(releaseProblems(load(root), 'v1.2.3'), []);
});

for (const bad of ['0.2.1-rc..1', '0.2.1-rc.1', '01.2.3', '1.2', 'v1.2.3', '']) {
  test(`withVersion rejects "${bad}"`, () => {
    assert.throws(() => withVersion(load(repo), bad), /is not a plain X\.Y\.Z version/);
  });
}

test('withVersion throws before any write when a field is missing', (t) => {
  const root = fixture(t, (j) => { delete j['package-lock.json'].packages['']; });
  const before = FILES.map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
  assert.throws(() => withVersion(load(root), '1.2.3'), /packages\[""\] missing/);
  assert.deepEqual(FILES.map((f) => fs.readFileSync(path.join(root, f), 'utf8')), before);
});

test('gate checks the registry namespace against the repository owner', () => {
  const s = load(repo);
  const owner = s.server.name.split('/')[0].replace(/^io\.github\./, '');
  assert.deepEqual(releaseProblems(s, `v${v}`, owner), []);
  assert.match(releaseProblems(s, `v${v}`, 'someone-else').join('\n'), /not in the io\.github\.someone-else\/ namespace/);
});
