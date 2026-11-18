// The release version is written in six fields across four files. This module finds them, checks
// them, and computes edits. Used by scripts/set-version.mjs and scripts/check-release.mjs (the
// release workflow's gate), so the two can never disagree about where the version lives.
import fs from 'node:fs';
import path from 'node:path';

// Releases are plain X.Y.Z: no pre-releases (npm would need a dist-tag, and the workflow has none).
export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// The McpServer declaration in src/server.js: single or double quotes, possibly over several lines,
// optional trailing comma. Groups: 3 = text up to the version's opening quote, 4 = version.
const SERVER_DECL = /(new McpServer\(\{\s*name:\s*(['"])rpi-connect\2,\s*version:\s*(['"]))([^'"]*)\3\s*,?\s*\}\)/g;

// A small JavaScript scanner. Returns `code`: `source` with every comment replaced by spaces (same
// length, so offsets still match), and `strings`: the [start, end) ranges of string, template and
// regex literals. It knows those literals, so a `//` inside 'https://…' or /a\/\// is not taken for
// a comment, and text inside a string is not taken for code.
export function scanSource(source) {
  const out = source.split('');
  const strings = [];
  let i = 0;
  let prev = ''; // last significant character, to tell a regex literal from division
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    const start = i;
    if (c === '/' && n === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      blank(start, i);
    } else if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      blank(start, i);
    } else if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < source.length && source[i] !== c) i += source[i] === '\\' ? 2 : 1;
      i++;
      strings.push([start, i]);
      prev = c;
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) {
      let inClass = false;
      i++;
      while (i < source.length && source[i] !== '\n' && (inClass || source[i] !== '/')) {
        if (source[i] === '\\') i++;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        i++;
      }
      i++;
      strings.push([start, i]);
      prev = '/';
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return { code: out.join(''), strings };
}

// The one live (not commented-out) McpServer declaration: { start, end, version, versionStart }.
// Throws when there is none or more than one, so neither the gate nor set-version can be fooled
// by an old constructor left in a comment or written inside a string.
export function serverDeclaration(source) {
  const { code, strings } = scanSource(source);
  // Matches in comments are gone from `code`; drop matches that start inside a string literal too
  // (e.g. const example = "new McpServer({ … })").
  const live = [...code.matchAll(SERVER_DECL)].filter((m) => !strings.some(([a, b]) => m.index > a && m.index < b));
  if (live.length !== 1) {
    throw new Error(`src/server.js: expected exactly one live McpServer declaration (new McpServer({ name: 'rpi-connect', version: '…' })), found ${live.length}`);
  }
  const m = live[0];
  const versionStart = m.index + m[1].length;
  return { start: m.index, end: m.index + m[0].length, version: m[4], versionStart };
}

const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8');

export function load(root) {
  const text = {
    'package.json': read(root, 'package.json'),
    'package-lock.json': read(root, 'package-lock.json'),
    'server.json': read(root, 'server.json'),
    'src/server.js': read(root, 'src/server.js'),
  };
  const json = {
    pkg: JSON.parse(text['package.json']),
    lock: JSON.parse(text['package-lock.json']),
    server: JSON.parse(text['server.json']),
  };
  return { root, text, ...json };
}

// The server.json package entry for this npm package: matched by type and name, never by position.
export function npmEntry(s) {
  const matches = (s.server.packages || []).filter((p) => p.registryType === 'npm' && p.identifier === s.pkg.name);
  if (matches.length !== 1) {
    throw new Error(`server.json: expected exactly one packages[] entry with registryType "npm" and identifier "${s.pkg.name}", found ${matches.length}`);
  }
  return matches[0];
}

export function fields(s) {
  const decl = serverDeclaration(s.text['src/server.js']);
  if (!s.lock.packages?.['']) throw new Error('package-lock.json: packages[""] missing');
  return [
    ['package.json version', s.pkg.version],
    ['package-lock.json version', s.lock.version],
    ['package-lock.json packages[""].version', s.lock.packages[''].version],
    ['server.json version', s.server.version],
    ['server.json npm package version', npmEntry(s).version],
    ['src/server.js McpServer version', decl.version],
  ];
}

// Problems that would make a release fail after npm has accepted the version. Empty = OK.
// `owner`: the GitHub account the workflow runs under (GITHUB_REPOSITORY_OWNER). GitHub OIDC login
// lets it publish only io.github.<owner>/… names, so check that before npm uses up the version.
export function releaseProblems(s, tag, owner) {
  const problems = [];
  let list = [];
  try { list = fields(s); } catch (e) { problems.push(e.message); }
  const v = s.pkg.version;
  if (!RELEASE_VERSION.test(String(v))) problems.push(`package.json version "${v}" is not a plain X.Y.Z release version`);
  for (const [name, value] of list) if (value !== v) problems.push(`${name} is "${value}", package.json says "${v}" (run: npm run set-version -- ${v})`);
  if (s.pkg.mcpName !== s.server.name) problems.push(`package.json mcpName "${s.pkg.mcpName}" differs from server.json name "${s.server.name}"; the MCP Registry would reject it`);
  if (owner && !String(s.server.name).startsWith(`io.github.${owner}/`)) {
    problems.push(`server.json name "${s.server.name}" is not in the io.github.${owner}/ namespace that this repository's GitHub OIDC login may publish to`);
  }
  if (tag !== undefined) {
    if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) problems.push(`tag "${tag}" is not vX.Y.Z (pre-release tags are not published)`);
    else if (tag !== `v${v}`) problems.push(`tag "${tag}" does not match package.json version ${v}`);
  }
  return problems;
}

// New contents of all four files with the version set to `version`. Throws before anything is
// written if any field can't be found, so a failed run leaves the checkout unchanged.
export function withVersion(s, version) {
  if (!RELEASE_VERSION.test(version)) throw new Error(`"${version}" is not a plain X.Y.Z version (e.g. 0.2.1)`);
  fields(s); // validates that every field exists and the npm entry is unambiguous
  const json = (o) => JSON.stringify(o, null, 2) + '\n';
  const pkg = structuredClone(s.pkg);
  const lock = structuredClone(s.lock);
  const server = structuredClone(s.server);
  pkg.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  server.version = version;
  npmEntry({ ...s, server }).version = version;
  const src = s.text['src/server.js'];
  const decl = serverDeclaration(src);
  const newSrc = src.slice(0, decl.versionStart) + version + src.slice(decl.versionStart + decl.version.length);
  return {
    'package.json': json(pkg),
    'package-lock.json': json(lock),
    'server.json': json(server),
    'src/server.js': newSrc,
  };
}
