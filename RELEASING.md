# Releasing

A release is one GitHub release, `vX.Y.Z`. Publishing it starts
[`.github/workflows/release.yml`](.github/workflows/release.yml), which publishes that exact commit in
three jobs, each starting only if the previous one succeeded:

```
GitHub release vX.Y.Z ──► check         tag is vX.Y.Z; all five version fields = X.Y.Z; mcpName = server.json name;
                                        name in io.github.<repo owner>/
                                        mcp-publisher validate (the registry's own check of server.json)
                                        npm ci, npm test
                     ──► npm           npm lookup, then, right before publishing: MCP Registry check
                                        (no conflicting or deleted record), npm publish (trusted publishing + provenance)
                     ──► mcp-registry  server.json   (mcp-publisher, GitHub OIDC)
```

Every version published by this workflow has a git tag, a GitHub release and an npm provenance
record linking them. Older versions were published by hand (see section 4).
No npm token is stored anywhere: npm and the MCP Registry trust the workflow through GitHub OIDC.

- npm: <https://www.npmjs.com/package/raspberry-pi-connect-mcp>
- MCP Registry entry: `io.github.kritzerenkrieg/raspberry-pi-connect-mcp`

---

## 1. One-time setup

Do this once before the first automated release. Skip it if it is already done.

### 1.1 npm trusted publisher (required)

Without this, the `npm` job fails with `E404` or `ENEEDAUTH`.

> **Do this at most 2 days before the release.** npm expires a new trusted publisher configuration
> unless its first successful publish happens within 2 days. If it expired, delete it and create it
> again.

1. Sign in at <https://www.npmjs.com> as an owner of `raspberry-pi-connect-mcp`.
2. Open the package → **Settings**.
3. Under **Trusted Publisher**, choose **GitHub Actions** and enter:

   | Field | Value |
   |---|---|
   | Organization or user | `kritzerenkrieg` |
   | Repository | `raspberry-pi-connect-mcp` |
   | Workflow filename | `release.yml` (just the file name, not the path) |
   | Environment name | leave empty |
   | Allowed actions | tick **Allow npm publish** |

4. Save the connection.

**Allowed actions** matters: new configurations allow only `npm stage publish` by default, and the
workflow runs `npm publish`, which npm would then refuse.

Every field must match exactly, including case. If the workflow file is ever renamed, update it here too.

### 1.2 Lock down token publishing (recommended, after the first release works)

Once one release has gone through the workflow, go to the same **Settings** page, find
**Publishing access**, and choose **Require two-factor authentication and disallow tokens**.
Trusted publishing keeps working, and a leaked npm token can no longer publish this package.

### 1.3 GitHub

Nothing to configure. The workflow asks for `id-token: write` itself. The MCP Registry accepts the
`io.github.kritzerenkrieg/…` name because the workflow runs in the `kritzerenkrieg` repository.

The workflow pins its actions to commit SHAs (version in a comment) and checks the sha256 of the
`mcp-publisher` download. To update one, change the SHA (or version + checksum) in a PR.

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

Versions are plain `X.Y.Z`. Pre-release tags such as `v0.3.0-rc.1` are rejected by the `check` job
(npm would need a separate dist-tag for them), so nothing is published for them.

A version number can be published to npm only once, even if it is later unpublished.

### 2.2 Set the version on a branch

```
git switch main && git pull
git switch -c release/v0.2.1
npm ci                          # dependencies for the tests, from the lockfile
npm run set-version -- 0.2.1
node scripts/check-release.mjs v0.2.1   # the same gate the workflow runs
npm test
git commit -am "chore: release 0.2.1"
git push -u origin release/v0.2.1
```

`set-version` updates the five version fields across three files, and checks that it can find all
of them before writing any file. Each file is replaced atomically (temporary file, then rename), so a failed write (disk full, permissions) leaves
that file intact; it lists which files were already updated. Fix the cause and run the same command
again:

