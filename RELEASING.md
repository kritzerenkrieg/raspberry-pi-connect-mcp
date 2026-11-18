# Releasing

A release is one GitHub release, `vX.Y.Z`. Publishing it starts
[`.github/workflows/release.yml`](.github/workflows/release.yml), which publishes that exact commit:

```
GitHub release vX.Y.Z ──► release.yml ──► 1. check every version field equals X.Y.Z
                                          2. npm ci, npm test
                                          3. npm publish        (trusted publishing + provenance)
                                          4. MCP Registry       (server.json, GitHub OIDC)
```

So every npm version has a git tag, a GitHub release and a provenance record that links them.
No npm token is stored anywhere: npm and the MCP Registry trust the workflow through GitHub OIDC.

- npm: <https://www.npmjs.com/package/raspberry-pi-connect-mcp>
- MCP Registry entry: `io.github.kritzerenkrieg/raspberry-pi-connect-mcp`

---

## 1. One-time setup

Do this once before the first automated release. Skip it if it is already done.

### 1.1 npm trusted publisher (required)

Without this, the "Publish to npm" step fails with `E404` or `ENEEDAUTH`.

1. Sign in at <https://www.npmjs.com> as an owner of `raspberry-pi-connect-mcp`.
2. Open the package → **Settings**.
3. Under **Trusted Publisher**, choose **GitHub Actions** and enter:

   | Field | Value |
   |---|---|
   | Organization or user | `kritzerenkrieg` |
   | Repository | `raspberry-pi-connect-mcp` |
   | Workflow filename | `release.yml` (just the file name, not the path) |
   | Environment name | leave empty |

4. Save the connection.

Every field must match exactly, including case. If the workflow file is ever renamed, update it here too.

### 1.2 Lock down token publishing (recommended, after the first release works)

Once one release has gone through the workflow, go to the same **Settings** page, find
**Publishing access**, and choose **Require two-factor authentication and disallow tokens**.
Trusted publishing keeps working, and a leaked npm token can no longer publish this package.

### 1.3 GitHub

Nothing to configure. The workflow asks for `id-token: write` itself. The MCP Registry accepts the
`io.github.kritzerenkrieg/…` name because the workflow runs in the `kritzerenkrieg` repository.

The `main-protection` ruleset still applies to the release PR: one approval and signed commits.
See step 2.3.

---

## 2. Making a release

### 2.1 Choose the version

