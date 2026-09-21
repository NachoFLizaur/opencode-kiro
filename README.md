# opencode-kiro

An [OpenCode V2](https://opencode.ai/v2/docs/) plugin for models supplied by
[Kiro CLI](https://kiro.dev/docs/cli/) through `kiro-acp-ai-provider`.

It applies Kiro ACP runtime settings to the configured Kiro provider and shows
per-session Kiro credit usage in the terminal sidebar.

## Requirements

- Node.js 20 or newer
- OpenCode 2.0 or newer
- `kiro-cli` installed and authenticated (`kiro-cli login`)
- A configured `kiro` provider using `kiro-acp-ai-provider`

The ACP provider owns the Kiro CLI process and authentication. This plugin does
not read, store, or transmit Kiro credentials.

## Configuration

Add the server plugin to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-kiro"]
}
```

Add the terminal plugin to `~/.config/opencode/cli.json`:

```jsonc
{
  "plugins": ["opencode-kiro"]
}
```

The Kiro provider and its models must be available in your OpenCode provider
catalog/configuration. Once configured, select a model such as
`kiro/claude-sonnet-4.6`.

## Local development

```bash
npm install
npm test
```

Point both V2 plugin lists at the checkout:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-kiro"]
}
```

Run `npm run build` after changing source. The root `index.js` and `tui.js`
files make a local plugin directory resolvable by OpenCode V2; they are also
included in the npm package.

## Verification

```bash
opencode plugin list
opencode run --model kiro/claude-sonnet-4.6 "Reply with exactly: KIRO OK"
```

## Development checks

```bash
npm test
npm run typecheck
npm pack --dry-run
```

## License

MIT
