import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

// Built-package smoke tests: run `npm run build` first. Covers exports
// resolution, discoverable metadata, exact host-sensitive pins, the installed
// plugin tarball's exports layout, emitted artifacts, the { id, setup } module
// contracts, idempotent cleanup, module-kind isolation, host-package
// externalization, and repository hygiene (no internal working notes in the
// tree).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const distPath = (name: string): string => join(ROOT, "dist", name)

interface ExportsEntry {
  types?: string
  default?: string
}

interface PackageJson {
  version?: string
  exports: Record<string, ExportsEntry | string>
  keywords?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  files?: string[]
}

const readPkg = async (): Promise<PackageJson> =>
  JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as PackageJson

/** the package version, read once from package.json — the single source every version-bearing assertion derives from */
const PKG_VERSION = (await readPkg()).version ?? ""

/** docs that mirror the pins: the compatibility table and the changelog (current version's section) */
const COMPATIBILITY_DOC = join("docs", "COMPATIBILITY.md")
const CHANGELOG_DOC = "CHANGELOG.md"

/**
 * The Keep-a-Changelog section for `version`: from its `## [version]` heading up
 * to the next `## ` heading (or end of file). Empty string when absent.
 */
const changelogSection = (changelog: string, version: string): string => {
  const heading = `## [${version}]`
  const start = changelog.indexOf(heading)
  if (start === -1) return ""
  const next = changelog.indexOf("\n## ", start + heading.length)
  return next === -1 ? changelog.slice(start) : changelog.slice(start, next)
}

/** plugin module shape: `{ id, setup }` with a callable setup. */
interface PluginModule {
  id?: unknown
  setup?: unknown
  [key: string]: unknown
}

/** Import a built module via a runtime URL so tsc never resolves dist/. */
const importDist = (name: string): Promise<{ default: PluginModule } & Record<string, unknown>> =>
  import(pathToFileURL(distPath(name)).href) as Promise<{ default: PluginModule } & Record<string, unknown>>

/**
 * Blank out every module specifier (import / export-from / require) so residual
 * package names reveal a bundled external, e.g. an esbuild inlined-source path.
 */
const withoutImportSpecifiers = (code: string): string =>
  code.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])[^"']*\2/g,
    (_match, keyword: string, quote: string) => `${keyword}${quote}${quote}`,
  )

/**
 * Package-name string constants that legitimately carry the SDK package name
 * in module bodies: the `event.package` match value (bare name) and the
 * `Provider.Info.package` value (`aisdk:`-prefixed). Blank their quoted
 * literals so the zero-residue check flags only real bundling. Longest first
 * so the prefixed literal is consumed before the bare one.
 */
const MANDATED_PACKAGE_LITERALS = ["aisdk:kiro-acp-ai-provider", "kiro-acp-ai-provider"]

const withoutMandatedLiterals = (code: string): string =>
  MANDATED_PACKAGE_LITERALS.reduce(
    (acc, literal) => acc.replaceAll(`"${literal}"`, '""').replaceAll(`'${literal}'`, "''"),
    code,
  )

/**
 * Minimal mock Plugin.Context: just enough surface for the server setup's
 * five registrations (auth, discovery, logout detector, retry guard, aisdk)
 * plus the event consumer. Registrations return
 * async disposers; the event stream ends immediately; the connection reads
 * inactive so no discovery kicks off.
 */
const makeMinimalContext = (): unknown => {
  const registration = { dispose: async () => {} }
  return {
    integration: {
      transform: async () => registration,
      list: async () => ({ location: { directory: ROOT } }),
      connection: { active: async () => false },
      reload: async () => {},
    },
    provider: {
      transform: async () => registration,
      reload: async () => {},
    },
    session: { hook: async () => registration },
    aisdk: { hook: async () => registration },
    event: { subscribe: () => (async function* () {})() },
  }
}

/**
 * Minimal mock TUI Plugin.Context: the host always supplies `data` and `ui`,
 * so the setup contract may rely on them. Event subscription and slot
 * registration return unsubscribe functions; durable reads return no
 * messages.
 */
const makeMinimalTuiContext = (): unknown => ({
  data: {
    on: () => () => {},
    session: { message: { list: () => [] } },
  },
  ui: { slot: () => () => {} },
})

