# Changelog

All notable changes to `opencode-kiro` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `0.5.0` prerelease line targets the **unreleased OpenCode v2** plugin contract at
one pinned host snapshot per release. It does not work with OpenCode v1 and carries no
stability promise: it may break when OpenCode's v2 branch moves. OpenCode v1 users:
stay on `opencode-kiro@0.4.0` (the `main` branch / npm `latest` line). No OpenCode v2
release date is known or claimed here. Current pins: [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md).

## [Unreleased]

### Fixed

- **`limit.context` now follows the live Kiro lineup.** kiro-cli reports no
  structured limits over ACP, but its model descriptions state the window as prose
  ("Claude Opus 4.8 model with 1M context window"). Discovery now parses that value
  and applies it to `limit.context` on both catalog paths (models.dev intersection
  and runtime-only self-registration), and the same value feeds the SDK's
  `contextWindows` setting. Previously every self-registered model kept the host
  default (200k), so 1M-window models compacted far too early and the SDK was handed
  a wrong window. Models whose description states no window are left untouched;
  `limit.output` is never derived (the description never states it).

## [0.5.0-beta.5] - 2026-09-04

Supersedes 0.5.0-beta.4 at the same tested OpenCode commit. This release makes model
discovery resilient to a slow or failing kiro-cli, and makes a stalled turn visible
instead of leaving a spinner with nothing behind it. No re-login is needed.

### Compatibility

| Item | Value |
|---|---|
| Tested OpenCode commit (`upstream/v2` head, 2026-08-29) | `8ba434b5973856b2f32b8cd3543e154b25c413e6` |
| Package version | `0.5.0-beta.5` |

| Package | Pinned version | Where |
|---|---|---|
| `@opencode-ai/plugin` | `0.0.0-dev-18686` | devDependencies + peerDependencies (exact; the dev channel is the live v2 channel, pinned by exact version string, never by dist-tag; unchanged from beta.4) |
| `@opentui/solid` | `0.5.9` | dependencies (exact; sole published version satisfying the `>=0.5.9` peer floor; bundler-external, never bundled; unchanged) |
| `solid-js` | `1.9.12` | dependencies (exact; `@opentui/solid@0.5.9` peers this exactly; bundler-external, never bundled; unchanged) |
| `kiro-acp-ai-provider` | `3.2.0` | dependencies (exact; moved from `3.1.0`) |

Requires kiro-acp-ai-provider 3.2.0.

Pin your install spec too: the host background-auto-refreshes unpinned npm plugin
packages, so a bare `"opencode-kiro"` `plugins` entry can silently move you off the
tested build. Use the exact `opencode-kiro@0.5.0-beta.5` spec.

### Added

