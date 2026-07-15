# Contributing to opencode-kiro

Thanks for helping out. This is a small, single-maintainer plugin, so contributions stay lightweight and practical.

## Reporting bugs and requesting features

- Search [existing issues](https://github.com/NachoFLizaur/opencode-kiro/issues) first.
- Open a new issue using the templates:
  - **Bug report** for something broken. Include your opencode, kiro-cli, and opencode-kiro versions plus OS.
  - **Feature request** for an idea or enhancement.
- Blank issues are disabled, please pick a template.

## Dev setup

Requirements: Node.js `>= 20` and npm. A local `kiro-cli` install is needed to exercise the auth flow end to end.

```bash
git clone https://github.com/NachoFLizaur/opencode-kiro
cd opencode-kiro
npm install
```

## Build, test, typecheck

These map directly to the scripts in `package.json`:

```bash
npm run build       # tsup -> dist/server.js + dist/tui.js (+ d.ts)
npm test            # vitest run (single pass)
npm run test:watch  # vitest (watch mode)
npm run typecheck   # tsc --noEmit
```

Run `npm run typecheck` and `npm test` before opening a PR. All tests must pass.

## Running the plugin locally against opencode

Build first, then point opencode at your checkout by absolute path in both config files (`opencode.json` and `tui.json`), in the project's `.opencode/` dir or the global `~/.config/opencode/`:

```bash
npm run build
```

```json
{ "plugin": ["/absolute/path/to/opencode-kiro"] }
```

opencode resolves the correct entrypoint per file from the package `exports`. The `kiro` provider itself comes from the models.dev catalog, not this plugin, so a local checkout that wants to tests Kiro models not yet published in models.dev also needs a catalog that includes `kiro`. Point opencode at one with `OPENCODE_MODELS_PATH`:

```bash
OPENCODE_MODELS_PATH=/path/to/api.json opencode models | grep '^kiro/'
```

See the README's "Local development (path source)" section for the full details.

## Beware of stale plugin caches

opencode does not run your working copy directly. It resolves plugins from its package cache at `~/.cache/opencode/packages/<spec>` (honoring `$XDG_CACHE_HOME`). Bare or `@latest` specs are installed once and then frozen: opencode will not re-fetch them, so a newer publish or a local rebuild is not picked up until the cache entry is removed. When iterating locally:

- Prefer an absolute path source (`"plugin": ["/abs/path/to/opencode-kiro"]`) so there is no cache indirection, or pin an exact version and bump it on each change.
- If a stale build or a stale bundled `kiro-acp-ai-provider` is in use (symptom: `sdk.languageModel is not a function`), remove the cached copies and retry:

  ```bash
  rm -r "${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/opencode-kiro"
  rm -r "${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/kiro-acp-ai-provider"
  ```

- The TUI credits box and footer chip are resolved the same way from the `plugin` list in `tui.json`, so they are subject to the same caching.

## Verifying in a clean-room sandbox

To exercise auth, the model picker, reasoning effort, and the credits display without touching your real opencode config or first-run state, run opencode against an isolated XDG sandbox while keeping your real `HOME` (the `kiro-cli` login and its SSO token live under `~/.aws`, not under XDG, so they keep working):

```bash
SANDBOX="$(mktemp -d)"
export XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_DATA_HOME="$SANDBOX/data"
export XDG_STATE_HOME="$SANDBOX/state"
export XDG_CACHE_HOME="$SANDBOX/cache"
mkdir -p "$XDG_CONFIG_HOME/opencode"

# Point opencode at a catalog that includes the kiro provider if needed.
export OPENCODE_MODELS_PATH=/path/to/models.dev/packages/web/dist/_api.json

# Load the plugin by path (avoids cache indirection). The credits box and chip
# also require the plugin to be listed in tui.json.
echo '{"plugin":["/abs/path/to/opencode-kiro"]}' > "$XDG_CONFIG_HOME/opencode/tui.json"
```

Then build a standalone opencode and run it against the sandbox. Because `HOME` is untouched, `kiro-cli` auth still works; because XDG is sandboxed, opencode starts from a fresh, empty config, so you can verify first-run behavior (consent prompt, no stored credential, model gating).

Notes for macOS:

- There is no `timeout`. Wrap long-running probes with `perl -e 'alarm 30; exec @ARGV' -- <command>`.
- Copying the opencode binary invalidates its Bun single-file signature. Re-sign it with `codesign --force --sign - /path/to/opencode` before running.

## Pull requests

- Link an issue. Use `Fixes #123` or `Closes #123` in the description.
- Keep PRs small and focused. One logical change per PR.
- Include tests for new behavior and make sure `npm test` passes.
- Explain what changed and how you verified it (tests run, manual steps).
- Update the README if you change user-facing behavior.

## Commit and PR title style

Use conventional commit style for commit messages and PR titles. A clear title is usually enough, a long body is not required:

```
type: short summary
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.

Examples:

- `fix: handle auth path on Windows`
- `feat: surface credits unit in footer chip`
- `docs: clarify local development setup`

## Style

- Plain hyphens only. No em-dashes or en-dashes anywhere in code or docs.
- Match the existing code and README tone: terse and practical.
