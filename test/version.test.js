import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VERSION } from '../src/version.js';

test('src/version.js reads the version from package.json', () => {
  assert.equal(VERSION, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});
