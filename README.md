# opencode-kiro

> ⚠️ **Experimental plugin prerelease** - `0.5.0-beta.7` is unreleased and targets
> **OpenCode 2 stable 2.0.x**, tested on **2.0.20**. It does **not** work with OpenCode v1.
> v1 users: stay on **`opencode-kiro@0.4.0`** (the `main` branch / npm `latest` line,
> which remains the supported stable release). See [CHANGELOG.md](./CHANGELOG.md) and
> [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md) for exact pins and the tested
> OpenCode SHA.

The ACP-compliant [Kiro](https://kiro.dev) plugin for [opencode](https://opencode.ai).

The plugin supplies:

- **Auth** via the official `kiro-cli` login flow: it registers the `kiro` integration
  with a **Kiro CLI Login** OAuth method (`opencode auth login`)
- **Model discovery**: after auth it captures Kiro's live model lineup and merges it
  into OpenCode's provider domain (exact ID intersection, reasoning-effort variants),
  with a minimal self-registration fallback when models.dev supplies no Kiro models
- **Provider ownership**: an AISDK hook constructs the provider from
  [`kiro-acp-ai-provider`](https://www.npmjs.com/package/kiro-acp-ai-provider) with the
  right options (`cwd`, `agent`, `trustAllTools`, `mcpTimeout`, `stall`, `contextWindows`)
- **TUI credits display**: a live Kiro credits box in the sidebar and a compact
  credits chip in the prompt footer row beside the host cost/context display, both
  styled with the host's active theme tokens - discovered from the package's `./tui`
  export using the same single config entry

`kiro-acp-ai-provider` talks to your locally installed `kiro-cli` over Kiro's
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). This is the supported
integration path: requests go through kiro-cli exactly like Kiro's own IDE clients,
with no credential scraping and no reuse of Kiro credentials against other providers.

## Compatibility

This plugin prerelease is built and tested against **OpenCode 2 stable 2.0.20**:

| Item | Value |
|---|---|
| Tested OpenCode commit (`v2.0.20` tag) | `84c9be93a56304a108f1a22df0c5d62c26d5b6ca` |
| `@opencode/plugin` | `2.0.20` (exact development pin for types and tests only; no peer dependency) |
| Package version | `0.5.0-beta.7` |

Full pin table and verification steps: [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md).
**Targets OpenCode 2 stable 2.0.x**, with `@opencode/cli@2.0.20` as the reference host.
Beta.7 is tested on 2.0.20; later releases are not guaranteed to work. No peer
dependency is declared because the host supplies the plugin API at runtime.
Older hosts, including build `0.0.0-beta-19271` from the
former CLI package scope, are **not supported by beta.7**; use
`opencode-kiro@0.5.0-beta.5` on those hosts. There is no `engines.opencode` constraint.

## Prerequisites

| Requirement | Notes |
|---|---|
| [kiro-cli](https://kiro.dev/docs/cli/) | Must be installed and on `PATH`; a Kiro subscription / AWS Builder ID account |
| [Node.js](https://nodejs.org) `>= 20` | Enforced via `engines.node`. |
| OpenCode 2 stable 2.0.x, tested on 2.0.20 | Later releases are not guaranteed to work. See [Compatibility](#compatibility) for the reference host and development pin. This plugin prerelease does not support OpenCode v1. |

OpenTUI 0.5.12 (`@opentui/core`, pulled in by the OpenCode 2.0.20 host floor)
declares `node >=26.4.0`, so an install with `engine-strict` enabled refuses older
Node versions even though the plugin itself declares `>=20`.

## Install and configure

**One config entry — that's the whole setup.** Add the package to the **`plugins`**
array (plural) of your OpenCode config. That is any `opencode.json` or `opencode.jsonc`
(or `.opencode/opencode.json`) found walking up from the project directory, or the
global `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["opencode-kiro@0.5.0-beta.7"]
}
```

> ⚠️ **Always pin the exact version, as above.** The host background-auto-refreshes
> unpinned npm plugin packages to whatever the registry serves, so a bare `"opencode-kiro"`
> spec can silently move you off the tested build. Use the exact
> `opencode-kiro@0.5.0-beta.7` spec.

The object form pins the same version and takes the plugin options described in
[Plugin options](#plugin-options):

```json
{
  "plugins": [
    {
      "package": "opencode-kiro@0.5.0-beta.7",
      "options": {}
    }
  ]
}
```

This loads the server entry (`./server` export): auth, model discovery, and provider
ownership. The host **discovers the TUI half from the package's `./tui` export** -
the sidebar credits box and the prompt footer credits chip appear with no further
configuration. **No `cli.json` TUI entry is needed.**

### Plugin options

All options are optional and apply to configured plugins from npm or a local
directory; omit the `options` object entirely to get the defaults.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `agent` | string | `"opencode"` | kiro-cli agent name the provider runs under |
| `mcpTimeout` | number | `45` | MCP tool-call timeout, in **minutes** |
| `discover` | boolean | `true` | Set `false` to skip the setup-time model discovery kick-off when Kiro is already connected. Discovery triggered by login/credential events still runs. |
| `stall` | object | `{ "afterMs": 10000, "live": "reasoning" }` | Stall notice for turns with no model output. `afterMs` is the silence threshold in milliseconds (`0` disables stall detection entirely); `live` is `"reasoning"` (live notice in the transcript, visible only when thinking is shown) or `"off"` (no stall UX in the TUI; metadata still emitted for other consumers). See [Slow responses](#slow-responses). |

```json
{
  "plugins": [
    {
      "package": "opencode-kiro@0.5.0-beta.7",
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

> **Options are honored for configured plugins: npm specs and local directory specs.**
> The host passes `options` for both `"package": "opencode-kiro@<version>"` and
> `"package": "/absolute/path/to/opencode-kiro/dist"`. Configured `name@file:` tarball
> installs also receive options. Bundled or built-in plugin loads receive `{}`, so
> **the defaults always apply there** regardless of what you write in `options`.

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
  without further output"* if the turn ends first. When the last error kiro-cli logged
  during the turn yields a short reason, the closing line includes it in parentheses:
  `output resumed after Ns (ModelOverloaded)` or
  `turn ended after Ns without further output (ModelOverloaded)`. The reason is
  best-effort; without one, the closing line has no parentheses. The block is separate
  from the model's own reasoning and text; the answer is unaffected. Because the live
  notice is rendered as a reasoning block, the TUI shows it **collapsed by default
  (click to expand)**, and only when the TUI shows thinking (`session.thinking: "show"`
  in `cli.json`); with reasoning hidden the notice is hidden too.
- **`live: "off"`** means no stall UX in the TUI: no transcript notice and no
  footer/box stall line. Stall metadata is still emitted for other consumers.
- **`afterMs: 0`** disables stall detection entirely: no transcript notice and no stall
  metadata. Any other value changes the silence threshold (in milliseconds).

```json
{
  "plugins": [
    {
      "package": "opencode-kiro@0.5.0-beta.7",
      "options": { "stall": { "live": "off" } }
    }
  ]
}
```

The stall summary now lives in the notice's closing line, not in the sidebar box or
footer chip; both credits surfaces show credits only. The notice is informational
only; it never cancels or retries the turn. The stall option was introduced in
`kiro-acp-ai-provider` 3.2.0; see [CHANGELOG.md](./CHANGELOG.md) for this release's SDK
requirement and [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md) for the current pin.

### Disabling

One `"-kiro"` directive in the same `plugins` array disables **everything**: it removes
the server plugin and its discovered `./tui` entrypoint, so the TUI half never
activates either:

```json
{
  "plugins": ["opencode-kiro@0.5.0-beta.7", "-kiro"]
}
```

### Legacy `tui.json` (v1)

`tui.json` is **legacy v1 configuration** and, under v2, is **migration input only**:
the host may read it when migrating old setups, and this plugin **never modifies it**.
Do not add new entries to `tui.json` (or to `cli.json` — neither is used by this
plugin anymore); the single `plugins` entry above is the only configuration.

### Local development (path source)

Build a local checkout, then point the `plugins` entry at the **absolute path of its
built `dist/` directory**. No pack or registry publish is needed:

```bash
git clone https://github.com/NachoFLizaur/opencode-kiro && cd opencode-kiro
npm install && npm run build
```

```json
{ "plugins": ["/absolute/path/to/opencode-kiro/dist"] }
```

For this directory source the host resolves `dist/server.js` and `dist/tui.js`
directly. Use the directory, not the package root or a direct `.js` file. Rebuild
with `npm run build` after edits. Options also work with the object form's `package`
set to this directory path.

**Tarball caveat (`name@file:` only):** if you instead run `npm pack` and configure
`opencode-kiro@file:/absolute/path/to/opencode-kiro-0.5.0-beta.7.tgz`, the colon in the
installed directory name defeats the host's OpenTUI loader shim. The plugin's slots
show a contained error notice instead of the credits views; the rest of the TUI
keeps working. Use the colon-free absolute `dist/` directory example above or a
registry install (`opencode-kiro@0.5.0-beta.7`) to avoid this tarball-specific issue.

For package installs, the host resolves the `./server` and `./tui` exports. Each
entry module exports its own `id`: the server plugin's id is `kiro` and the TUI
plugin's id is `opencode-kiro`. There is no separate TUI directive to manage -
`-kiro` (the server id) is the single kill-switch, and host logs use `kiro` for the
server half and `opencode-kiro` for the TUI half.

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

### Logged out of Kiro CLI

If you run `kiro-cli logout` while OpenCode is open, the plugin checks kiro-cli's login
state on the next Kiro turn, not when you select a model. These are fresh checks, at
most once per 60 seconds per project location while authenticated. If you send within
60 seconds of an authenticated check, no new check runs; the logout is noticed on the
next Kiro turn after that window expires.

The first definitive logged-out result shows a confirm dialog titled **"Kiro CLI is
logged out"** with the message **"Reconnect now?"**:

- **Confirm** removes the stored Kiro connection and opens the connect dialog.
- **Cancel or dismiss** does nothing immediately and defers reconnecting. A follow-up
  check runs about 6 seconds after the first logged-out result. If it also reports
  logged out, the stale connection is removed automatically, even if you cancelled.
  Kiro models then disappear until you reconnect through `/connect`. The dialog is
  not shown again for the same logout.
- **An inconclusive check** (kiro-cli unreachable or timed out) never removes the
  connection. An inconclusive follow-up is tried once more about 6 seconds later; if
  that is also inconclusive, the connection stays in place unless you confirm the
  dialog or a later Kiro turn's check confirms the logout. Logging back in before
  confirmation stops the automatic removal once an authenticated check succeeds.

To reconnect later, run `kiro-cli login`, then use `/connect`, select **Kiro**, and
choose **Add account** / **Kiro CLI Login**. A turn that fails with kiro-cli's
not-logged-in error is not retried; reconnect before sending again.

## Models

After authentication, the plugin captures Kiro's runtime model list and uses
`provider.transform` to take the exact, case-sensitive intersection of runtime
`modelId` values and models.dev `Model.Info.modelID` values. Runtime reasoning-effort
levels are merged as model variants (per model family, native levels only); an optional runtime baseline effort
sets the model's base effort. A discovery failure or duplicate runtime ID leaves the
provider data unchanged (fail-open). If the models.dev seed has no `kiro` provider
or its model set is empty, the plugin self-registers minimal runtime model entries.
Snapshot publication requests `provider.reload`; no model-domain transform is registered.

The host's own variant generation uses a package-keyed protocol map in
`packages/core/src/variant.ts`. It has no Kiro or generic `aisdk:` entry, so it
generates no variants for `aisdk:kiro-acp-ai-provider`. Runtime effort enrichment
remains the plugin's responsibility.

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
[Install](#install-and-configure) - the host discovers the TUI half from `./tui`.

Durable credits are read straight from host message state (the host persists provider
state on text end). While a turn is still streaming,
credits for just-ended text are picked up live through a transient overlay that works
around a host reducer bug at the pinned snapshot (the live event path still drops
provider state); once durable state arrives it is authoritative and nothing is
double-counted. See [CHANGELOG.md](./CHANGELOG.md) for details.

## Known limitations (prerelease)

- Conversations that run without tools (for example an agent with all tools disabled)
  can lose earlier context after the first turn, because OpenCode's title request
  and the main turn can end up sharing one Kiro session. This is a known,
  pre-existing issue with a fix planned for a later release.
- Compaction completes, but the Kiro session may not receive the earlier conversation
  or the compaction summary, so the following turns can miss context. This is a
  known, pre-existing issue with a fix planned for a later release.
- **Live text credits use a transient overlay.** The durable credits path is fixed
  upstream, but the live `session.text.ended` reducer still drops provider state at
  the tested SHA, so in-turn updates come from the plugin's transient overlay
  (durable state always wins on reconcile). See
  [Credits in the TUI](#credits-in-the-tui) and [CHANGELOG.md](./CHANGELOG.md).
- **Credits render in the TUI only.** Every other cost surface (ACP clients, web,
  desktop, share pages, CLI cost output) shows $0.00 for Kiro sessions because the
  catalog declares Kiro's per-token `cost` as 0 (subscription-metered, no per-token
  pricing). That is expected, not a defect.
- **`name@file:` tarball installs show a per-slot TUI error.** The colon in a `name@file:`
  install dirname defeats the host's OpenTUI loader shim; the failure is contained to
  the plugin's slots (dismissible error notice, host TUI unaffected). Registry
  installs and the absolute `dist/` directory source avoid that colon-path issue.
- **Reduced toast feedback.** Auth-flow feedback is delivered as connect-flow text
  rather than toasts; this plugin's core deliberately does not depend on the churning
  TUI toast API.
- **One tested host release.** Beta.7 targets OpenCode 2 stable 2.0.x and is tested
  on 2.0.20; later releases are not guaranteed to work. No peer dependency is
  declared; the host supplies the plugin API at runtime. The exact development
  pin is for types and tests only. See [Compatibility](#compatibility).

## How it works

- **Auth (Integration + Credential)**: the plugin upserts the `kiro` integration with a
  "Kiro CLI Login" OAuth method. `verifyAuthAsync` from `kiro-acp-ai-provider` is the
  auth authority (it delegates to kiro-cli without blocking the host's event loop);
  success is stored as a minimal `Credential.OAuth` presence record. Starting a new
  login while one is pending cancels the earlier attempt.
- **Model discovery (provider transform)**: after login (and on later login events) the
  plugin runs `listModels()` outside the transform, then applies the validated capture
  via `provider.transform` and `provider.reload` - exact ID matching, models.dev
  metadata preserved, effort variants projected, fail-open on any discovery error. Each probe runs under a
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
- **Effort carrier (`settings.effort`)**: OpenCode overlays the
  selected variant's `settings` onto the model's `settings` and hands them to the
  plugin's `aisdk` hooks as `event.options`; the `language` hook reads
  `event.options.effort` and passes it to the shared provider as a per-model override
  (`languageModel(id, { effort })`). The plugin emits the SDK's own `effort` key (not
  `reasoningEffort`). These variants come from runtime discovery, not the host's
  package-keyed protocol map, which has no Kiro or generic `aisdk:` entry.
- **Session affinity & reset (in-SDK)**: the SDK keys kiro-cli sessions off OpenCode's
  session affinity, isolates tool-less utility calls on an ephemeral session, detects
  prompt-history divergence, and starts a fresh kiro session when needed.
- **Credits state**: the SDK reports `credits` / `creditsUnit` in each turn's provider
  metadata; OpenCode persists them key-unwrapped on message part state
  (`part.state.credits`, `part.state.creditsUnit`), and the TUI plugin sums them per
  assistant message (deduped across parts).
- **Stall notice and metadata**: the SDK emits the live transcript notice as a
  reasoning fragment, with a short reason in its closing line when available (see
  [Slow responses](#slow-responses)). A stalled turn's final text or reasoning part
  carries `status` (`{ stalledMs, hint?, reason? }`) in provider metadata for other
  consumers, even with `live: "off"`. The TUI credits surfaces do not render `status`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `kiro-cli is not installed` during auth | Install kiro-cli from <https://kiro.dev/docs/cli/> and ensure it is on `PATH` for the opencode process. |
| Auth times out after ~120s | Complete the browser login faster, or run `kiro-cli login` yourself, then re-run `opencode auth login` (fast path). |
| Kiro shows connected but prompts fail with Not logged in | The next Kiro turn offers to reconnect once the login check detects the logout (checks pause for 60 seconds after an authenticated result; see [Logged out of Kiro CLI](#logged-out-of-kiro-cli)). To reconnect now, use `/connect` > **Kiro** > **Add account**, then **Kiro CLI Login**. You can also run `kiro-cli login` first, then use `/connect`. Not-logged-in failures are not retried. |
| No credits line / credits stay 0 | Credits appear after the first **completed** kiro turn; cancelled turns and turns without usage state contribute nothing. Check the plugin is active (no stray `"-kiro"` directive — note that directive residue can persist on a reused data dir). |
| Credits surfaces never appear | The host discovers the `./tui` export from the same `plugins` entry - no separate TUI config exists. Check the entry, the built server/TUI files, and host load errors, then restart opencode. For `name@file:` tarball installs, a contained per-slot error notice instead of the credits views is the known colon-path caveat; use an absolute built `dist/` directory or a registry install. |
| `kiro` provider not showing in `opencode models` | Run `opencode auth login` first: models are discovered after auth. If the loaded catalog lacks a `kiro` entry, the plugin self-registers a minimal fallback during discovery. If you are logged in and the list (or the effort variants) is still missing, the discovery probe may have failed or timed out: it is retried automatically for a few minutes, and each attempt is reported on the server's stderr with an `[opencode-kiro]` prefix (`opencode serve`, or `OPENCODE_PRINT_LOGS=1` with the TUI). Logging in again starts a fresh probe. |
| Spinner with no output for a long time | The Kiro backend is likely overloaded and kiro-cli is retrying the request. With the default `stall` option a collapsed reasoning block saying so appears in the transcript after 10 seconds (only when thinking is shown; see [Slow responses](#slow-responses)). Its closing line reports the duration and, when available from kiro-cli's log, a reason such as `ModelOverloaded`. If no such block appears and the model list or effort variants are also missing, discovery may be the problem instead: watch the server log (`OPENCODE_PRINT_LOGS=1`, or run under `opencode serve`) for `[opencode-kiro]` lines. kiro-cli's own errors are in its log under your temp directory (`kiro-log/kiro-chat.log`). |
| Local plugin does not load | Run `npm run build` and configure the absolute `dist/` directory path, not the package root or a direct `.js` file. The host resolves `server.js` and `tui.js` inside that directory; both entry modules export their own ids. |
| Provider visible but runs fail | The provider can be selectable before any credential exists. Run `opencode auth login` first. |
| Worked yesterday, broken today | Beta.7 targets OpenCode 2 stable 2.0.x and is tested on 2.0.20; later releases are not guaranteed to work (see [Compatibility](#compatibility)). If your OpenCode build moved past the tested SHA, the v2 plugin surface may have changed underneath it. The other cause is an **unpinned** `plugins` entry (a bare `"opencode-kiro"`): the host background-auto-refreshes unpinned npm plugin packages, so the plugin itself can move off the tested build without you changing anything - pin the exact `opencode-kiro@0.5.0-beta.7` spec. |

## Legacy: v1 / OpenCode v1 users (`0.4.0`)

`opencode-kiro@0.4.0` on the `main` branch is the supported stable line for OpenCode
v1 (`opencode >= 1.16.0`). It uses the v1 contract throughout: singular `plugin`
arrays in `opencode.json` and `tui.json`, the `opencode plugin opencode-kiro`
installer, and `part.metadata.kiro` credits. Its full documentation is the README at
the [`v0.4.0` tag](https://github.com/NachoFLizaur/opencode-kiro/tree/v0.4.0)
(equivalently, `main`). Do not install `0.5.0-beta.7` into an OpenCode v1 setup.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsup builds dist/server.js + dist/tui.js (+ d.ts)
npm test            # vitest
```

## License

[MIT](./LICENSE) © Nacho F. Lizaur