- **Stall notice for turns with no model output.** When the Kiro backend is
  overloaded, kiro-cli retries on its own and the turn shows nothing for a while. By
  default, after 10 seconds without output a short reasoning block now appears in the
  transcript (along the lines of "Kiro: no output for 10s - the model may be overloaded
  and kiro-cli is retrying."), refreshes every further 10 seconds of silence, and
  closes with "output resumed after Ns" when output arrives, or "turn ended after Ns
  without further output" if the turn ends first. The block is separate from
  the model's own reasoning and text; the answer is unaffected. Like any reasoning
  block, the TUI shows it **collapsed by default (click to expand)**, and only when
  thinking is shown (`session.thinking: "show"` in `cli.json`).
- **Stall summary in the credits surfaces.** After a stalled turn ends, the sidebar
  credits box and the footer credits chip add one line, `last turn stalled Ns (Reason)`,
  for as long as the last completed turn is the one that stalled. The reason (for
  example `ModelOverloaded`) is taken, best-effort, from the last error kiro-cli wrote
  to its own log during the turn; without one the line shows the duration alone.
- **Plugin option `stall`.** `stall: { afterMs, live }` in the object form of the
  `plugins` entry: `afterMs` (default `10000`) is the silence threshold in
  milliseconds and `0` disables the feature entirely; `live` is `"reasoning"`
  (default; live transcript block) or `"off"` (summary line only). Each member is
  validated on its own; invalid members are dropped and the defaults apply. Like the
  other options it is honored for npm-installed plugins only.
- **Discovery diagnostics.** A model-discovery probe that fails or times out is now
  reported on the server's stderr with an `[opencode-kiro]` prefix, including the
  attempt count and the next step (retry delay or giving up). The lines are visible in
  `opencode serve` output or, from the TUI, with `OPENCODE_PRINT_LOGS=1`. Previously a
  failed discovery was silent.

### Changed

- **Discovery probes time out and retry.** A `listModels()` probe that gets no answer
  from kiro-cli within 60 seconds is treated as failed. A failed or timed-out probe is
  retried after 5, 20, and 60 seconds while Kiro stays connected; the chain stops on
  logout, on a newer discovery, on cleanup, or after the last retry, until the next
  login or credential change starts a fresh one. Discovery remains fail-open: the
  catalog is left unchanged while no result is available.
- **One discovery probe per login.** The host emits several credential events for a
  single login; they now coalesce onto one in-flight probe per project location
  instead of running a probe per event.

### Fixed

- **A failed startup discovery no longer leaves the provider without effort variants
  until restart.** When the initial probe failed or hung, beta.4 kept the catalog
  without Kiro's runtime model list and reasoning-effort variants until opencode was
  restarted or a credential changed; the probe is now retried automatically.
- **Abandoned probes cannot overwrite the catalog.** A probe that is still running
  after its deadline, a logout, or a newer discovery is discarded when it finally
  completes; only the result of the current probe is applied.

### Upgrading from beta.4

Change the `plugins` entry `opencode-kiro@0.5.0-beta.4` to `opencode-kiro@0.5.0-beta.5`
and restart opencode. No new config keys are required (the `stall` option is
optional), no `cli.json` or `tui.json` entry, no re-login (credentials are host-owned
and carry over). The tested OpenCode commit did not move.

### Known limitations

New in this release:

1. **A stalled turn that ends without any text or reasoning carries no summary.** The
   stall status rides the turn's final text or reasoning part (the live notice counts
   as one while it is open). A turn whose output after the stall consists of tool
   calls only shows the transcript block but no `last turn stalled` line afterwards.

Unchanged from beta.4:

2. **Model-discovery probes carry the SDK's default client name.** Cosmetic in
   kiro-cli logs; no behavior impact.
3. **Live text credits still use the transient overlay.** Durable state is
   authoritative on every reconcile; nothing is double-counted.
4. **Local `file:` installs render a per-slot TUI error.** Registry installs are
   colon-free.
5. **No dollar cost anywhere.** Credits render in the TUI surfaces only. Expected, not
   a defect.
6. **Prerelease pins are rigid.** All v2-sensitive pins are exact and the
   compatibility target is the single tested commit above.

## [0.5.0-beta.4] - 2026-09-02

Supersedes 0.5.0-beta.3 at the same tested OpenCode commit. This release fixes a
host stall during "Kiro CLI Login", stops kiro-cli process accumulation when switching
reasoning effort, and adds the first plugin options. No re-login is needed.

### Compatibility

| Item | Value |
|---|---|
| Tested OpenCode commit (`upstream/v2` head, 2026-08-29) | `8ba434b5973856b2f32b8cd3543e154b25c413e6` |
| Package version | `0.5.0-beta.4` |

| Package | Pinned version | Where |
|---|---|---|
| `@opencode-ai/plugin` | `0.0.0-dev-18686` | devDependencies + peerDependencies (exact; the dev channel is the live v2 channel, pinned by exact version string, never by dist-tag; unchanged from beta.3) |
| `@opentui/solid` | `0.5.9` | dependencies (exact; sole published version satisfying the `>=0.5.9` peer floor; bundler-external, never bundled; unchanged) |
| `solid-js` | `1.9.12` | dependencies (exact; `@opentui/solid@0.5.9` peers this exactly; bundler-external, never bundled; unchanged) |
| `kiro-acp-ai-provider` | `3.1.0` | dependencies (exact; moved from `3.0.0`) |

Pin your install spec too: the host background-auto-refreshes unpinned npm plugin
packages, so a bare `"opencode-kiro"` `plugins` entry can silently move you off the
tested build. Use the exact `opencode-kiro@0.5.0-beta.4` spec.

