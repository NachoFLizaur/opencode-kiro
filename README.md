# opencode-kiro

The ACP-compliant [Kiro](https://kiro.dev) auth plugin for [opencode](https://opencode.ai).

opencode learns the `kiro` provider and its available models (US region) from the
[models.dev](https://models.dev) catalog. This plugin supplies the following pieces:

- **Auth** via the official `kiro-cli` login flow (`opencode auth login`, then "Kiro CLI Login")
- **Provider options loader**: the `cwd`, `agent`, `trustAllTools`, `mcpTimeout` values
  opencode forwards into the SDK factory
- **TUI credits display**: an opt-in Kiro credits box in the sidebar (appended below the
  native Context box) plus a matching footer credits chip

The `kiro` provider resolves to [`kiro-acp-ai-provider`](https://www.npmjs.com/package/kiro-acp-ai-provider),
an AI-SDK provider that talks to your locally installed `kiro-cli` over Kiro's
[Agent Client Protocol](https://agentclientprotocol.com) (ACP); opencode picks it up from
the catalog's `npm` field. This is the supported integration path: requests go through
kiro-cli exactly like Kiro's own IDE clients, with no credential scraping and no reuse of
Kiro credentials against other providers.

## Prerequisites

| Requirement | Notes |
|---|---|
| [kiro-cli](https://kiro.dev/docs/cli/) | Must be installed and on `PATH`; a Kiro subscription / AWS Builder ID account |
| [Node.js](https://nodejs.org) `>= 20` | Enforced via `engines.node`. |
| opencode `>= 1.16.0` | Enforced via `engines.opencode` on released builds. The shipped catalog must include the `kiro` provider (see [Troubleshooting](#troubleshooting)). |

## Install

```bash
opencode plugin opencode-kiro
```

(alias: `opencode plug opencode-kiro`; add `--global`/`-g` to install into your global config instead of the project)

The installer reads this package's `exports` and detects both plugin entrypoints
(`./server` and `./tui`), then patches **both** config files automatically:

- `.opencode/opencode.json`: the server plugin (auth)
- `.opencode/tui.json`: the TUI plugin (credits sidebar box + footer chip)

(with `--global`: `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`)

You do **not** add a `provider.kiro` block; opencode loads the `kiro` provider and its
models straight from the models.dev catalog. See
[Credits in the sidebar](#credits-in-the-sidebar) for what the TUI plugin adds.

### Manual alternative

Add the package name to the `plugin` array of **both** files yourself (in the
project's `.opencode/` directory, at the project root, or in the global
`~/.config/opencode/`, all are valid config locations):

`opencode.json`:

```json
{
  "plugin": ["opencode-kiro"]
}
```

`tui.json`:

```json
{
  "plugin": ["opencode-kiro"]
}
```

That single `plugin` entry is all the [credits sidebar](#credits-in-the-sidebar) box and
footer chip need; there is no `plugin_enabled` step.

### Local development (path source)

Run a local checkout without npm: build first, then reference the repo directory by
absolute path in both `plugin` arrays:

```bash
git clone https://github.com/NachoFLizaur/opencode-kiro && cd opencode-kiro
npm install && npm run build
```

```json
{ "plugin": ["/absolute/path/to/opencode-kiro"] }
```

opencode resolves the right entrypoint per file from the package `exports`. Note that
path-sourced TUI plugins **must export an `id`** (opencode rejects them otherwise);
this package ships `{ id: "opencode-kiro", tui }`, so the id is identical across path
and npm installs.

Because the provider now comes from the catalog rather than the plugin, a local checkout
also needs a catalog that includes `kiro`. opencode reads its catalog from
`OPENCODE_MODELS_PATH` when set; point it at an `api.json` that contains the `kiro`
provider (for example one generated from a [models.dev](https://models.dev) checkout):

```bash
OPENCODE_MODELS_PATH=/path/to/api.json opencode models | grep '^kiro/'
```

Until the catalog opencode loads contains `kiro`, the provider will not appear regardless
of this plugin being installed (the plugin only adds auth, not the provider definition).

## Auth

```bash
opencode auth login
```

Select the **Kiro (plugin)** provider, then the **Kiro CLI Login** method:

- **Already logged in to kiro-cli**: immediate success; the existing kiro-cli session is reused.
- **Not logged in**: the plugin launches `kiro-cli login`, which opens a browser window.
  Complete the login there; the plugin polls for up to 120 seconds and stores the
  credential when kiro-cli reports success.

If the flow times out, authenticate directly with kiro-cli (`kiro-cli login`) and run
`opencode auth login` again; the fast path then completes immediately.

> **Note:** opencode will also surface `kiro` if the `KIRO_API_KEY` environment variable
> is set, because the catalog entry declares `env: ["KIRO_API_KEY"]`. The intended auth
> path for this plugin is still **Kiro CLI Login** above (it reuses your local kiro-cli
> session); the env var is a secondary route opencode offers for any catalog provider.

## Models

This plugin supports all models in the US region, defined in the [models.dev](https://models.dev) `kiro`
catalog entry. opencode loads them from there. List them with:
```bash
opencode models           # lists kiro/auto, kiro/claude-opus-4.8, ...
opencode run -m kiro/auto "hello"
```

Image input is capability-driven: paste an image path into the TUI prompt and
image-capable models receive it as an attachment.

### Reasoning effort

Effort-capable models expose a reasoning-effort toggle: cycle it in opencode with the
**Cycle model variants** action (default keybind `ctrl+t`). It is **per model**, showing
each family's native levels:

- `claude-opus-4.8`, `claude-opus-4.7`: low / medium / high / xhigh / max
- `claude-opus-4.6`, `claude-sonnet-4.6`: low / medium / high / max

Models without effort control (opus-4.5, sonnet-4.5, haiku, deepseek, glm, qwen, minimax)
show no effort option. opencode's **Default** (unset) returns the model to its native
default effort. No config is required: the plugin's `provider.models` hook supplies the
variants automatically and the chosen level flows to the SDK as
`providerOptions.kiro.reasoningEffort`. Kiro cannot disable thinking, so even the lowest
level still produces a reasoning trail.

## Credits in the sidebar

Kiro is subscription-metered: requests consume **credits**, and the dollar cost
opencode normally displays for Kiro turns is always $0.00. To surface credits the
plugin **appends** a small Kiro credits box in the sidebar, rendered right below the
native **Context** box. It does **not** replace or disable any builtin section: the
native Context box stays and keeps showing the usual tokens, context percentage, and
cost.

The credits box renders only for Kiro sessions; for a non-Kiro session it shows nothing,
so that session's sidebar is unchanged. The credits value and its unit come from the
metadata the SDK attaches to each message part (kiro-cli reports the unit); nothing is
hardcoded client-side.

All you need in `tui.json` is the plugin entry:

```json
{
  "plugin": ["opencode-kiro"]
}
```

There is no `plugin_enabled` step anymore.

### Migrating from 0.2.1 and earlier

Older versions replaced the native Context box with a clone and disabled the builtin via:

```json
{
  "plugin_enabled": { "internal:sidebar-context": false }
}
```

If you upgraded from 0.2.1 or earlier and still have that line in your `tui.json`,
remove it yourself: the plugin no longer manages `plugin_enabled`. Once the line is
gone the native Context box returns and shows the usual tokens / context % / cost, and
the Kiro credits box appears in a separate box right below it.

## Known limitation

**Credits render in the TUI only.** Two TUI surfaces show them: the sidebar credits
box (above) and the input/prompt meta row chip (`session_prompt_right`), which sits
above the host's `$` cost chip. Every other cost surface (ACP clients, the web app,
desktop, web share pages, and CLI cost output) shows $0.00 for Kiro sessions. The
models.dev catalog declares Kiro's per-token `cost` as 0 (it is a subscription-metered
provider with no per-token pricing), so opencode core computes $0.00 everywhere it
renders dollar cost. That is expected, not a defect. A cross-surface credits display
would require opencode core changes and is intentionally out of scope for this plugin.

## How it works

- **Provider & models (models.dev)**: opencode loads the `kiro` provider and its full
  model list from the models.dev catalog. This plugin does **not** define any provider or
  model config of its own; there is no `config` hook.
- **SDK resolution (resolveSDK)**: opencode reads the catalog's `npm` field
  (`kiro-acp-ai-provider`), installs that package into its package cache on first model
  use, and imports it. This plugin's `auth` loader supplies the provider options
  (`cwd`, `agent`, `trustAllTools`, `mcpTimeout`, `contextWindows`) that opencode forwards
  into `createKiroAcp(...)`. The loader relays each model's `limit.context` (from
  models.dev, via opencode's resolved catalog) into the SDK's `contextWindows` map keyed
  by `api.id`, so the SDK keeps no hardcoded per-model data and falls back to 1,000,000
  for any model absent from the relay.
- **Auth (this plugin)**: registers the "Kiro CLI Login" OAuth method (kiro-cli login
  flow) plus the options loader above. The same plugin also imports `verifyAuth` from
  `kiro-acp-ai-provider` to check kiro-cli installation/login state.
- **Session affinity & reset (in-SDK)**: the SDK keys kiro-cli sessions off opencode's
  `x-session-affinity` header, isolates tool-less utility calls (title generation) on
  an ephemeral session, detects prompt-history divergence (`fork/undo`), and starts a
  fresh kiro session when needed. No host-side session plumbing.
- **Credits metadata**: the SDK attaches `{ kiro: { credits, creditsUnit } }` to the
  `metadata` of the final message part of each turn; opencode persists it, and the TUI
  plugin sums it per assistant message (deduped across text/reasoning parts) for the sidebar.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `kiro-cli is not installed` during auth | Install kiro-cli from <https://kiro.dev/docs/cli/> and ensure it is on `PATH` for the opencode process. |
| Auth times out after ~120s | Complete the browser login faster, or run `kiro-cli login` yourself, then re-run `opencode auth login` (fast path). |
| No credits line / credits stay 0 | Credits appear after the first **completed** kiro turn; cancelled turns and turns without usage metadata contribute nothing. Check the TUI plugin is `active` in the Plugins dialog (and listed in `tui.json`). |
| Credits box never appears (even with `tui.json` configured correctly) | The TUI credits box renders only when `opencode-kiro` is resolvable in opencode's package cache. If the package is missing from the cache the box silently does not appear. Fix: ensure `opencode-kiro` is installed so it resolves in the cache. Do **not** manually clear the package cache: clearing can trigger a flaky on-demand refetch that fails with an "unknown git error". |
| `kiro` provider not showing in `opencode models` | The provider comes from the models.dev catalog, not this plugin. Ensure your opencode version ships a catalog that includes `kiro` (run `opencode models --refresh` to update the cache). For local development, point opencode at a kiro-inclusive catalog via `OPENCODE_MODELS_PATH=/path/to/api.json` (see [Local development](#local-development-path-source)). |
| `sdk.languageModel is not a function` | A stale `kiro-acp-ai-provider` from before the 2.0.x line resolved from opencode's package cache. Remove the cached copy (`$XDG_CACHE_HOME/opencode/packages/kiro-acp-ai-provider`, default `~/.cache/opencode/packages/...`) and retry; the factory auto-discovery clash was fixed in the 2.0.x line, and this plugin currently pins 2.0.2. |
| Path install rejected (`must export id`) | Run `npm run build` in your checkout first and reference the repo root (both entry modules export ids). |
| Provider visible but runs fail | The provider is selectable (from the catalog) before any credential exists. Run `opencode auth login` first. |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup builds dist/server.js + dist/tui.js (+ d.ts)
npm test            # vitest
```

## License

[MIT](./LICENSE) © Nacho F. Lizaur