Use [semver](https://semver.org). While the version is below 1.0:

| Change | Bump | Example |
|---|---|---|
| Bug fixes only | patch | `0.2.0` → `0.2.1` |
| New tools, options or behaviour, or anything that breaks | minor | `0.2.1` → `0.3.0` |

A version number can be published to npm only once, even if it is later unpublished.

### 2.2 Set the version on a branch

```
git switch main && git pull
git switch -c release/v0.2.1
npm run set-version -- 0.2.1
npm test
git commit -am "chore: release 0.2.1"
git push -u origin release/v0.2.1
```

`set-version` updates all five places the version is written:

| File | Field |
|---|---|
| `package.json` | `version` |
| `package-lock.json` | `version` and `packages[""].version` |
| `server.json` | `version` and the npm package's `packages[].version` |
| `src/server.js` | the version the MCP server reports |

Do not edit these fields by hand. The workflow refuses to publish if any of them differs from the tag.

### 2.3 Open and merge the PR

```
gh pr create --base main --title "Release 0.2.1" --body "Bump version to 0.2.1"
```

1. Wait for CodeRabbit's review and resolve any threads it opens.
2. Approve: comment `@coderabbitai approve` as a top-level PR comment, not as a reply in a thread.
   The ruleset dismisses an approval when new commits are pushed, so approve after the last push.
3. Merge with **Squash and merge**. The commits on the branch are unsigned and the ruleset requires
   signed commits, so tick **bypass rules** (you have the Repository admin bypass). The squash
   commit GitHub creates on `main` is signed by GitHub, so `main` stays all-signed.

   From the terminal: `gh pr merge --squash --admin --delete-branch`

### 2.4 Publish the GitHub release

This is the step that publishes. Make sure `main` has the merged version first.

```
git switch main && git pull
node -p 'require("./package.json").version'     # must print 0.2.1
gh release create v0.2.1 --target main --title "v0.2.1" --generate-notes
```

Or use the web UI: **Releases → Draft a new release** → choose tag → type `v0.2.1` → **Create new tag
on publish** → target `main` → **Generate release notes** → **Publish release**.

The tag is always `v` + the version (`v0.2.1`, not `0.2.1`).

### 2.5 Watch the workflow

```
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

Or open **Actions → Release**. It takes about a minute. All five steps should be green: version
check, `npm ci`, `npm test`, Publish to npm, Publish to the MCP Registry.

### 2.6 Verify

```
npm view raspberry-pi-connect-mcp version                       # 0.2.1
npm view raspberry-pi-connect-mcp@0.2.1 gitHead                 # the release commit
npm view raspberry-pi-connect-mcp@0.2.1 dist.attestations.url   # set = provenance exists
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.kritzerenkrieg/raspberry-pi-connect-mcp" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s).servers.forEach(x=>console.log((x.server||x).version)))'
```

On the npm page, the version should show a **Provenance** section, "Built and signed on GitHub
Actions", linking to the commit and the workflow run.

To check that the published package starts, run
`npx -y raspberry-pi-connect-mcp@0.2.1 < /dev/null`. It should start and exit without an error.

---

## 3. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `version fields differ; run: npm run set-version -- X` | A version field was edited by hand, or the bump missed a file | Fix it in a new PR (2.2–2.3), then see "re-release" below |
| `tag vX does not match package.json version Y` | Release created with the wrong tag, or before the version PR was merged | Delete the release and tag (below), then create it again |
| npm `E404 Not Found - PUT` / `ENEEDAUTH` | Trusted publisher missing, or a field doesn't match (wrong workflow name, case) | Check 1.1, then **Re-run failed jobs** |
| npm `E403 … cannot publish over the previously published versions` | That version is already on npm | Normally the step skips it. If you see this, the version was published another way: bump to the next patch |
| npm provenance error about `repository` | `package.json` `repository.url` doesn't match this repo | It must stay `git+https://github.com/kritzerenkrieg/raspberry-pi-connect-mcp.git` |
| MCP Registry step fails after npm succeeded | Registry outage, or `server.json` invalid for its schema | Fix `server.json` if needed, then **Re-run failed jobs**. The npm step skips the version that's already published |
| MCP Registry: `mcpName` mismatch | `package.json` `mcpName` ≠ `server.json` `name` | Both must be `io.github.kritzerenkrieg/raspberry-pi-connect-mcp` |
| `npm test` fails in CI but passes locally | Different Node version (CI uses 24) | Reproduce with Node 24 and fix it on a branch. Nothing was published |

**Re-running:** open the failed run → **Re-run failed jobs**. It re-runs the same commit and tag.
Steps that already published are skipped, so re-running is always safe.

**Deleting a release and tag**, for example after a wrong tag, *before* anything was published:

```
gh release delete v0.2.1 --yes --cleanup-tag
```

Then create it again (2.4). If npm already has the version, do not reuse the number: bump to the
next patch instead.

### Undoing a bad publish

- **npm:** within 72 hours, `npm unpublish raspberry-pi-connect-mcp@0.2.1` (needs your npm login),
  if nothing depends on it. The version number stays used. After that, or instead:
  `npm deprecate raspberry-pi-connect-mcp@0.2.1 "broken, use 0.2.2"`, then release a fixed `0.2.2`.
- **MCP Registry:** published versions can't be overwritten. Release a fixed patch version; the
  registry lists the latest version as current.

---

## 4. Version history

| Version | Tag | Commit | Published |
|---|---|---|---|
| 0.0.0-stage | none | none | npm only. A placeholder that reserved the name; npm recorded no commit |
| 0.1.0 | `v0.1.0` | `ee95810` | npm, by hand |
| 0.1.1 | `v0.1.1` | `17e5d95` | npm and MCP Registry, by hand |
| 0.2.0 | `v0.2.0` | | First release through `release.yml` |

Each tag points at the commit npm recorded as `gitHead` for that version.