describe("scaffold package contract", () => {
  test("exports map exposes exactly ./server and ./tui subpaths", async () => {
    const pkg = await readPkg()

    expect(Object.keys(pkg.exports).sort()).toEqual(["./package.json", "./server", "./tui"])
    expect(pkg.exports["./server"]).toEqual({ types: "./dist/server.d.ts", default: "./dist/server.js" })
    expect(pkg.exports["./tui"]).toEqual({ types: "./dist/tui.d.ts", default: "./dist/tui.js" })
  })

  test("package metadata is plugin-discoverable", async () => {
    const pkg = await readPkg()

    expect(pkg.keywords).toContain("opencode")
    expect(pkg.keywords).toContain("opencode-plugin")
    expect(pkg.files).toEqual(["dist"])
  })

  test("build emits all four artifacts", () => {
    const artifacts = ["server.js", "server.d.ts", "tui.js", "tui.d.ts"]

    const missing = artifacts.filter((artifact) => !existsSync(distPath(artifact)))

    expect(missing).toEqual([])
  })

  test("credits-chip chunk is emitted alongside the box chunk (footer credits chip)", async () => {
    // the chip view (claimed at prompt.footer.status) lazy-imports as its own
    // chunk — both view chunks must be emitted.
    const distFiles = await readdir(join(ROOT, "dist"))

    expect(distFiles.some((file) => file.includes("credits-chip-view"))).toBe(true)
    expect(distFiles.some((file) => file.includes("credits-box-view"))).toBe(true)
  })
})

