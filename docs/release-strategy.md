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
