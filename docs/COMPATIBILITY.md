# Compatibility

`opencode-kiro` `0.5.0-beta.7` is built and tested against OpenCode 2 stable
`2.0.20`. This file records the pins; the same values are asserted against
`package.json` by `test/scaffold.test.ts`.

## Tested OpenCode release

| Item | Value |
|---|---|
| Tested OpenCode commit (`v2.0.20` tag) | `84c9be93a56304a108f1a22df0c5d62c26d5b6ca` |
| Package version | `0.5.0-beta.7` |

Beta.7 targets OpenCode 2 stable 2.0.x with the provider-domain plugin contract and
`@opencode/cli@2.0.20` as the reference host. Older hosts, including the former-scope
CLI build `0.0.0-beta-19271`, are not supported; use `opencode-kiro@0.5.0-beta.5`
there. There is no `engines.opencode` constraint.

## Exact pins (v2-sensitive dependencies)

| Package | Pinned version | Where |
|---|---|---|
| `@opencode/plugin` | `2.0.20` | devDependencies (exact; types and tests only); no peer dependency, tested on 2.0.20 |
| `@opentui/solid` | `0.5.12` | dependencies (exact; bundler-external, never bundled) |
| `solid-js` | `1.9.12` | dependencies (exact; bundler-external, never bundled) |
| `kiro-acp-ai-provider` | `3.3.0` | dependencies (exact) |

## Development pins and host compatibility

The exact development pin `@opencode/plugin` `2.0.20` is for types and tests only.
No peer dependency is declared because the host supplies the plugin API at runtime.
Beta.7 targets OpenCode 2 stable 2.0.x and is tested on 2.0.20;
later releases are not guaranteed to work.
`@opentui/solid` peers an exact `solid-js` version, so both stay pinned;
`kiro-acp-ai-provider` also keeps an exact dependency pin. No dist-tags or
`^`/`~`/`*` specifiers are used for these packages.

OpenTUI 0.5.12 (`@opentui/core`, pulled in by the OpenCode 2.0.20 host floor)
declares `node >=26.4.0`. An installer with `engine-strict` enabled refuses it
on an older Node version.

## Host contract

Discovery registers `provider.transform` and requests `provider.reload`; it does not
use the removed catalog domain or register a model transform. The host discovers
the TUI from the package's `./tui` export, so one `plugins` entry loads both halves.
For local development, configure the absolute built `dist/` directory instead;
the host resolves its `server.js` and `tui.js` entrypoints.

Options are honored for configured plugins from npm specs and local directory
specs. Bundled or built-in loads receive `{}` and use the defaults. Host variant
generation uses the package-keyed protocol map in `packages/core/src/variant.ts`,
which has no Kiro or generic `aisdk:` entry; runtime effort enrichment stays with
the plugin.

## Verifying your install

1. Pin the plugin spec in your OpenCode config so the host cannot auto-refresh it:

   ```json
   { "plugins": ["opencode-kiro@0.5.0-beta.7"] }
   ```

2. Check the host version with `opencode --version` (or the executable your OpenCode
   2 host installs, such as `opencode2`). The reference package is `@opencode/cli@2.0.20`, which
   reports `opencode v2.0.20`. For a source-built host, run `git rev-parse HEAD`
   in its checkout and compare it with the `v2.0.20` tag commit above.
   Beta.7 targets OpenCode 2 stable 2.0.x, but later releases than the tested
   2.0.20 are not guaranteed to work.
3. Confirm the installed pins match this table:

   ```bash
   cd "${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/opencode-kiro@0.5.0-beta.7"
   npm ls kiro-acp-ai-provider @opentui/solid solid-js
   ```

   `npm ls` may report unrelated tree warnings; only the three version numbers matter.

If a dependency version differs, remove the cached plugin and reinstall with the exact spec.
See [CHANGELOG.md](../CHANGELOG.md) for what each release changed.
