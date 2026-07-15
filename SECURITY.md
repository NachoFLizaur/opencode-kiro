# Security Policy

## Supported versions

Only the latest published version on npm receives security fixes. At time of writing that is `opencode-kiro@0.3.6`. Please upgrade before reporting.

## Scope and threat model

This plugin does not store or transmit AWS credentials itself. Authentication is delegated to the official `kiro-cli`, which owns the AWS IAM Identity Center (SSO) token and caches it under your home directory (`~/.aws/sso/cache`). The plugin only reads opencode's own stored auth marker (`auth.json`) to decide whether to activate, and forwards prompts to a locally spawned `kiro-cli` process over the Agent Client Protocol (ACP). It sends no credentials, prompt content, or telemetry anywhere beyond that local process and the Kiro service that `kiro-cli` connects to.

Like opencode itself, the agent is not sandboxed; the plugin runs within opencode's trust and permission model.

Out of scope:

| Area | Where to report |
| ---- | --------------- |
| Bugs in `kiro-cli` or the Kiro service | Amazon Web Services |
| How the Kiro service handles your data | Governed by AWS policy |
| opencode core, its permission model, or plugin loader | The opencode project |
| Your own opencode config or `plugin` list (user-controlled) | Not a vulnerability |

## Reporting a vulnerability

Please report security issues privately through GitHub. Open the repo's **Security** tab and choose **Report a vulnerability** to file a private advisory.

Do not open a public issue for security problems.

Include what you found, affected version, and steps to reproduce if you have them.

## AI-generated reports

Low-effort or obviously AI-generated security reports may be closed without a response. Please only open a report you have understood and verified yourself.

## What to expect

This is a single-maintainer project, so responses are best effort. Expect an initial acknowledgement within about 7 days. Fixes for confirmed issues are shipped as a new npm release and disclosed once a patch is available.
