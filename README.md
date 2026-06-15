# opencode-kiro

The ACP-compliant [Kiro](https://kiro.dev) auth plugin for [opencode](https://opencode.ai).

opencode learns the `kiro` provider and its 12 models from the
[models.dev](https://models.dev) catalog, exactly like the first-party Copilot and
GitLab integrations. This plugin supplies the piece the catalog can't: the **auth**.

- **Auth** via the official `kiro-cli` login flow (`opencode auth login`, then "Kiro CLI Login")
- **Provider options loader**: the `cwd`, `agent`, `trustAllTools`, `mcpTimeout` values
  opencode forwards into the SDK factory
- **TUI credits display**: an opt-in sidebar context box showing tokens, context usage,
  and Kiro credits

The `kiro` provider resolves to [`kiro-acp-ai-provider`](https://www.npmjs.com/package/kiro-acp-ai-provider),
an AI-SDK provider that talks to your locally installed `kiro-cli` over Kiro's
[Agent Client Protocol](https://agentclientprotocol.com) (ACP); opencode picks it up from
the catalog's `npm` field. This is the supported integration path: requests go through
kiro-cli exactly like Kiro's own IDE clients, with no credential scraping and no reuse of
Kiro credentials against other providers.

Not affiliated with any other kiro-named npm packages.

## Prerequisites

| Requirement | Notes |
|---|---|
| [kiro-cli](https://kiro.dev/docs/cli/) | Must be installed and on `PATH`; a Kiro subscription / AWS Builder ID account |
| opencode `>= 1.16.0` | Enforced via `engines.opencode` on released builds. The shipped catalog must include the `kiro` provider (see [Troubleshooting](#troubleshooting)). |

## Install

```bash
opencode plugin opencode-kiro
```

(alias: `opencode plug opencode-kiro`; add `--global`/`-g` to install into your global config instead of the project)

The installer reads this package's `exports` and detects both plugin entrypoints
(`./server` and `./tui`), then patches **both** config files automatically:

- `.opencode/opencode.json`: the server plugin (auth)
- `.opencode/tui.json`: the TUI plugin (credits sidebar box)

(with `--global`: `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`)

You do **not** add a `provider.kiro` block; opencode loads the `kiro` provider and its
models straight from the models.dev catalog. Then disable the builtin context box, see
[Credits in the sidebar](#credits-in-the-sidebar).

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
  "plugin": ["opencode-kiro"],
  "plugin_enabled": { "internal:sidebar-context": false }
}
```

(`plugin_enabled` is the [credits sidebar](#credits-in-the-sidebar) step, recommended now, explained below.)

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
this package ships `{ id: "opencode-kiro", tui }`, so the id (and your
`plugin_enabled` keys) are identical across path and npm installs.

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

12 models, defined in the [models.dev](https://models.dev) `kiro` catalog entry. opencode
loads them from there; the table below is a convenience snapshot, not the source of
truth. All models support tool calling and have a 64K-token output limit.

| Model | ID | Context window | Image input |
|---|---|---|---|
| Auto | `auto` | 1,000,000 | yes |
| Claude Haiku 4.5 | `claude-haiku-4.5` | 200,000 | yes |
| Claude Opus 4.5 | `claude-opus-4.5` | 200,000 | yes |
| Claude Opus 4.6 | `claude-opus-4.6` | 1,000,000 | yes |
| Claude Opus 4.7 | `claude-opus-4.7` | 1,000,000 | yes |
| Claude Sonnet 4 | `claude-sonnet-4` | 200,000 | yes |
| Claude Sonnet 4.5 | `claude-sonnet-4.5` | 200,000 | yes |
| Claude Sonnet 4.6 | `claude-sonnet-4.6` | 1,000,000 | yes |
| Deepseek v3.2 | `deepseek-3.2` | 164,000 | yes |
| MiniMax M2.1 | `minimax-m2.1` | 196,000 | yes |
| MiniMax M2.5 | `minimax-m2.5` | 196,000 | no |
| Qwen3 Coder Next | `qwen3-coder-next` | 256,000 | yes |

```bash
opencode models           # lists kiro/auto, kiro/claude-sonnet-4.6, ...
opencode run -m kiro/auto "hello"
```

Image input is capability-driven: paste an image path into the TUI prompt and
image-capable models receive it as an attachment.

## Credits in the sidebar

Kiro is subscription-metered: requests consume **credits**, and the dollar cost
opencode normally displays is always $0.00. The plugin therefore registers a
**full replacement** for the built-in sidebar context box, showing tokens, context
percentage, and session credits.

Disable the builtin box in `tui.json` so only the replacement renders:

```json
{
  "plugin_enabled": { "internal:sidebar-context": false }
}
```

Without this you will see **two** context boxes (cosmetic duplication: the builtin
one plus the plugin's). The credits value and its unit come from provider metadata
emitted by the SDK (kiro-cli reports the unit); nothing is hardcoded client-side.

Trade-off: the replacement box applies to **every** session and disabling the builtin
is global: mixed-provider users lose the builtin `$X.XX spent` line for non-Kiro
sessions too; if you need dollar cost there, leave the builtin enabled at the cost of
the duplicate box.

## Known limitation (read this)

**Credits display is TUI-sidebar-only.** Every other cost surface (the prompt footer,
ACP clients, the web app, desktop, web share pages, and CLI cost output) shows $0.00
for Kiro sessions. The models.dev catalog declares Kiro's per-token `cost` as 0 (it is a
subscription-metered provider with no per-token pricing), so opencode core computes $0.00
everywhere it renders dollar cost. That is expected, not a defect. A cross-surface credits
display would require opencode core changes and is intentionally out of scope for this
plugin.

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
  an ephemeral session, detects prompt-history divergence (fork/`/undo`), and starts a
  fresh kiro session when needed. No host-side session plumbing.
- **Credits metadata**: the SDK attaches `{ kiro: { credits, creditsUnit } }` provider
  metadata to the final part of each turn; opencode persists it, and the TUI plugin
  sums it per assistant message (deduped across text/reasoning parts) for the sidebar.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `kiro-cli is not installed` during auth | Install kiro-cli from <https://kiro.dev/docs/cli/> and ensure it is on `PATH` for the opencode process. |
| Auth times out after ~120s | Complete the browser login faster, or run `kiro-cli login` yourself, then re-run `opencode auth login` (fast path). |
| Two "Context" boxes in the sidebar | Add `"plugin_enabled": { "internal:sidebar-context": false }` to `tui.json` (see [Credits in the sidebar](#credits-in-the-sidebar)). |
| No credits line / credits stay 0 | Credits appear after the first **completed** kiro turn; cancelled turns and turns without usage metadata contribute nothing. Check the TUI plugin is `active` in the Plugins dialog (and listed in `tui.json`). |
| `kiro` provider not showing in `opencode models` | The provider comes from the models.dev catalog, not this plugin. Ensure your opencode version ships a catalog that includes `kiro` (run `opencode models --refresh` to update the cache). For local development, point opencode at a kiro-inclusive catalog via `OPENCODE_MODELS_PATH=/path/to/api.json` (see [Local development](#local-development-path-source)). |
| `sdk.languageModel is not a function` | A stale `kiro-acp-ai-provider` < 2.0.0 resolved from opencode's package cache. Remove the cached copy (`$XDG_CACHE_HOME/opencode/packages/kiro-acp-ai-provider`, default `~/.cache/opencode/packages/...`) and retry; 2.0.0 fixed the factory auto-discovery clash. |
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

[MIT](./LICENSE)
