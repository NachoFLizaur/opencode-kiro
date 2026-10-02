# Compatibility

`opencode-kiro` `0.5.0-beta.5` is built and tested against one pinned OpenCode v2
snapshot. This file is the single place that records the pins; the same values are
asserted against `package.json` by `test/scaffold.test.ts`.

## Tested OpenCode snapshot

| Item | Value |
|---|---|
| Tested OpenCode commit (`upstream/v2` head, 2026-08-29) | `8ba434b5973856b2f32b8cd3543e154b25c413e6` |
| Package version | `0.5.0-beta.5` |

There is no `engines.opencode` constraint: the v2 host has no stable semver yet, so
the tested commit is the compatibility target. Other v2 snapshots may or may not work.

## Exact pins (v2-sensitive dependencies)

| Package | Pinned version | Where |
|---|---|---|
| `@opencode/plugin` | `2.0.22` | devDependencies + peerDependencies (exact) |
| `@opentui/solid` | `0.5.14` | dependencies (exact; bundler-external, never bundled) |
| `solid-js` | `1.9.12` | dependencies (exact; bundler-external, never bundled) |
| `kiro-acp-ai-provider` | `3.2.0` | dependencies (exact) |

## Why the pins are exact

The OpenCode v2 plugin contract is still moving, and `@opencode-ai/plugin` ships on
the `dev` channel as CI builds of individual host commits. The version above is the
build of the tested commit; neighbouring builds can carry a different exports layout
or event set. `@opentui/solid` sets a hard peer floor on each release and peers a
single exact `solid-js` version, so both are pinned to the one combination the host
snapshot accepts. Dist-tags (`latest`, `next`, `beta`, `dev`) and range specifiers
(`^`, `~`, `*`) are never used for these four packages, because any of them can
silently resolve to a layout the plugin was not built against.

## Verifying your install

1. Pin the plugin spec in your OpenCode config so the host cannot auto-refresh it:

   ```json
   { "plugins": ["opencode-kiro@0.5.0-beta.5"] }
   ```

2. Check the OpenCode build you run against the tested commit above. `opencode
   --version` prints a build version, not a commit, so run `git rev-parse HEAD` in
   the checkout the opencode binary was built from. A build past the tested commit
   may have changed the plugin surface underneath this release.
3. Confirm the installed pins match this table:

   ```bash
   cd "${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/opencode-kiro@0.5.0-beta.5"
   npm ls kiro-acp-ai-provider @opentui/solid solid-js
   ```

   `npm ls` may report unrelated tree warnings; only the three version numbers matter.

If any value differs, remove the cached package and reinstall with the exact spec.
See [CHANGELOG.md](../CHANGELOG.md) for what each release changed.
