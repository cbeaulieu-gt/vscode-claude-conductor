# Release Strategy

## Why this convention exists

The VS Code Marketplace does not support semver pre-release suffixes (`1.2.0-beta.1`).
Versions must be plain `MAJOR.MINOR.PATCH`. The channel (stable vs pre-release) is
signalled at publish time via a flag — not encoded in the version string itself.

To make the channel unambiguous from the version number alone, we adopt Microsoft's
own odd/even minor convention.

## The odd/even minor rule

| Minor is… | Example  | Channel     | Publish command             |
|-----------|----------|-------------|-----------------------------|
| Even      | `1.2.x`  | Stable      | `npm run publish:stable`    |
| Odd       | `1.3.x`  | Pre-release | `npm run publish:prerelease` |

Examples of the parallel lanes:

```
1.0.x  stable      1.1.x  pre-release
1.2.x  stable      1.3.x  pre-release
1.4.x  stable      1.5.x  pre-release
2.0.x  stable      2.1.x  pre-release
```

## User opt-in mechanics

Stable-channel users **never** receive pre-release versions automatically.
Pre-release users must explicitly opt in via the Marketplace UI or the
`--pre-release` flag when installing. This means a pre-release publish cannot
accidentally break stable users.

## Monotonic version rule

Published versions must be monotonically increasing across **both** channels
combined. The marketplace enforces this globally — you cannot publish `1.3.0`
if `1.4.0` has already been published, regardless of channel. Plan your lane
jumps accordingly: always move forward.

## Versioning within a channel (same as semver)

| Change type      | What to bump          | Example               |
|------------------|-----------------------|-----------------------|
| Breaking change  | Major (reset minor/patch) | `1.4.2` → `2.0.0` |
| New feature      | Minor (stay in lane)  | `1.4.0` → `1.4.1` *(or bump to next even minor for a new stable cycle: `1.6.0`)* |
| Bug / patch fix  | Patch                 | `1.4.0` → `1.4.1`    |

When promoting a pre-release cycle to stable, increment to the next even minor:
`1.3.x` (pre-release) → `1.4.0` (stable).

## Publish commands

Never run `vsce publish` directly — always use the npm scripts, which run the
channel guard first:

```bash
npm run publish:stable      # even minor required
npm run publish:prerelease  # odd minor required
```

Both commands are defined in `package.json`:

```json
"publish:stable":    "node scripts/guard-channel.js stable && vsce publish",
"publish:prerelease":"node scripts/guard-channel.js prerelease && vsce publish --pre-release"
```

## The channel guard

`scripts/guard-channel.js` enforces parity before every publish.

It reads `version` from `package.json`, checks the minor parity, and:

- Exits **0** silently on match.
- Exits **1** with a descriptive error on mismatch, e.g.:

  ```
  Version 1.2.0 has EVEN minor (2) — cannot publish as pre-release.
  Bump to 1.3.0 first, or use `npm run publish:stable`.
  ```

- Exits **2** for an unknown channel argument.
- Exits **3** if `package.json` is missing or has no `version` field.

Unit tests live in `test/guard-channel.test.ts` and run with `npm test`.

## See also

[VS Code docs — Pre-release extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions)

---

## GitHub Actions secret setup

The publish workflow authenticates to the VS Code Marketplace using a Personal
Access Token stored as a repository secret. Follow these steps before pushing
the first release tag.

### Create an Azure DevOps PAT

1. Sign in to [dev.azure.com](https://dev.azure.com) with the publisher account
   (the account that owns the `cbeaulieu-gt` Marketplace publisher).
2. Open **User settings → Personal access tokens → New Token**.
3. Give the token a descriptive name, e.g. `vscode-marketplace-publish`.
4. Set **Organization** to **"All accessible organizations"** — `vsce` requires
   this; a single-organization PAT will be rejected at publish time.
5. Set an expiry (one year is a reasonable default).
6. Under **Scopes**, select **Marketplace → Publish** (and only that scope).
7. Click **Create** and copy the token immediately — you cannot retrieve it again.

### Add the secret to the repository

1. In the GitHub repo, go to **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**.
3. Name: `VSCE_PAT`
4. Value: the Azure DevOps PAT you copied above.
5. Click **Add secret**.

### PAT rotation

Rotate the PAT at least once a year (or immediately if it may have been
exposed). Recommended practice:

- Note the expiry date in a pinned issue or a calendar reminder set one week
  before expiry.
- When rotating: create the new PAT first, update the `VSCE_PAT` secret, then
  revoke the old PAT.

If the secret is missing, expired, or invalid the **Publish** step of the
workflow will fail loudly — this is intentional so a bad credential is surfaced
immediately rather than silently skipping the publish.

---

## Cutting a release

Follow these steps every time you publish a new version to the Marketplace.

1. **Merge all PRs** targeting the release into `main`.
2. **Pull latest `main`:**
   ```bash
   git pull --ff-only origin main
   ```
3. **Bump `version` in `package.json`:**
   - Even minor (e.g. `1.4.0`) → publishes to the **stable** channel.
   - Odd minor (e.g. `1.5.0`) → publishes to the **pre-release** channel.
   - If you are staying in the same minor lane, increment the patch instead
     (e.g. `1.3.0` → `1.3.1`).
4. **Update `CHANGELOG.md`:** move the `[Unreleased]` entries into a new
   versioned section with today's date:
   ```markdown
   ## [X.Y.Z] — YYYY-MM-DD
   ```
5. **Commit:**
   ```bash
   git commit -am "chore: bump to X.Y.Z"
   ```
6. **Push the commit:**
   ```bash
   git push origin main
   ```
7. **Create the tag:**
   ```bash
   git tag vX.Y.Z
   ```
8. **Push the tag:**
   ```bash
   git push origin vX.Y.Z
   ```
9. **Watch the workflow:** go to the **Actions** tab in the GitHub repo and
   open the **Publish** workflow run that triggered on the tag push. On success
   the workflow will:
   - Publish the extension to the VS Code Marketplace (stable or pre-release
     channel, determined automatically from the minor parity).
   - Create a GitHub Release for the tag using the matching CHANGELOG entry as
     the release notes.

### Manual-dispatch retry path

If the tag-triggered run fails due to a transient Marketplace error (e.g.
a momentary 5xx from the VS Code Marketplace API) you can re-trigger the
publish without pushing a new tag:

1. Go to **Actions → Publish workflow → Run workflow**.
2. Enter the existing tag in the **Tag to publish** input (e.g. `v1.3.0`).
3. Click **Run workflow**.

The workflow checks out that tag, runs the full lint/test/compile pipeline, and
publishes exactly as the automatic run would have.