describe("dependency pins and installed plugin API", () => {
  test("version is a valid semver string", async () => {
    const pkg = await readPkg()

    expect(pkg.version).toBe(PKG_VERSION)
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  })

  test("host-sensitive deps are exact pins", async () => {
    const pkg = await readPkg()

    // exact expected specifier per dependency block; no `^`/`~`/`*`, no dist-tag
    const expected: Array<[Record<string, string> | undefined, string, string]> = [
      [pkg.devDependencies, "@opencode/plugin", "2.0.20"],
      [pkg.dependencies, "@opentui/solid", "0.5.12"],
      [pkg.dependencies, "solid-js", "1.9.12"],
      [pkg.dependencies, "kiro-acp-ai-provider", "3.3.0"],
    ]

    for (const [block, name, version] of expected) {
      const specifier = block?.[name]
      expect(specifier, `${name} must be pinned exactly`).toBe(version)
      expect(specifier).not.toMatch(/[\^~*]/)
      expect(specifier).not.toMatch(/^(next|latest|beta|dev)$/)
    }

    // the plugin development pin is an exact 2.0.x release (never a dist-tag):
    // the shape check plus the equality above pins the verified `2.0.20`.
    expect(pkg.devDependencies?.["@opencode/plugin"]).toMatch(/^2\.0\.\d+$/)
  })

  test("installed plugin package has the current exports layout", async () => {
    const installed = JSON.parse(
      await readFile(join(ROOT, "node_modules", "@opencode", "plugin", "package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> }

    const subpaths = Object.keys(installed.exports ?? {})
    expect(subpaths).toContain(".")
    expect(subpaths).toContain("./effect")
    expect(subpaths).toContain("./tui")
    // an older layout routed the promise API through ./v2/promise; reject it
    expect(subpaths).not.toContain("./v2/promise")
    // the 2.x plugin API has no ./v1 compatibility subpath
    expect(subpaths).not.toContain("./v1")
  })
})

describe("module entry contracts", () => {
  test("server entry exports { id: 'kiro', setup } without a tui flag", async () => {
    const mod = await importDist("server.js")

    expect(mod.default.id).toBe("kiro")
    expect(typeof mod.default.setup).toBe("function")
    // The host discovers the TUI half from the package's ./tui export.
    expect("tui" in mod.default).toBe(false)
    // named export kept for compatibility; same reference as the default so they can't drift
    expect(mod.KiroAuthPlugin).toBe(mod.default)
    // loader rejects modules exposing both kinds: no legacy wrapper properties anywhere
    expect("server" in mod.default).toBe(false)
  })

  test("tui entry exports { id: 'opencode-kiro', setup }", async () => {
    const mod = await importDist("tui.js")

    expect(mod.default.id).toBe("opencode-kiro")
    expect(typeof mod.default.setup).toBe("function")
    expect("server" in mod.default).toBe(false)
    expect("tui" in mod.default).toBe(false)
  })

  test("tui dist loads under plain Node", async () => {
    // vitest runs in the node environment: a successful import proves the
    // Bun-native @opentui/core runtime is not pulled eagerly (lazy-import rule)
    await expect(importDist("tui.js")).resolves.toBeDefined()
  })

  test("host packages are not bundled", async () => {
    const builtModules = ["server.js", "tui.js"]

    for (const file of builtModules) {
      const code = await readFile(distPath(file), "utf8")
      const residue = withoutMandatedLiterals(withoutImportSpecifiers(code))

      // Externals may appear as import specifiers (which must survive the
      // build — server.js lazily imports the SDK) or as the package-name
      // constants; any other residual mention means the host/SDK package was
      // bundled instead of left external.
      expect(residue).not.toContain("kiro-acp-ai-provider")
      expect(residue).not.toContain("@opencode/plugin")
      expect(residue).not.toContain("@opentui")
      expect(residue).not.toContain("solid-js")
    }

    // the lazy SDK imports must remain literal external specifiers
    const serverCode = await readFile(distPath("server.js"), "utf8")
    expect(serverCode).toContain('import("kiro-acp-ai-provider")')
  })

  test("server dist uses provider discovery without removed domains or model transforms", async () => {
    const code = await readFile(distPath("server.js"), "utf8")
    expect(code).toContain("provider.transform")
    expect(code).toContain("provider.reload")
    for (const removed of ["context.catalog", "catalog.transform", "catalog.reload", "CatalogDraft", "model.transform"]) {
      expect(code).not.toContain(removed)
    }
  })

  test("server cleanup is idempotent", async () => {
    const mod = await importDist("server.js")
    const setup = mod.default.setup as (context: unknown) => Promise<() => Promise<void>>

    // server setup registers auth/discovery/aisdk, so it needs the minimal context
    const cleanup = await setup(makeMinimalContext())

    await expect(cleanup()).resolves.toBeUndefined()
    await expect(cleanup()).resolves.toBeUndefined() // second call is a no-op
  })

  test("tui cleanup is idempotent", async () => {
    const mod = await importDist("tui.js")
    const setup = mod.default.setup as (context: unknown) => Promise<() => Promise<void>>

    const cleanup = await setup(makeMinimalTuiContext())

    await expect(cleanup()).resolves.toBeUndefined()
    await expect(cleanup()).resolves.toBeUndefined() // second call is a no-op
  })
})

// --- packaging / entry-resolution tests ---

const execFileAsync = promisify(execFile)
const IS_WIN = process.platform === "win32"

/** Run npm via execFile; Windows needs npm.cmd + shell. */
const runNpm = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync(IS_WIN ? "npm.cmd" : "npm", args, {
    cwd,
    shell: IS_WIN,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

/**
 * Run an ESM snippet in a real child Node process with the given cwd. Bare
 * specifiers then resolve with native Node semantics from that directory —
 * vitest's own resolver (which sees this repo's node_modules) never
 * participates, so the probe behaves exactly like the OpenCode host loading
 * the installed package.
 */
const nodeProbe = async (cwd: string, code: string): Promise<string> => {
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", code], { cwd })
  return stdout.trim()
}

/** host-sensitive pins derived from package.json — the single source the docs must mirror. */
const hostSensitivePins = async (): Promise<Array<[name: string, version: string]>> => {
  const pkg = await readPkg()
  return [
    ["@opencode/plugin", pkg.devDependencies?.["@opencode/plugin"] ?? ""],
    ["@opentui/solid", pkg.dependencies?.["@opentui/solid"] ?? ""],
    ["solid-js", pkg.dependencies?.["solid-js"] ?? ""],
    ["kiro-acp-ai-provider", pkg.dependencies?.["kiro-acp-ai-provider"] ?? ""],
  ]
}

const TESTED_OPENCODE_SHA = "84c9be93a56304a108f1a22df0c5d62c26d5b6ca"

describe("packaging and docs invariants", () => {
  test("pack payload is dist-only", async () => {
    const stdout = await runNpm(["pack", "--dry-run", "--json"], ROOT)
    const [manifest] = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>
    const paths = manifest.files.map((file) => file.path)

    // tarball name embeds the package version
    expect(manifest.filename).toBe(`opencode-kiro-${PKG_VERSION}.tgz`)

    // exhaustive whitelist: built artifacts + the three npm-mandated metadata files
    const stray = paths.filter(
      (path) => !(path.startsWith("dist/") || path === "package.json" || path === "README.md" || path === "LICENSE"),
    )
    expect(stray).toEqual([])

    // never ship sources or tests, even if `files` drifts
    expect(paths.filter((path) => path.startsWith("src/") || path.startsWith("test/"))).toEqual([])

    // the four required artifacts must actually be in the payload
    for (const required of ["package.json", "README.md", "dist/server.js", "dist/tui.js"]) {
      expect(paths).toContain(required)
    }
    expect(paths.some((path) => path === "dist/server.d.ts")).toBe(true)
    expect(paths.some((path) => path === "dist/tui.d.ts")).toBe(true)
  }, 60_000)

  test("pins consistent across package.json / docs/COMPATIBILITY / CHANGELOG / README", async () => {
    const pkg = await readPkg()
    const pins = await hostSensitivePins()
    // `fullPinTable: true` docs must mirror every host-sensitive pin row; README
    // deliberately carries only the plugin-API pin + package version + tested SHA
    // (it defers the full table to docs/COMPATIBILITY.md), so it is checked against
    // exactly those strings — enough to fail the suite on a stale README pin.
    // The changelog is checked on the CURRENT version's section only: older
    // sections legitimately carry the pins they shipped with.
    const changelog = await readFile(join(ROOT, CHANGELOG_DOC), "utf8")
    const currentSection = changelogSection(changelog, PKG_VERSION)
    expect(currentSection, `${CHANGELOG_DOC} has a "## [${PKG_VERSION}]" section`).not.toBe("")

    const docs: Array<{ label: string; content: string; fullPinTable: boolean }> = [
      {
        label: COMPATIBILITY_DOC,
        content: await readFile(join(ROOT, COMPATIBILITY_DOC), "utf8"),
        fullPinTable: true,
      },
      {
        label: `${CHANGELOG_DOC} [${PKG_VERSION}]`,
        content: currentSection,
        fullPinTable: true,
      },
      { label: "README.md", content: await readFile(join(ROOT, "README.md"), "utf8"), fullPinTable: false },
    ]

    // The host supplies the plugin API at runtime; no peer is declared.
    expect(pkg.peerDependencies?.["@opencode/plugin"]).toBeUndefined()

    for (const [name, version] of pins) {
      expect(version, `${name} must be pinned in package.json`).not.toBe("")
    }

    for (const { label, content, fullPinTable } of docs) {
      if (fullPinTable) {
        // each doc's pin-table row must carry exactly the package.json specifier;
        // any drift in either direction breaks the row match
        for (const [name, version] of pins) {
          const row = `| \`${name}\` | \`${version}\` |`
          expect(content, `${label} row for ${name}@${version}`).toContain(row)
        }
      } else {
        // scoped check: plugin-API pin row (trailing cell text is free-form) + tested SHA
        const pluginPin = pkg.devDependencies?.["@opencode/plugin"] ?? ""
        expect(content, `${label} row for @opencode/plugin@${pluginPin}`).toContain(
          `| \`@opencode/plugin\` | \`${pluginPin}\``,
        )
        expect(content, `${label} tested SHA`).toContain(TESTED_OPENCODE_SHA)
      }
      // package version string agrees
      expect(content, `${label} package version`).toContain(PKG_VERSION)
    }
    expect(pkg.version).toBe(PKG_VERSION)
  })

  test("README documents plural plugins and that cli.json is not used", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8")

    // plural config key sample present, and cli.json is mentioned (as not used)
    expect(readme).toContain('"plugins": [')
    expect(readme).toContain("cli.json")

    // no config snippet targets tui.json and no legacy singular `plugin` array survives
    const codeBlocks = readme.match(/```[\s\S]*?```/g) ?? []
    expect(codeBlocks.length).toBeGreaterThan(0)
    for (const block of codeBlocks) {
      expect(block).not.toContain("tui.json")
      expect(block).not.toContain('"plugin": [')
    }
  })

  test("README documents options for configured npm and local directory plugins", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8")

    // the options table lists every accepted key with its default: a row whose
    // first cell is the backticked name and whose third cell is the backticked default
    const options: Array<[name: string, defaultValue: string]> = [
      ["agent", '"opencode"'],
      ["mcpTimeout", "45"],
      ["discover", "true"],
    ]
    for (const [name, defaultValue] of options) {
      const row = new RegExp(`^\\| \`${name}\` \\|[^|\\n]*\\| \`${defaultValue}\` \\|`, "m")
      expect(readme, `options table row for ${name} with default ${defaultValue}`).toMatch(row)
    }

    // Configured npm and local directory sources receive options; bundled or
    // built-in loads receive {}. Keep both the distinction and the object form.
    expect(readme).toMatch(/options are honored for configured plugins: npm specs and local directory specs/i)
    expect(readme).toMatch(/bundled or built-in plugin loads receive `\{\}`/i)
    expect(readme).toMatch(/"options":\s*\{\}/)

    // the working directory is derived per location, never user-supplied
    expect(readme).toMatch(/no `cwd` option/i)
  })

  test("README options snippet uses the plural plugins config", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8")
    const codeBlocks = readme.match(/```[\s\S]*?```/g) ?? []

    // the options example must ride the real config shape: an object entry
    // inside the plural `plugins` array, carrying at least one option key
    const optionKeys = ['"agent"', '"mcpTimeout"', '"discover"']
    const optionsSnippets = codeBlocks.filter(
      (block) =>
        block.includes('"plugins": [') &&
        block.includes('"options"') &&
        optionKeys.some((key) => block.includes(key)),
    )

    expect(optionsSnippets.length).toBeGreaterThan(0)
    // and no snippet ever attaches options to a legacy singular `plugin` array
    for (const block of optionsSnippets) {
      expect(block).not.toContain('"plugin": [')
    }
  })

  test("docs/COMPATIBILITY and the current CHANGELOG section carry the tested opencode SHA and no floating tags", async () => {
    const changelog = await readFile(join(ROOT, CHANGELOG_DOC), "utf8")
    const docs: Array<[label: string, content: string]> = [
      [COMPATIBILITY_DOC, await readFile(join(ROOT, COMPATIBILITY_DOC), "utf8")],
      [`${CHANGELOG_DOC} [${PKG_VERSION}]`, changelogSection(changelog, PKG_VERSION)],
    ]

    for (const [file, content] of docs) {
      expect(content, `${file} tested SHA`).toContain(TESTED_OPENCODE_SHA)

      // no `pkg@latest` / `pkg@next` / `pkg@beta` / `pkg@dev` install specifier anywhere
      // (`2.0.20` is an exact release version, not a dist-tag)
      expect(content, `${file} floating dist-tag`).not.toMatch(/@(latest|next|beta|dev)(?![\w.-])/)
      // and no floating range specifiers for the host-sensitive deps
      for (const [name] of await hostSensitivePins()) {
        expect(content, `${file} floating range for ${name}`).not.toMatch(new RegExp(`\`${name}\`\\s*\\|\\s*\`[~^*]`))
      }
    }
  })
})

// --- repository hygiene ---

/**
 * Word literals below are written with a `~` inside them and joined at runtime.
 * The hygiene pattern would otherwise match its own source in this file — the
 * splitter keeps the forbidden spellings out of the tree while still letting a
 * reader see what is banned.
 */
const spell = (split: string): string => split.replaceAll("~", "")

/**
 * Internal working vocabulary that must not leak into shipped sources or tests:
 * planning shorthand (task/item/phase/workstream numbers), review-note tone
 * words, first-person prose, names of internal record files, and line-number
 * citations that rot the moment a file changes. Mirrors the tidy-up sweep's
 * acceptance search so the tree cannot drift back.
 */
const JARGON_PATTERN = new RegExp(
  [
    "\\(ta~sk \\d+\\)",
    "ta~sk \\d\\d",
    "R~eq \\d",
    "It~em \\d",
    "It~ems \\d",
    "be~ta\\.\\d at~om",
    "\\bat~om\\b",
    "\\bB~3\\b",
    "\\bB~2\\b",
    "Ph~ase \\d",
    "W~S-\\d",
    "\\b4~b\\b",
    "\\b5~b\\b",
    "wit~ness",
    "ha~nd gu~ard",
    "para~noia",
    "be~lt-and",
    "got~cha",
    "\\bw~e\\b",
    "HOST_E2E~_REPORT",
    "migra~tion doc",
    "pre-pub~lish amend~ment",
    ":\\d+-\\d+\\)",
    "\\.ts:\\d+",
  ]
    .map(spell)
    .join("|"),
  "g",
)

/**
 * Justified exceptions to the jargon pattern, keyed by repo-relative file and
 * the exact matched text. Each entry needs a one-line reason so the exception
 * is auditable here rather than hidden in a comment elsewhere. Currently empty.
 */
const JARGON_ALLOWLIST: ReadonlyArray<{ file: string; match: string; reason: string }> = []

/** Internal record files that used to live at the repo root; they now live outside the tree. */
const ROOT_LEDGER_FILES = ["HOST_E2E~_REPORT.md", "OPENCODE_V2_MIGRATION.md", "PINNED_VERSIONS.md"].map(spell)
const ROOT_LEDGER_GLOB = /^RELEASE_NOTES_.*\.md$/

/** Repo-relative paths of every `.ts` file under `dir`, sorted for stable failure output. */
const listTypeScriptFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(join(ROOT, dir), { recursive: true })
  return entries
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(dir, entry))
    .sort()
}

