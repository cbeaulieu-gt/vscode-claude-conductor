# Contributing

## Prerequisites

- **Node.js** 20+ and **npm**
- **TypeScript** (installed as a dev dependency — no global install needed)
- **@vscode/vsce** (installed as a dev dependency — no global install needed)

## Running tests

See the [Testing section in the README](README.md#contributingdevelopment) for the
full setup. The short version:

```bash
npm install
npm test          # run all tests once (Vitest)
npm run test:watch  # watch mode during development
npm run lint        # typecheck (tsc --noEmit)
```

## Releasing

Releases follow the VS Code Marketplace odd/even minor convention for stable vs
pre-release channels. Read [`docs/release-strategy.md`](docs/release-strategy.md)
before cutting a release — in particular:

- Use `npm run publish:stable` or `npm run publish:prerelease` (never raw `vsce publish`).
- The channel guard (`scripts/guard-channel.js`) will abort the publish if the version
  minor parity does not match the target channel.

## Filing issues

Use [GitHub Issues](https://github.com/cbeaulieu-gt/vscode-claude-conductor/issues).
Please include your VS Code version, OS, and steps to reproduce.
