// The release version is written in five fields across three files. (src/server.js has none: it
// reads package.json at startup, see src/version.js.) This module finds them, checks them, and
// computes edits. Used by scripts/set-version.mjs and scripts/check-release.mjs (the release
// workflow's gate), so the two can never disagree about where the version lives.
import fs from 'node:fs';
import path from 'node:path';

// Releases are plain X.Y.Z: no pre-releases (npm would need a dist-tag, and the workflow has none).
export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const FILES = ['package.json', 'package-lock.json', 'server.json'];

export function load(root) {
  const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
  return { root, pkg: read('package.json'), lock: read('package-lock.json'), server: read('server.json') };
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
  if (!s.lock.packages?.['']) throw new Error('package-lock.json: packages[""] missing');
  return [
    ['package.json version', s.pkg.version],
    ['package-lock.json version', s.lock.version],
    ['package-lock.json packages[""].version', s.lock.packages[''].version],
    ['server.json version', s.server.version],
    ['server.json npm package version', npmEntry(s).version],
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

// New contents of the three files with the version set to `version`. Throws before anything is
// written if any field can't be found, so a failed validation leaves the checkout unchanged.
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
  return { 'package.json': json(pkg), 'package-lock.json': json(lock), 'server.json': json(server) };
}