describe("repository hygiene", () => {
  test("src and test files carry no workflow jargon", async () => {
    const files = [...(await listTypeScriptFiles("src")), ...(await listTypeScriptFiles("test"))]
    expect(files.length).toBeGreaterThan(0)

    const hits: Array<{ file: string; line: number; match: string }> = []
    for (const file of files) {
      const content = await readFile(join(ROOT, file), "utf8")
      for (const found of content.matchAll(JARGON_PATTERN)) {
        const line = content.slice(0, found.index).split("\n").length
        hits.push({ file, line, match: found[0] })
      }
    }

    const allowed = (hit: { file: string; match: string }): boolean =>
      JARGON_ALLOWLIST.some((entry) => entry.file === hit.file && entry.match === hit.match)

    // every hit must be an enumerated exception; report as file:line so a
    // failure points straight at the offending text
    const unexpected = hits.filter((hit) => !allowed(hit)).map((hit) => `${hit.file}:${hit.line}: ${hit.match}`)
    expect(unexpected).toEqual([])

    // and every exception must still be needed, so the allowlist cannot go stale
    const stale = JARGON_ALLOWLIST.filter(
      (entry) => !hits.some((hit) => hit.file === entry.file && hit.match === entry.match),
    )
    expect(stale).toEqual([])
  })

  test("repo root carries no workflow ledger files", async () => {
    const rootEntries = await readdir(ROOT)

    const ledgers = rootEntries.filter((name) => ROOT_LEDGER_FILES.includes(name) || ROOT_LEDGER_GLOB.test(name))

    expect(ledgers).toEqual([])
  })

  test("CHANGELOG has a section for the current version", async () => {
    const changelog = await readFile(join(ROOT, CHANGELOG_DOC), "utf8")

    // the heading must open a line (Keep-a-Changelog `## [version]`); a date or
    // an "Unreleased" marker may follow while the version is still unpublished
    const heading = `## [${PKG_VERSION}]`
    const headingLines = changelog.split("\n").filter((line) => line.startsWith(heading))
    expect(headingLines, `${CHANGELOG_DOC} heading "${heading}"`).toHaveLength(1)

    // and the section carries body text, not just a bare heading
    expect(changelogSection(changelog, PKG_VERSION).trim().length).toBeGreaterThan(heading.length)
  })
})

