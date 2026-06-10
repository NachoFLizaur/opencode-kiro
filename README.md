# opencode-kiro

The ACP-compliant [Kiro](https://kiro.dev) plugin for [opencode](https://opencode.ai).

A complete, fully external integration — zero opencode core changes:

- **Auth** via the official `kiro-cli` login flow (`opencode auth login` → "Kiro CLI Login")
- **Provider** with 12 Kiro models (Claude, Deepseek, MiniMax, Qwen — see [Models](#models))
- **TUI credits display** — a sidebar context box showing tokens, context usage, and Kiro credits

The plugin is built on [`kiro-acp-ai-provider`](https://www.npmjs.com/package/kiro-acp-ai-provider),
an AI-SDK provider that talks to your locally installed `kiro-cli` over Kiro's
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). This is the supported
integration path: requests go through kiro-cli exactly like Kiro's own IDE clients —
no credential scraping, no reuse of Kiro credentials against other providers.

Not affiliated with any other kiro-named npm packages.

## Prerequisites

| Requirement | Notes |
|---|---|
| [kiro-cli](https://kiro.dev/docs/cli/) | Must be installed and on `PATH`; a Kiro subscription / AWS Builder ID account |
| opencode `>= 1.16.0` | Enforced via `engines.opencode` on released builds (floor justification in [PUBLISH_CHECKLIST.md](./PUBLISH_CHECKLIST.md)) |

## Install

```bash
opencode plugin opencode-kiro
```

(alias: `opencode plug opencode-kiro`; add `--global`/`-g` to install into your global config instead of the project)

The installer reads this package's `exports` and detects both plugin entrypoints
(`./server` and `./tui`), then patches **both** config files automatically:

- `.opencode/opencode.json` — the server plugin (auth + provider)
- `.opencode/tui.json` — the TUI plugin (credits sidebar box)

(with `--global`: `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`)

### Manual alternative

Add the package name to the `plugin` array of **both** files yourself (in the
project's `.opencode/` directory, at the project root, or in the global
`~/.config/opencode/` — all are valid config locations):

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

(`plugin_enabled` is the [credits sidebar](#credits-in-the-sidebar) step — recommended now, explained below.)

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
this package ships `{ id: "opencode-kiro", tui }`, so the id — and your
`plugin_enabled` keys — are identical across path and npm installs.

## Auth

```bash
opencode auth login
```

Select the **Kiro (plugin)** provider, then the **Kiro CLI Login** method:

- **Already logged in to kiro-cli**: immediate success — the existing kiro-cli session is reused.
- **Not logged in**: the plugin launches `kiro-cli login`, which opens a browser window.
  Complete the login there; the plugin polls for up to 120 seconds and stores the
  credential when kiro-cli reports success.

If the flow times out, authenticate directly with kiro-cli (`kiro-cli login`) and run
`opencode auth login` again — the fast path then completes immediately.

## Models

12 models, generated from the SDK's static catalog (`KIRO_MODEL_DEFAULTS`, sourced from
the models.dev kiro catalog data). All models support tool calling and have a 64K-token
output limit.

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

Without this you will see **two** context boxes (cosmetic duplication — the builtin
one, plus the plugin's). The credits value and its unit come from provider metadata
emitted by the SDK (kiro-cli reports the unit); nothing is hardcoded client-side.

## Known limitation (read this)

**Credits display is TUI-sidebar-only.** Every other cost surface — the prompt footer,
ACP clients, the web app, desktop, web share pages, and CLI cost output — shows $0.00
for Kiro sessions. Those surfaces render dollar cost computed by opencode core from
per-token pricing, which doesn't exist for a subscription-metered provider. A
cross-surface credits display requires opencode core changes and is intentionally out
of scope for this plugin.

## How it works

- **Provider seeding (`config` hook)**: the server plugin seeds `provider.kiro`
  (npm spec + the 12 models) into opencode's config before provider init reads it.
  This ordering is codified upstream ("load plugins first so config() hook runs before
  reading cfg.provider"), but it is not a documented public API — prefer released
  opencode versions that satisfy the `engines.opencode` floor, and pin your opencode
  and plugin versions if you need certainty across upgrades.
- **Dynamic SDK install (resolveSDK)**: on first model use, opencode installs
  `kiro-acp-ai-provider` from npm into its package cache and imports it; the plugin's
  `auth` loader supplies the provider options (`cwd`, `agent`, `trustAllTools`,
  `mcpTimeout`) that opencode forwards into `createKiroAcp(...)`.
- **Session affinity & reset (in-SDK)**: the SDK keys kiro-cli sessions off opencode's
  `x-session-affinity` header, isolates tool-less utility calls (title generation) on
  an ephemeral session, detects prompt-history divergence (fork/`/undo`), and starts a
  fresh kiro session when needed. No host-side session plumbing.
- **Credits metadata**: the SDK attaches `{ kiro: { credits, creditsUnit } }` provider
  metadata to the final part of each turn; opencode persists it, and the TUI plugin
  sums it per assistant message (deduped across text/reasoning parts) for the sidebar.

## Coexistence with the models.dev catalog

The kiro catalog entry for [models.dev](https://models.dev) is **merged**
([sst/models.dev#1312](https://github.com/sst/models.dev/pull/1312)). Once live
catalogs ship it, stock opencode will know kiro's model metadata even without this
plugin — but the plugin remains required for **auth** (the kiro-cli login method and
the SDK options loader) and the **TUI credits box**.

The two coexist by design: opencode merges config-level providers with the catalog
database, and the plugin's seeding is idempotent-by-skip — if `provider.kiro` already
exists in your config (your own entry, or a future opencode surfacing the catalog at
config level), the seed steps aside entirely and never clobbers it. Defining your own
`provider.kiro` in `opencode.json` is therefore also the override/removal path; a
future plugin release may drop seeding once the catalog entry is ubiquitous.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `kiro-cli is not installed` during auth | Install kiro-cli from <https://kiro.dev/docs/cli/> and ensure it is on `PATH` for the opencode process. |
| Auth times out after ~120s | Complete the browser login faster, or run `kiro-cli login` yourself, then re-run `opencode auth login` (fast path). |
| Two "Context" boxes in the sidebar | Add `"plugin_enabled": { "internal:sidebar-context": false }` to `tui.json` (see [Credits in the sidebar](#credits-in-the-sidebar)). |
| No credits line / credits stay 0 | Credits appear after the first **completed** kiro turn; cancelled turns and turns without usage metadata contribute nothing. Check the TUI plugin is `active` in the Plugins dialog (and listed in `tui.json`). |
| Kiro models missing from `opencode models` | Check `opencode-kiro` is in `opencode.json`'s `plugin` array. If you define `provider.kiro` yourself, your entry fully replaces the seeded one (by design) — including its model list. |
| `sdk.languageModel is not a function` | A stale `kiro-acp-ai-provider` < 2.0.0 resolved from opencode's package cache. Remove the cached copy (`$XDG_CACHE_HOME/opencode/packages/kiro-acp-ai-provider`, default `~/.cache/opencode/packages/...`) and retry — 2.0.0 fixed the factory auto-discovery clash. |
| Path install rejected (`must export id`) | Run `npm run build` in your checkout first and reference the repo root (both entry modules export ids). |
| Provider visible but runs fail | A seeded provider is selectable before auth exists. Run `opencode auth login` first. |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/server.js + dist/tui.js (+ d.ts)
npm test            # vitest
```

See [PUBLISH_CHECKLIST.md](./PUBLISH_CHECKLIST.md) for the release runbook.

## License

[MIT](./LICENSE)