| File | Field |
|---|---|
| `package.json` | `version` |
| `package-lock.json` | `version` and `packages[""].version` |
| `server.json` | `version` and the npm package's `packages[].version` |

The version the MCP server reports is not a field: `src/version.js` reads it from `package.json` at
startup.

Do not edit these fields by hand. The `check` job refuses to publish if any of them differs from
the tag, if `package.json` `mcpName` differs from `server.json` `name`, or if `server.json` doesn't
have exactly one npm entry for this package.

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

Or open **Actions → Release**. It takes a few minutes. All three jobs should be green: `check`,
`npm`, `mcp-registry`.

### 2.6 Verify

```
npm view raspberry-pi-connect-mcp version                       # 0.2.1
npm view raspberry-pi-connect-mcp@0.2.1 gitHead                 # the release commit
npm view raspberry-pi-connect-mcp@0.2.1 dist.attestations.url   # set = provenance exists
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://registry.modelcontextprotocol.io/v0/servers/io.github.kritzerenkrieg%2Fraspberry-pi-connect-mcp/versions/0.2.1?include_deleted=true"   # 200
```

On the npm page, the version should show a **Provenance** section, "Built and signed on GitHub
Actions", linking to the commit and the workflow run.

To check that the published package starts, run
`npx -y raspberry-pi-connect-mcp@0.2.1 < /dev/null`. It should start and exit without an error.

---