describe("packed tarball entry resolution", () => {
  let workDir: string
  let consumerDir: string
  let installedPluginDir: string

  // Single real pack + single hermetic temp-dir install, reused by every test
  // below. `--cache` points at a throwaway cache; `--omit=peer` remains for
  // the hermetic install even though this package declares no peers.
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "opencode-kiro-pack-"))
    consumerDir = join(workDir, "consumer")

    const packJson = await runNpm(["pack", "--json", "--pack-destination", workDir], ROOT)
    const [{ filename }] = JSON.parse(packJson) as Array<{ filename: string }>
    const tarball = join(workDir, filename)

    await mkdir(consumerDir)
    await writeFile(
      join(consumerDir, "package.json"),
      JSON.stringify({ name: "opencode-kiro-consumer", private: true, type: "module" }, null, 2),
    )

    await runNpm(
      [
        "install",
        tarball,
        "--omit=peer",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(workDir, "npm-cache"),
      ],
      consumerDir,
    )
    installedPluginDir = join(consumerDir, "node_modules", "opencode-kiro")
  }, 300_000)

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true })
  })

  test("packed ./server resolves and exposes the plugin shape", async () => {
    const out = await nodeProbe(
      consumerDir,
      `const mod = await import("opencode-kiro/server");
       console.log(JSON.stringify({
         id: mod.default?.id,
         setup: typeof mod.default?.setup,
         hasTuiProp: Object.hasOwn(mod.default ?? {}, "tui"),
         hasServerProp: "server" in (mod.default ?? {}),
         namedIsDefault: mod.KiroAuthPlugin === mod.default,
       }));`,
    )

    // No server-side TUI flag: discovery uses the package's ./tui export.
    expect(JSON.parse(out)).toEqual({
      id: "kiro",
      setup: "function",
      hasTuiProp: false,
      hasServerProp: false,
      namedIsDefault: true,
    })
  }, 30_000)

  test("packed ./tui resolves without server-only or Bun-native load", async () => {
    const out = await nodeProbe(
      consumerDir,
      `const mod = await import("opencode-kiro/tui");
       console.log(JSON.stringify({
         id: mod.default?.id,
         setup: typeof mod.default?.setup,
         hasServerProp: "server" in (mod.default ?? {}),
         hasTuiProp: "tui" in (mod.default ?? {}),
         crossEntryLeak: "KiroAuthPlugin" in mod,
       }));`,
    )

    // plain-Node import succeeds (no eager Bun-native @opentui/core) and the
    // module carries only the TUI plugin — no server-entry leakage
    expect(JSON.parse(out)).toEqual({
      id: "opencode-kiro",
      setup: "function",
      hasServerProp: false,
      hasTuiProp: false,
      crossEntryLeak: false,
    })
  }, 30_000)

  test("root fallback understood", async () => {
    // the exports map intentionally lacks a root (".") entry, so the host's
    // root fallback yields no entrypoint and `./server` (tried first) wins.
    // Both halves of that contract are asserted here.
    const pkg = await readPkg()
    expect(Object.keys(pkg.exports)).not.toContain(".")

    const out = await nodeProbe(
      consumerDir,
      `try {
         await import("opencode-kiro");
         console.log(JSON.stringify({ resolved: true }));
       } catch (error) {
         console.log(JSON.stringify({ resolved: false, code: error.code }));
       }`,
    )
    expect(JSON.parse(out)).toEqual({ resolved: false, code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
  }, 30_000)

  test("packed TUI runtime dependencies resolve and setup activates", async () => {
    // The host installs the tarball into an isolated tree containing only its
    // declared dependencies, so the TUI entry's lazily-imported view stack must
    // be resolvable from there and setup() must activate. This requires
    // @opentui/solid + solid-js to be declared as real `dependencies` (they
    // stay bundler externals, so dist never inlines them; @opentui/core arrives
    // transitively via @opentui/solid, which depends on it exactly).
    const tuiPath = join(installedPluginDir, "dist", "tui.js")
    const out = await nodeProbe(
      consumerDir,
      `import { createRequire } from "node:module";
       const req = createRequire(${JSON.stringify(tuiPath)});
       const result = { resolved: {}, activated: false, error: null };
       for (const dep of ["@opentui/solid", "solid-js"]) {
         try { req.resolve(dep); result.resolved[dep] = true } catch { result.resolved[dep] = false }
       }
       try {
         const mod = await import("opencode-kiro/tui");
         // minimal host-shaped TUI context (host always supplies data + ui)
         const context = {
           data: { on: () => () => {}, session: { message: { list: () => [] } } },
           ui: { slot: () => () => {} },
         };
         const cleanup = await mod.default.setup(context);
         result.activated = true;
         await cleanup();
       } catch (error) {
         result.error = String((error && error.message) || error);
       }
       console.log(JSON.stringify(result));`,
    )

    expect(JSON.parse(out)).toEqual({
      resolved: { "@opentui/solid": true, "solid-js": true },
      activated: true,
      error: null,
    })
  }, 30_000)
})