### Added

- **Non-blocking login probe.** "Kiro CLI Login" now polls kiro-cli through the SDK's
  new `verifyAuthAsync` (the reason for the `3.1.0` pin). The previous probe ran
  kiro-cli synchronously on every 2-second poll tick, blocking the host's event loop
  for the duration of each kiro-cli call while a browser login was pending. Polling
  cadence (every 2 seconds, up to 120 seconds) is unchanged; the host stays
  responsive throughout.
- **Plugin options `agent`, `mcpTimeout`, `discover`.** Set them through the object
  form of the `plugins` entry in `opencode.json`:

  ```json
  {
    "plugins": [
      {
        "package": "opencode-kiro@0.5.0-beta.4",
        "options": { "agent": "opencode", "mcpTimeout": 45, "discover": true }
      }
    ]
  }
  ```

  `agent` (default `"opencode"`) is the kiro-cli agent name; `mcpTimeout` is the
  MCP tool-call timeout in minutes and must be a positive number of minutes; zero,
  negative, or non-numeric values fall back to the default (`45`); `discover: false`
  skips the setup-time model discovery kick-off (discovery on login/credential
  events still runs). Values of the wrong type fall back to the defaults and
  unknown keys are ignored. **Options are honored for npm-installed plugins only**: bundled/built-in
  plugin loads receive no options from the host, so the defaults always apply there.
  There is deliberately no `cwd` option; the working directory is derived per
  OpenCode location automatically.
- **Client identification.** The provider now identifies itself to kiro-cli as
  `opencode-kiro` (with the plugin version) during ACP initialization, so Kiro-side
  logs and diagnostics can tell plugin traffic apart from other ACP clients.

### Changed

- **One Kiro provider instance is shared across reasoning-effort variants.** The
  selected effort is applied per request through the plugin's `language` hook (the
  SDK's per-model override path) instead of baking it into the provider instance.
  Switching effort mid-session therefore no longer starts additional kiro-cli
  processes: verified live on the tested host, the number of kiro-cli processes did
  not grow across a high to low effort switch, where beta.3 created a separate
  provider instance (and kiro-cli process) for each effort variant used. The effort
  value that reaches kiro-cli is unchanged.
- **SDK pin `kiro-acp-ai-provider` `3.0.0` -> `3.1.0`.** Additive release: it adds
  `verifyAuthAsync`; the synchronous API the plugin used before is unchanged.
- **Starting a new "Kiro CLI Login" while one is pending now cancels the previous
  attempt.** Beta.3 left the earlier `kiro-cli login` child process running behind
  the new one. Now the previous attempt is stopped and its outcome is reported to the
  host as superseded (`Kiro CLI login superseded by a new login attempt.`); the new
  attempt proceeds normally. Only the newest attempt can store a credential.

### Fixed

- **Abandoned login attempts no longer surface an unhandled promise rejection.** A
  login that timed out, was cancelled, or was superseded before the host attached
  its result handler could previously emit an unhandled-rejection warning in the
  host process. The rejection is now always observed.
- **Provider reuse now works in production.** Kiro requests reuse one provider
  instance (one kiro-cli process) per configuration instead of constructing a fresh
  one every time. The cache key previously included a host-injected `fetch` function,
  which made it unusable; it now derives only from the plugin's own provider settings.

### Upgrading from beta.3

Change the `plugins` entry `opencode-kiro@0.5.0-beta.3` to `opencode-kiro@0.5.0-beta.4`
and restart opencode. No new config keys are required (the options above are
optional), no `cli.json` or `tui.json` entry, no re-login (credentials are host-owned
and carry over). The tested OpenCode commit did not move.

### Known limitations

New in this release:

1. **Model-discovery probes carry the SDK's default client name.** Only the main
   provider (the one that serves chat requests) identifies itself as `opencode-kiro`;
   the short-lived `listModels()` probe run during discovery bypasses the plugin's SDK
   hook and still announces the SDK's default client name to kiro-cli. Cosmetic in
   kiro-cli logs; no behavior impact.

Unchanged from beta.3:

2. **Live text credits still use the transient overlay.** At the tested commit the
   live `session.text.ended` reducer still drops the event's provider state, so
   in-turn credit updates come from the plugin's transient overlay. Durable state is
   authoritative on every reconcile; nothing is double-counted.
3. **Local `file:` installs render a per-slot TUI error.** The colon in a
   `name@file:<tarball>` install dirname defeats the host's OpenTUI loader shim; the
   failure is contained to the plugin's slots. Registry installs are colon-free.
4. **No dollar cost anywhere.** Kiro is subscription-metered; the catalog declares
   per-token `cost` 0, so every non-TUI cost surface shows $0.00 for Kiro sessions.
   Credits render in the TUI surfaces only. Expected, not a defect.
5. **Prerelease pins are rigid.** All v2-sensitive pins are exact and the
   compatibility target is the single tested commit above.

## [0.5.0-beta.3] - 2026-08-30

Supersedes 0.5.0-beta.2. If you run beta.2 on a current v2 host, upgrade: beta.2's
login/logout model reactivity is silently broken there (see Fixed).

### Compatibility

| Item | Value |
|---|---|
| Tested OpenCode commit (`upstream/v2` head, 2026-08-29) | `8ba434b5973856b2f32b8cd3543e154b25c413e6` |
| Package version | `0.5.0-beta.3` |

| Package | Pinned version | Where |
|---|---|---|
| `@opencode-ai/plugin` | `0.0.0-dev-18686` | devDependencies + peerDependencies (exact; the dev channel is the live v2 channel, pinned by exact version string, never by dist-tag) |
| `@opentui/solid` | `0.5.9` | dependencies (exact; sole published version satisfying the `>=0.5.9` peer floor; bundler-external, never bundled) |
| `solid-js` | `1.9.12` | dependencies (exact; `@opentui/solid@0.5.9` peers this exactly; bundler-external, never bundled) |
| `kiro-acp-ai-provider` | `3.0.0` | dependencies (exact, unchanged from v1) |

Pin your install spec too: the host background-auto-refreshes unpinned npm plugin
packages, so a bare `"opencode-kiro"` `plugins` entry can silently move you off the
tested build. Use the exact `opencode-kiro@0.5.0-beta.3` spec.

### Fixed

- **Credential-event migration across host generations (dual-listen).** Upstream
  removed the `integration.connection.updated` event as part of the new multi-account
  credentials feature, replacing it with `credential.updated` (empty payload) and
  `credential.switched` (`{integrationID, credentialID}`). beta.2 filtered its
  discovery listener on the removed name, so on any host carrying that removal
  (upstream `eb1ac54d73` / `62d9aa9838`) logging in mid-session never populated the
  Kiro model list and logging out never cleared it; a restart still picked the state
  up, which is what made the breakage silent. beta.3 accepts all three event names
  and keeps re-checking `connection.active("kiro")` as the single source of truth, so
  behavior is identical whichever scheme the host speaks. Validated end to end on the
  tested host: start logged out (0 Kiro models), mid-session Kiro CLI Login (18
  models on the same server process, no restart), logout (models cleared, no restart);
  on that host the old event name fired zero times.
- **Multi-account credentials.** Current hosts can store multiple Kiro credentials
  (auto-labeled "Kiro", "Kiro 2", ...). Switching between them fires a genuine
  `credential.switched`; discovery re-checks the active connection and the model list
  stays correct. Because `credential.updated` carries no `integrationID`, any
  credential change on the host re-runs Kiro discovery while Kiro is connected; this
  is benign (the re-check is coalesced and fail-open).

### Changed

- **Re-pin to the current v2 head.** Tested OpenCode commit moved
  `1cf61593b5ec204619b3f679fe418fec10ca5934` -> `8ba434b5973856b2f32b8cd3543e154b25c413e6`
  (about one week of upstream v2 development, including the credential-event rename);
  `@opencode-ai/plugin` moved `0.0.0-dev-17968` -> `0.0.0-dev-18686` (the CI build of
  the pinned head) and `@opentui/solid` moved `0.5.7` -> `0.5.9` per the new `>=0.5.9`
  peer floor (`solid-js` stays exactly `1.9.12`).