## 3. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `check`: `… is "X", package.json says "Y" (run: npm run set-version -- Y)` | A version field was edited by hand | See **Fixing a release that failed in `check`** below |
| `check`: `tag "vX" does not match package.json version Y` | Release created with the wrong tag, or before the version PR was merged | Delete the release and tag (below), then create it again |
| `check`: `tag "…" is not vX.Y.Z` | A pre-release or malformed tag | Delete it; use a plain `vX.Y.Z` |
| `check`: `mcpName … differs from server.json name` | One of the two names was changed | Make them equal in a PR, then see **Fixing a release that failed in `check`** below |
| `check`: `server.json name … is not in the io.github.<owner>/ namespace` | `server.json` `name` (and `mcpName`) names another GitHub owner; the registry would refuse this repository's OIDC login for it | Use `io.github.kritzerenkrieg/…` in a PR, then see **Fixing a release that failed in `check`** below |
| `check`: `Validate server.json` fails | `server.json` breaks the registry's schema or rules (e.g. a missing `description`) | Fix `server.json` in a PR, then see **Fixing a release that failed in `check`** below |
| `npm`: `E404 Not Found - PUT` / `ENEEDAUTH` | Trusted publisher missing or expired, **Allow npm publish** not ticked, or a field doesn't match (workflow name, case) | Check 1.1, then **Re-run failed jobs** |
| `npm`: `unexpected npm view output '…'; publishing needs a confirmed E404` | `npm view` succeeded but didn't print the version (e.g. empty output) | Check by hand: `npm view raspberry-pi-connect-mcp@X version`. Re-run once it prints the version or fails with `E404` |
| `npm`: `could not check whether … is on npm; not publishing` | The npm registry lookup failed (network, outage) | **Re-run failed jobs** later. It never publishes without a confirmed answer |
| `npm`: `… is already on npm, published from commit '…', not this release's …` | The version was published from a different commit (by hand, or from another release) | Don't reuse the number: release the next patch version. npm users get the other commit's code for this version |
| `npm`: `… was published from <this commit> but its files differ from this checkout` | Someone published this version by hand from the release commit with uncommitted edits | npm can't replace it: deprecate it (below) and release the next patch version |
| `npm`: `could not compare … with this checkout (diff exit 2)` | The comparison itself failed (e.g. an unreadable file); nothing was published | **Re-run failed jobs**. If it keeps failing, inspect the published tarball (`npm pack raspberry-pi-connect-mcp@X`) |
| npm `E403 … cannot publish over the previously published versions` | The version appeared on npm between the lookup and the publish | Re-run failed jobs: the lookup then either skips it (same commit) or stops with the message above |
| npm provenance error about `repository` | `package.json` `repository.url` doesn't match this repo | It must stay `git+https://github.com/kritzerenkrieg/raspberry-pi-connect-mcp.git` |
| `mcp-registry`: a login/network error from `mcp-publisher` | MCP Registry or GitHub OIDC outage | **Re-run failed jobs**: only `mcp-registry` runs again; npm is not touched |
| `mcp-registry`: the registry rejects `server.json` | A rule `validate` doesn't cover (rare: `check` already ran it), e.g. the npm package's `mcpName` | A re-run sends the same file again, so it can't fix this. Fix it in a PR, bump to the next patch and release that (the npm version already published stays) |
| `npm` (preflight) or `mcp-registry`: `already in the MCP Registry with a different install configuration` | The version was published to the registry another way, with different `packages`/`remotes`. The log shows both sides | The registry can't replace it: release the next patch version. In the `npm` job this stops before npm publishes, so npm is untouched |
| `npm` (preflight) or `mcp-registry`: `Version … was deleted from the MCP Registry` | That version was published, then marked deleted; the registry won't take it again | Release the next patch version |
| `npm` (preflight) or `mcp-registry`: `MCP Registry lookup timed out` / `could not connect` / `… but the body could not be read` / `returned HTTP 429` or `5xx` | Timeout (30 s per attempt, body included), network error, a body that couldn't be read after HTTP 200 (connection closed early, broken encoding), rate limit or registry outage. These get up to 3 attempts | **Re-run failed jobs** later |
| `npm` (preflight) or `mcp-registry`: `MCP Registry lookup returned HTTP 200 with a body that is not valid JSON` | Something between the runner and the registry (proxy, captive page) or a registry bug answered instead | Open the lookup URL from 2.6 and look at what comes back before re-running |
| `npm` (preflight) or `mcp-registry`: `MCP Registry lookup returned HTTP` another code (e.g. `401`, `403`, `400`) | Not a transient failure, so it is not retried | Look up the status first (`curl -i` the lookup URL from 2.6). Re-run only once the cause is fixed |
| `mcp-registry`: sha256 mismatch | The `mcp-publisher` download changed | Don't bypass it. Check the upstream release, then update version and checksum in a PR |
| `npm test` fails in CI but passes locally | Different Node version (CI uses 24) | Reproduce with Node 24 and fix it on a branch. Nothing was published |

**Re-running:** open the failed run → **Re-run failed jobs**. GitHub re-runs only the failed job and
the ones after it, on the same commit and tag; jobs that already succeeded keep their result. Each
publish job also skips a version it confirms is already published. Re-running helps with *transient*
failures (outages, a missing npm setting). It can't fix anything in the release commit itself: for
that, fix it in a PR and release the next patch version.

**Fixing a release that failed in `check`:** nothing was published, but the tag still points at the
old commit, and merging a fix doesn't start a new run. After the fix is merged to `main`:

1. Delete the release and its tag: `gh release delete v0.2.1 --yes --cleanup-tag`.
2. Create the release again from `main` (2.4). That makes a new tag on the fixed commit and a new run.

The same version can be reused only if it has **never** been published anywhere. A failed `check`
job publishes nothing, so that holds unless the version was published some other way. Note that an
`E404` from `npm view` is not proof: a version that was published and then unpublished also returns
`E404`, and npm never accepts it again. So, before reusing the number:

- npm: `npm view raspberry-pi-connect-mcp time --json` must not list the version (this history
  normally keeps unpublished versions too), and you must not have published it by hand.
- MCP Registry: the lookup in 2.6 (it includes deleted versions) must print `404`.

If either has it, or you're unsure, release the next patch version instead.

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
