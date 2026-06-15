import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, test } from "vitest"

// Built-package smoke tests: run `npm run build` first. Covers exports
// resolution, discoverable metadata, emitted artifacts, the loader's
// module-kind isolation rule, and host-package externalization.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const distPath = (name: string): string => join(ROOT, "dist", name)

interface ExportsEntry {
  types?: string
  default?: string
}

interface PackageJson {
  exports: Record<string, ExportsEntry | string>
  keywords?: string[]
  peerDependencies?: Record<string, string>
  files?: string[]
}

const readPkg = async (): Promise<PackageJson> =>
  JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as PackageJson

/** Import a built module via a runtime URL so tsc never resolves dist/. */
const importDist = (name: string): Promise<{ default: Record<string, unknown> }> =>
  import(pathToFileURL(distPath(name)).href) as Promise<{ default: Record<string, unknown> }>

/**
 * Blank out every module specifier (import / export-from / require) so residual
 * package names reveal a bundled external, e.g. an esbuild inlined-source path.
 */
const withoutImportSpecifiers = (code: string): string =>
  code.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])[^"']*\2/g,
    (_match, keyword: string, quote: string) => `${keyword}${quote}${quote}`,
  )

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
    expect(pkg.peerDependencies?.["@opencode-ai/plugin"]).toBe("*")
    expect(pkg.files).toEqual(["dist"])
  })

  test("build emits all four artifacts", () => {
    const artifacts = ["server.js", "server.d.ts", "tui.js", "tui.d.ts"]

    const missing = artifacts.filter((artifact) => !existsSync(distPath(artifact)))

    expect(missing).toEqual([])
  })

  test("server module shape: has server, never tui", async () => {
    const mod = await importDist("server.js")

    expect(typeof mod.default.server).toBe("function")
    expect(mod.default.id).toBe("kiro")
    // Loader rejects modules exporting both kinds: `tui` must be absent, not
    // merely undefined.
    expect("tui" in mod.default).toBe(false)
    expect(mod.default.tui).toBeUndefined()
  })

  test("tui module shape: has tui, never server", async () => {
    const mod = await importDist("tui.js")

    // Loader rejects non-function `tui`, so it must be function-valued.
    expect(typeof mod.default.tui).toBe("function")
    expect("server" in mod.default).toBe(false)
    expect(mod.default.server).toBeUndefined()
  })

  test("host packages are not bundled", async () => {
    const builtModules = ["server.js", "tui.js"]

    for (const file of builtModules) {
      const code = await readFile(distPath(file), "utf8")
      const residue = withoutImportSpecifiers(code)

      // Externals may appear only as import specifiers; any residual mention
      // means the host/SDK package was bundled instead of left external.
      expect(residue).not.toContain("kiro-acp-ai-provider")
      expect(residue).not.toContain("@opencode-ai/plugin")
    }
  })
})