- **Additive host surface absorbed.** The plugin API at this pin adds optional
  surfaces (`vcs`, location/permission/generate context, `Credential.OAuth.expires`
  widened to an integer schema); all additive, no plugin behavior change. Slot claims,
  `tui: true` auto-load, forms auth, effort variants, and the credits surfaces carry
  over from beta.2 unchanged and were re-validated end to end at the new commit.

### Upgrading from beta.2

Either check tells you whether your host is affected:

- **Event names.** Connect or disconnect any integration and watch the host event
  stream: if it publishes `credential.updated` / `credential.switched` instead of
  `integration.connection.updated`, beta.2's discovery listener is dead on that host.
- **Upstream commits.** If your OpenCode checkout contains `eb1ac54d73` / `62d9aa9838`,
  your host is affected. Those landed after beta.2's tested `1cf61593b5` (2026-08-23)
  and at or before beta.3's `8ba434b597` (2026-08-29). A host at beta.2's own tested
  commit predates the removal and is not affected.

To upgrade, change the `plugins` entry `opencode-kiro@0.5.0-beta.2` to
`opencode-kiro@0.5.0-beta.3` and restart opencode. No new config keys, no `cli.json`
or `tui.json` entry, no re-login (credentials are host-owned and carry over).

### Known limitations

Unchanged from beta.2:

1. **Live text credits still use the transient overlay.** At the tested commit the
   live `session.text.ended` reducer still drops the event's provider state, so in-turn
   credit updates come from the plugin's transient overlay. Durable state (fixed
   upstream) is authoritative on every reconcile; nothing is double-counted.
2. **Local `file:` installs render a per-slot TUI error.** The colon in a
   `name@file:<tarball>` install dirname defeats the host's OpenTUI loader shim; the
   failure is contained to the plugin's slots. Registry installs are colon-free and
   fully verified; this affects local tarball validation only.
3. **No dollar cost anywhere.** Kiro is subscription-metered; the catalog declares
   per-token `cost` 0, so every non-TUI cost surface shows $0.00 for Kiro sessions.
   Credits render in the TUI surfaces only. Expected, not a defect.
4. **Prerelease pins are rigid.** All v2-sensitive pins are exact and the
   compatibility target is the single tested commit above.

## [0.5.0-beta.2] - 2026-08-23

Supersedes 0.5.0-beta.1, which targeted an older v2 snapshot and an older plugin API
channel.

### Compatibility

| Item | Value |
|---|---|
| Tested OpenCode commit (`upstream/v2` head, 2026-08-23) | `1cf61593b5ec204619b3f679fe418fec10ca5934` |
| Package version | `0.5.0-beta.2` |

| Package | Pinned version | Where |
|---|---|---|
| `@opencode-ai/plugin` | `0.0.0-dev-17968` | devDependencies + peerDependencies (exact; the dev channel is the live v2 channel, pinned by exact version string, never by dist-tag) |
| `@opentui/solid` | `0.5.7` | dependencies (exact; sole published version satisfying the `>=0.5.7` peer floor; bundler-external, never bundled) |
| `solid-js` | `1.9.12` | dependencies (exact; `@opentui/solid@0.5.7` peers this exactly; bundler-external, never bundled) |
| `kiro-acp-ai-provider` | `3.0.0` | dependencies (exact, unchanged from v1) |

The `next` dist-channel that beta.1 pinned from (`0.0.0-next-16420`) is stale.

### Added

- **Single-config install via `tui: true`.** The server plugin declares the new
  `tui: true` flag, so the host TUI auto-loads the package's `./tui` entrypoint from
  the one server `plugins` entry. The beta.1 two-file setup (server `plugins` entry
  plus a TUI entry in the global `cli.json`) is obsolete: remove any old
  `"opencode-kiro"` `cli.json` entry. A single `"-kiro"` directive now disables both
  halves.
- **Credits chip revived, in the prompt footer row.** The compact credits chip
  (descoped in beta.1 when `session.composer.top` was removed upstream) renders again:
  one line with the session's credits total in the prompt footer row beside the host
  cost/context display, alongside the sidebar box. It claims `prompt.footer.status`
  additively; the footer's `sessionID` is optional, so the chip is withheld on
  session-less footers, and it renders in both normal and shell prompt modes.
