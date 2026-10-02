# opencode-kiro

> ⚠️ **Experimental prerelease** — `0.5.0-beta.5` targets the **unreleased OpenCode v2**
> plugin contract at a pinned snapshot. It does **not** work with OpenCode v1.
> v1 users: stay on **`opencode-kiro@0.4.0`** (the `main` branch / npm `latest` line,
> which remains the supported stable release). See [CHANGELOG.md](./CHANGELOG.md) and
> [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md) for exact pins and the tested
> OpenCode SHA. No OpenCode v2 release date is known or claimed here.

The ACP-compliant [Kiro](https://kiro.dev) plugin for [opencode](https://opencode.ai).

The plugin supplies:

- **Auth** via the official `kiro-cli` login flow: it registers the `kiro` integration
  with a **Kiro CLI Login** OAuth method (`opencode auth login`)
- **Model discovery**: after auth it captures Kiro's live model lineup and merges it
  into OpenCode's catalog (exact ID intersection, reasoning-effort variants), with a
  minimal self-registration fallback when the catalog lacks a `kiro` entry
- **Provider ownership**: an AISDK hook constructs the provider from
  [`kiro-acp-ai-provider`](https://www.npmjs.com/package/kiro-acp-ai-provider) with the
  right options (`cwd`, `agent`, `trustAllTools`, `mcpTimeout`, `stall`, `contextWindows`)
- **TUI credits display**: a live Kiro credits box in the sidebar and a compact
  credits chip in the prompt footer row beside the host cost/context display, both
  styled with the host's active theme tokens — auto-loaded from the same single
  config entry (`tui: true`)

`kiro-acp-ai-provider` talks to your locally installed `kiro-cli` over Kiro's
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). This is the supported
integration path: requests go through kiro-cli exactly like Kiro's own IDE clients,
with no credential scraping and no reuse of Kiro credentials against other providers.

## Compatibility

This prerelease is built and tested against **one pinned OpenCode v2 snapshot**:

| Item | Value |
|---|---|
| Tested OpenCode commit (`upstream/v2` head, 2026-08-29) | `8ba434b5973856b2f32b8cd3543e154b25c413e6` |
| `@opencode/plugin` | `2.0.22` (exact) |
| Package version | `0.5.0-beta.5` |

Full pin table and verification steps: [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md).
There is no `engines.opencode` constraint — the v2 host has no stable semver yet; the
tested SHA above is the compatibility target. Other v2 snapshots may or may not work.

## Prerequisites

| Requirement | Notes |
|---|---|
| [kiro-cli](https://kiro.dev/docs/cli/) | Must be installed and on `PATH`; a Kiro subscription / AWS Builder ID account |
| [Node.js](https://nodejs.org) `>= 20` | Enforced via `engines.node`. |
| OpenCode v2 at the tested snapshot | See [Compatibility](#compatibility). This prerelease does not support OpenCode v1. |

## Install and configure

**One config entry — that's the whole setup.** Add the package to the **`plugins`**
array (plural) of your OpenCode config. That is any `opencode.json` or `opencode.jsonc`
(or `.opencode/opencode.json`) found walking up from the project directory, or the
global `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["opencode-kiro@0.5.0-beta.5"]
}
```

> ⚠️ **Always pin the exact version, as above.** The host background-auto-refreshes
> unpinned npm plugin packages to whatever the registry serves, so a bare `"opencode-kiro"`
> spec can silently move you off the tested build. Use the exact
> `opencode-kiro@0.5.0-beta.5` spec.

The object form pins the same version and takes the plugin options described in
[Plugin options](#plugin-options):

```json
{
  "plugins": [
    {
      "package": "opencode-kiro@0.5.0-beta.5",
      "options": {}
    }
  ]
}
```

This loads the server entry (`./server` export): auth, model discovery, and provider
ownership. The server plugin declares **`tui: true`**, so the host TUI **auto-loads the
package's `./tui` entrypoint by itself** — the sidebar credits box and the prompt footer
credits chip appear with no further configuration. **No `cli.json` TUI entry is
needed.**

### Plugin options

All options are optional; omit the `options` object entirely to get the defaults.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `agent` | string | `"opencode"` | kiro-cli agent name the provider runs under |
| `mcpTimeout` | number | `45` | MCP tool-call timeout, in **minutes** |
| `discover` | boolean | `true` | Set `false` to skip the setup-time model discovery kick-off when Kiro is already connected. Discovery triggered by login/credential events still runs. |
| `stall` | object | `{ "afterMs": 10000, "live": "reasoning" }` | Stall notice for turns with no model output. `afterMs` is the silence threshold in milliseconds (`0` disables the notice entirely); `live` is `"reasoning"` (live notice in the transcript, visible only when thinking is shown) or `"off"` (summary line only). See [Slow responses](#slow-responses). |

```json
{
  "plugins": [
    {
      "package": "opencode-kiro@0.5.0-beta.5",
      "options": {
        "agent": "opencode",
        "mcpTimeout": 45,
        "discover": true,
        "stall": { "afterMs": 10000, "live": "reasoning" }
      }
    }
  ]
}
```

A value of the wrong type falls back to its default; unknown keys are ignored. The
contract per option: `mcpTimeout` must be a positive number of minutes; zero, negative,
or non-numeric values fall back to the default (`45`); an empty `agent` string falls
back to `"opencode"`. `stall` must be an object; both members are optional and each is
checked on its own - `afterMs` must be a number of milliseconds of `0` or more, `live`
must be exactly `"off"` or `"reasoning"`. An invalid member is dropped while the valid
one is kept, and an object with nothing valid left counts as omitted (defaults apply).

> ⚠️ **Options work on the npm channel only.** The host passes `options` to plugins it
> installed from npm (the `"package": "opencode-kiro@<version>"` form above). Local
> `name@file:` tarball installs count as the npm channel, so options work there too.
> Bundled or built-in plugin loads receive an empty options object, so **the defaults
> always apply there** regardless of what you write in `options`.

There is **no `cwd` option**. The working directory handed to kiro-cli is derived
automatically from the OpenCode location the plugin is set up for, once per location;
a user-supplied path could only be less accurate.

### Slow responses

When the Kiro backend is overloaded, kiro-cli retries the request on its own and the
turn produces no output for a while - a spinner with nothing behind it. The `stall`
option controls how the plugin surfaces that wait:

- **By default** (`afterMs: 10000`, `live: "reasoning"`): after 10 seconds without
  model output, a short reasoning block appears in the transcript, along the lines of
  *"Kiro: no output for 10s - the model may be overloaded and kiro-cli is retrying."*
  It refreshes every further 10 seconds while the silence lasts and closes with
  *"output resumed after Ns"* once real output arrives, or *"turn ended after Ns
  without further output"* if the turn ends first. The block is separate from the
  model's own reasoning and text; the answer is unaffected. Because the live notice is
  rendered as a reasoning block, the TUI shows it **collapsed by default (click to
  expand)**, and only when the TUI shows thinking (`session.thinking: "show"` in
  `cli.json`); with reasoning hidden the notice is hidden too, while the
  after-the-turn summary line described next still appears.
- **After the turn**, the credits box in the sidebar and the credits chip in the prompt
  footer add one line, `last turn stalled Ns (Reason)`, for as long as the last
  completed turn is the one that stalled. The parenthesized reason (for example
  `ModelOverloaded`) is taken, best-effort, from the last error kiro-cli wrote to its
  own log during that turn; when no such line is available the summary shows the
  duration alone.
- **`live: "off"`** hides the live transcript block; the after-the-turn summary line
  still appears.
- **`afterMs: 0`** disables the feature entirely: no transcript block and no summary.
  Any other value changes the silence threshold (in milliseconds).

```json
{
  "plugins": [
    {
      "package": "opencode-kiro@0.5.0-beta.5",
      "options": { "stall": { "live": "off" } }
    }
  ]
}
```

The notice is informational only; the plugin never cancels or retries the turn itself.
Requires `kiro-acp-ai-provider` 3.2.0 (see [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md)
for the pinned SDK version).

### Disabling

One `"-kiro"` directive in the same `plugins` array disables **everything**: it removes
the server plugin, and with it the `tui: true` auto-load, so the TUI half never
activates either:

```json
{
  "plugins": ["opencode-kiro@0.5.0-beta.5", "-kiro"]
}
```

### Legacy `tui.json` (v1)

`tui.json` is **legacy v1 configuration** and, under v2, is **migration input only**:
the host may read it when migrating old setups, and this plugin **never modifies it**.
Do not add new entries to `tui.json` (or to `cli.json` — neither is used by this
plugin anymore); the single `plugins` entry above is the only configuration.

### Local development (path source)

Run a local checkout without npm — build and pack first, then reference the tarball
with the `name@file:` form in the `plugins` array:

```bash
git clone https://github.com/NachoFLizaur/opencode-kiro && cd opencode-kiro
npm install && npm run build && npm pack
```

```json
{ "plugins": ["opencode-kiro@file:/absolute/path/to/opencode-kiro-0.5.0-beta.5.tgz"] }
```

A bare path or bare `file:` spec is rejected at the tested SHA — the `name@file:` form
is required. **Caveat (local `file:` installs only)**: the colon in the resulting
install dirname defeats the host's OpenTUI loader shim, so the TUI surfaces render a
contained per-slot error notice instead of the credits views (the rest of the TUI keeps
working). Registry installs (`opencode-kiro@0.5.0-beta.5`) use colon-free paths and are
fully green — this affects local tarball validation only.

The host resolves entrypoints from the package `exports` (`./server` for the server
half, `./tui` for the auto-loaded TUI half). Each entry module exports its own `id`:
the server plugin's id is `kiro` and the TUI plugin's id is `opencode-kiro`. Under
`tui: true` there is no separate TUI directive to manage — `-kiro` (the server id) is
the single kill-switch, and host logs use `kiro` for the server half and
`opencode-kiro` for the TUI half.

## Auth

```bash
opencode auth login
```

Select the **Kiro** integration, then the **Kiro CLI Login** method:

- **Already logged in to kiro-cli**: immediate success; the existing kiro-cli session is reused.
- **Not logged in**: the plugin launches `kiro-cli login`, which opens a browser window.
  Complete the login there; the plugin polls for up to 120 seconds and stores a minimal
  credential record when kiro-cli reports success.

There is no configuration prompt during login; the sidebar and footer credits surfaces
auto-load from the single `plugins` entry.

If the flow times out, authenticate directly with kiro-cli (`kiro-cli login`) and run
`opencode auth login` again; the fast path then completes immediately.

kiro-cli owns credential storage and refresh — OpenCode never stores real AWS tokens,
and the plugin implements no refresh callback.

## Models

After authentication, the plugin captures Kiro's runtime model list and transforms
OpenCode's catalog to the exact, case-sensitive intersection of runtime `modelId`
values and catalog model IDs. Runtime reasoning-effort levels are merged as model
variants (per model family, native levels only); an optional runtime baseline effort
sets the model's base effort. A discovery failure or duplicate runtime ID leaves the
catalog unchanged (fail-open). If the loaded catalog has no `kiro` provider at all, the
plugin self-registers a minimal fallback entry so discovered models remain usable.

Discovery is bounded and self-healing: a probe that gets no answer from kiro-cli within
60 seconds is treated as failed, and a failed probe is retried while Kiro stays
connected (after 5, 20, and 60 seconds) before giving up until the next login or
credential change. Each failure is reported on the server's stderr with an
`[opencode-kiro]` prefix - visible in `opencode serve` output, or from the TUI with
`OPENCODE_PRINT_LOGS=1` - so a missing model list is never silent. A login triggers one
probe per project location, however many credential events the host emits for it.

List the resulting models with:

```bash
opencode models
opencode run -m kiro/<exact-model-id> "hello"
```

Effort-capable models expose their variants through OpenCode's model-variant selection:
pick the variant to choose a reasoning-effort level. The selected level is applied per
request, and one provider instance (one kiro-cli process) serves every effort level, so
switching effort does not start additional kiro-cli processes. Kiro cannot disable
thinking, so even the lowest level still produces a reasoning trail.

## Credits in the TUI

Kiro is subscription-metered: requests consume **credits**, and the dollar cost
OpenCode normally displays for Kiro turns is always $0.00. To surface credits the TUI
plugin renders two surfaces:

- a Kiro credits box in the sidebar (`sidebar.content` claim), showing the session's
  live credits total and unit
- a compact credits chip in the prompt footer row beside the host cost/context
  display (`prompt.footer.status` claim) with the same total

Both are additive `append` claims — they compose with the host's built-in content and
never replace it — and both pick up the active theme's text tokens (feature-detected;
with no theme they fall back to default terminal styling). They render only for
sessions that carry Kiro credit data; other sessions are unchanged. The credits value
and unit come from the provider state the host persists on each message part
(`part.state.credits` / `part.state.creditsUnit`); nothing is hardcoded client-side.
The only configuration needed is the single `plugins` entry from
[Install](#install-and-configure) — the TUI half auto-loads via `tui: true`.

Durable credits are read straight from host message state (the host persists provider
state on text end). While a turn is still streaming,
credits for just-ended text are picked up live through a transient overlay that works
around a host reducer bug at the pinned snapshot (the live event path still drops
provider state); once durable state arrives it is authoritative and nothing is
double-counted. See [CHANGELOG.md](./CHANGELOG.md) for details.

## Known limitations (prerelease)

- **Live text credits use a transient overlay.** The durable credits path is fixed
  upstream, but the live `session.text.ended` reducer still drops provider state at
  the tested SHA, so in-turn updates come from the plugin's transient overlay
  (durable state always wins on reconcile). See
  [Credits in the TUI](#credits-in-the-tui) and [CHANGELOG.md](./CHANGELOG.md).
- **Credits render in the TUI only.** Every other cost surface (ACP clients, web,
  desktop, share pages, CLI cost output) shows $0.00 for Kiro sessions because the
  catalog declares Kiro's per-token `cost` as 0 (subscription-metered, no per-token
  pricing). That is expected, not a defect.
- **Local `file:` installs show a per-slot TUI error.** The colon in a `name@file:`
  install dirname defeats the host's OpenTUI loader shim; the failure is contained to
  the plugin's slots (dismissible error notice, host TUI unaffected). Registry
  installs are colon-free and fully working — this affects local tarball validation
  only.
- **Reduced toast feedback.** Auth-flow feedback is delivered as connect-flow text
  rather than toasts; this plugin's core deliberately does not depend on the churning
  TUI toast API.
- **One tested snapshot.** All pins are exact and the compatibility target is a single
  OpenCode v2 SHA (see [Compatibility](#compatibility)); other snapshots may not work.

## How it works

- **Auth (Integration + Credential)**: the plugin upserts the `kiro` integration with a
  "Kiro CLI Login" OAuth method. `verifyAuthAsync` from `kiro-acp-ai-provider` is the
  auth authority (it delegates to kiro-cli without blocking the host's event loop);
  success is stored as a minimal `Credential.OAuth` presence record. Starting a new
  login while one is pending cancels the earlier attempt.
- **Model discovery (catalog transform)**: after login (and on later login events) the
  plugin runs `listModels()` outside the transform, then applies the validated capture
  via a catalog transform and reload - exact ID matching, catalog metadata preserved,
  effort variants projected, fail-open on any discovery error. Each probe runs under a
  generation token: a logout, a newer probe, or a retry bumps the generation, and a
  result that arrives for an older generation is discarded instead of overwriting the
  catalog.
- **Provider ownership (AISDK hooks)**: the plugin's `sdk` hook constructs the provider
  from `kiro-acp-ai-provider` with the plugin-supplied settings (identifying itself to
  kiro-cli as `opencode-kiro`) and sets it as the event's SDK, so the Kiro provider is
  always plugin-owned; one instance is cached per distinct settings and shared across
  effort variants. The `language` hook applies the selected effort per request. The
  settings relay each model's context window into the SDK's `contextWindows` map keyed
  by model ID.
- **Effort carrier (why SDK settings, not `providerOptions`)**: OpenCode overlays the
  selected variant's `settings` onto the model's `settings` and hands them to the
  plugin's `aisdk` hooks as `event.options`; the `language` hook reads
  `event.options.effort` and passes it to the shared provider as a per-model override
  (`languageModel(id, { effort })`). The plugin emits the SDK's own `effort` key (not
  `reasoningEffort`), and the settings path is the working carrier because OpenCode
  builds per-call `providerOptions` only for the first-party `@ai-sdk/*` provider
  families - `providerOptions.kiro.*` is never populated for an `aisdk:` package
  provider like this one.
- **Session affinity & reset (in-SDK)**: the SDK keys kiro-cli sessions off OpenCode's
  session affinity, isolates tool-less utility calls on an ephemeral session, detects
  prompt-history divergence, and starts a fresh kiro session when needed.
- **Credits state**: the SDK reports `credits` / `creditsUnit` in each turn's provider
  metadata; OpenCode persists them key-unwrapped on message part state
  (`part.state.credits`, `part.state.creditsUnit`), and the TUI plugin sums them per
  assistant message (deduped across parts).
- **Stall status**: when a turn stalled, the SDK attaches `status`
  (`{ stalledMs, hint? }`) to the same provider metadata; the TUI plugin reads it from
  `part.state.status` on the same path as credits and renders the one-line summary
  described in [Slow responses](#slow-responses). The live transcript notice is a
  reasoning fragment emitted by the SDK itself, so it needs no TUI support.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `kiro-cli is not installed` during auth | Install kiro-cli from <https://kiro.dev/docs/cli/> and ensure it is on `PATH` for the opencode process. |
| Auth times out after ~120s | Complete the browser login faster, or run `kiro-cli login` yourself, then re-run `opencode auth login` (fast path). |
| No credits line / credits stay 0 | Credits appear after the first **completed** kiro turn; cancelled turns and turns without usage state contribute nothing. Check the plugin is active (no stray `"-kiro"` directive — note that directive residue can persist on a reused data dir). |
| Credits surfaces never appear | The TUI half auto-loads from the server `plugins` entry via `tui: true` — no separate TUI config exists. If the box/chip are missing, the server plugin itself is not loading (check your `plugins` entry and restart opencode). For local `name@file:` tarball installs, a contained per-slot error notice instead of the credits views is the known colon-path caveat; use a registry install. |
| `kiro` provider not showing in `opencode models` | Run `opencode auth login` first: models are discovered after auth. If the loaded catalog lacks a `kiro` entry, the plugin self-registers a minimal fallback during discovery. If you are logged in and the list (or the effort variants) is still missing, the discovery probe may have failed or timed out: it is retried automatically for a few minutes, and each attempt is reported on the server's stderr with an `[opencode-kiro]` prefix (`opencode serve`, or `OPENCODE_PRINT_LOGS=1` with the TUI). Logging in again starts a fresh probe. |
| Spinner with no output for a long time | The Kiro backend is likely overloaded and kiro-cli is retrying the request. With the default `stall` option a collapsed reasoning block saying so appears in the transcript after 10 seconds (only when thinking is shown; see [Slow responses](#slow-responses)), and the credits box/chip show `last turn stalled Ns (Reason)` once the turn ends. If no such block appears and the model list or effort variants are also missing, discovery may be the problem instead: watch the server log (`OPENCODE_PRINT_LOGS=1`, or run under `opencode serve`) for `[opencode-kiro]` lines. kiro-cli's own errors are in its log under your temp directory (`kiro-log/kiro-chat.log`). |
| Path install rejected (`must export id`) | Use the `name@file:<absolute tarball path>` form after `npm run build && npm pack` in your checkout (both entry modules export ids). |
| Provider visible but runs fail | The provider can be selectable before any credential exists. Run `opencode auth login` first. |
| Worked yesterday, broken today | This prerelease targets one pinned OpenCode snapshot (see [Compatibility](#compatibility)). If your OpenCode build moved past the tested SHA, the v2 plugin surface may have changed underneath it. The other cause is an **unpinned** `plugins` entry (a bare `"opencode-kiro"`): the host background-auto-refreshes unpinned npm plugin packages, so the plugin itself can move off the tested build without you changing anything — pin the exact `opencode-kiro@0.5.0-beta.5` spec. |

## Legacy: v1 / OpenCode v1 users (`0.4.0`)

`opencode-kiro@0.4.0` on the `main` branch is the supported stable line for OpenCode
v1 (`opencode >= 1.16.0`). It uses the v1 contract throughout: singular `plugin`
arrays in `opencode.json` and `tui.json`, the `opencode plugin opencode-kiro`
installer, and `part.metadata.kiro` credits. Its full documentation is the README at
the [`v0.4.0` tag](https://github.com/NachoFLizaur/opencode-kiro/tree/v0.4.0)
(equivalently, `main`). Do not install `0.5.0-beta.5` into an OpenCode v1 setup.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup builds dist/server.js + dist/tui.js (+ d.ts)
npm test            # vitest
```

## License

[MIT](./LICENSE) © Nacho F. Lizaur