- **Theme-aware styling.** `context.theme` is now a typed `ResolvedTheme`; the box and
  chip pick up the host theme's text tokens (header = default text token, totals =
  subdued token), feature-detected. With no or a misshapen theme the views keep
  default terminal styling. This reverses beta.1's "default styling" limitation.

### Changed

- **Re-pin to the current v2 head.** Tested OpenCode commit moved
  `b47cfbee7c4fd24e5d73e5753b4755db62a92a63` -> `1cf61593b5ec204619b3f679fe418fec10ca5934`
  (about four weeks of upstream v2 development); the plugin API pin moved from the
  stale `next` channel to `@opencode-ai/plugin@0.0.0-dev-17968`, and `@opentui/solid`
  moved `0.4.5` -> `0.5.7` per the new peer floor.
- **TUI slot claims.** The host replaced the `SlotName`-keyed `ui.slot(name, render)`
  API with claims (`ui.slot({ append: "<path>", render })`). Both surfaces are
  additive `append` claims: they compose with built-in content and never replace it.
- **Credits workaround narrowed to a live-only overlay.** The durable path is fixed
  upstream: the server now persists provider state (`part.state.credits` /
  `part.state.creditsUnit`) on text end, so `message.list` carries credits after
  sync/reload and fresh TUI mounts paint correct totals with no plugin store. The live
  event path still drops provider state at this commit, so the transient store
  remains purely as a live overlay during streaming turns; the durable-wins reconcile
  keeps totals exact and never double-counts.
- **Transient overlay hosted in TUI `storage.memory`.** The live-overlay state lives
  in the host's TUI memory storage (feature-detected, falls back to a local map), so
  it survives plugin hot reloads under the new npm-channel plugin management.
- **Provider activation.** The catalog transform was audited against the new required
  `Provider.Info.activation` field; providerID-scoped `aisdk` hooks are used where the
  promise API exposes them.

### Removed

- **Sidebar consent prompt.** Upstream deleted the integration prompts API in favor
  of forms (`Form.Fields` / `Form.Answer`), which forced the removal of the beta.1
  "Enable the Kiro credits sidebar?" select during `opencode auth login`. `tui: true`
  auto-load makes consent-driven TUI config pointless anyway. The "Kiro CLI Login"
  method now carries no form and no prompts; login behavior is otherwise unchanged.

### Known limitations

1. **Live text credits use the transient overlay.** At the tested commit the live
   `session.text.ended` reducer copies only the ended text and drops the event's
   provider state, so in-turn credit updates come from the plugin's transient overlay
   keyed by `(sessionID, assistantMessageID, ordinal)`. Durable state is authoritative
   on every reconcile; nothing is double-counted.
2. **Local `file:` installs render a per-slot TUI error.** The colon in a
   `name@file:<tarball>` install dirname defeats the host's OpenTUI loader shim. New
   at this snapshot: the failure is contained (a dismissible per-slot error notice
   instead of the beta.1 whole-TUI crash); transcript, composer, and built-ins keep
   working. Registry installs are colon-free and fully verified.
3. **No dollar cost anywhere.** Kiro is subscription-metered; the catalog declares
   per-token `cost` 0, so every non-TUI cost surface (ACP clients, web, desktop,
   share pages, CLI cost output) shows $0.00 for Kiro sessions. Expected, not a defect.
4. **Prerelease pins are rigid.** All v2-sensitive pins are exact and the
   compatibility target is the single tested commit above.

## [0.5.0-beta.1] - 2026-07-29

First prerelease on the OpenCode v2 plugin contract.

### Compatibility

| Item | Value |
|---|---|
| Tested OpenCode commit (`upstream/v2` head) | `b47cfbee7c4fd24e5d73e5753b4755db62a92a63` |
| Package version | `0.5.0-beta.1` |

| Package | Pinned version | Where |
|---|---|---|
| `@opencode-ai/plugin` | `0.0.0-next-16420` | devDependencies + peerDependencies (exact) |
| `@opentui/solid` | `0.4.5` | dependencies (exact; peer floor and max published; bundler-external, never bundled) |
| `solid-js` | `1.9.12` | dependencies (exact; `@opentui/solid@0.4.5` peers this exactly; bundler-external, never bundled) |
| `kiro-acp-ai-provider` | `3.0.0` | dependencies (exact, unchanged from v1) |

`@opencode-ai/plugin@0.0.0-next-16420` was the only published layout matching the v2
contract at the tested commit; the `latest` / `beta` / `dev` dist-tags carried the
stale v1-era layout at the time.

### Changed (from 0.4.0)

- **Plugin contract.** Both entries moved from v1 wrapper properties to v2
  `{ id, setup(context) }` with aggregated, idempotent cleanup.
- **Auth.** Registers Integration `kiro` with the "Kiro CLI Login" OAuth method.
  Success stores a minimal `Credential.OAuth` presence record (`expires: 0`, no
  refresh callback); kiro-cli owns credential storage and refresh.
- **Models.** Discovery runs `listModels()` outside catalog transforms and applies
  the validated capture via transform + reload; exact ID intersection, effort-variant
  merge, and fail-open discipline are preserved from v1. A minimal self-registration
  fallback covers catalogs without a `kiro` entry.
- **Provider ownership.** The AISDK `sdk` hook always sets a plugin-owned
  `kiro-acp-ai-provider` instance (guarding against the host's dynamic provider
  creating an unowned one), with `cwd`, `agent`, `trustAllTools`, `mcpTimeout`, and
  `contextWindows` options.
- **Credits.** Read key-unwrapped from `part.state.credits` / `part.state.creditsUnit`
  (v1 read `part.metadata.kiro`). The TUI credits surface is sidebar-only: a live
  credits box in the v2 `sidebar.content` slot. The tested commit's typed slot set
  removed `session.composer.top`, so the composer chip was descoped and its
  information folded into the sidebar box.
- **Configuration.** Server plugin config uses the plural `plugins` array in OpenCode
  config; TUI plugin config uses the `plugins` array in the global `cli.json`.
  `tui.json` is legacy migration input only; the plugin never touches it in v2.

### Removed

- v1 behaviors: synthetic token expiry, `auth.json` sniffing, startup toast checks,
  and all consent-driven host-config file mutation.

### Known limitations

1. **No slot ordering.** V2 slots have no order parameter; the sidebar credits box
   renders where the host places `sidebar.content` contributions.
2. **Default styling instead of theme tokens.** The pinned snapshot exposes no
   supported theme-token API to plugin views.
3. **Reduced toast feedback.** Auth feedback is connect-flow text; the plugin's core
   deliberately does not depend on the churning TUI toast API.
4. **Live text-credits workaround.** At the tested commit the host TUI's
   `session.text.ended` reducer drops the event's provider state, so credits attached
   to a just-ended text part never reach durable TUI state during a live turn. The
   plugin works around this with a transient per-session store keyed by
   `(sessionID, assistantMessageID, ordinal)`; every durable read reconciles the store
   first so durable state stays authoritative and nothing is double-counted.
5. **Prerelease pins are rigid.** `@opentui/solid@0.4.5` is both the peer floor and
   the maximum published version, and it peers `solid-js@1.9.12` exactly.

## [0.4.0] - 2026-07-18

Stable OpenCode v1 line (`main` branch, npm `latest`; `opencode >= 1.16.0`). Uses the
v1 plugin contract throughout: singular `plugin` arrays in `opencode.json` and
`tui.json`, the `opencode plugin opencode-kiro` installer, and `part.metadata.kiro`
credits. Full documentation: the README at the `v0.4.0` tag.

[0.5.0-beta.5]: https://www.npmjs.com/package/opencode-kiro/v/0.5.0-beta.5
[0.5.0-beta.4]: https://www.npmjs.com/package/opencode-kiro/v/0.5.0-beta.4
[0.5.0-beta.3]: https://www.npmjs.com/package/opencode-kiro/v/0.5.0-beta.3
[0.5.0-beta.2]: https://www.npmjs.com/package/opencode-kiro/v/0.5.0-beta.2
[0.5.0-beta.1]: https://www.npmjs.com/package/opencode-kiro/v/0.5.0-beta.1
[0.4.0]: https://github.com/NachoFLizaur/opencode-kiro/tree/v0.4.0
