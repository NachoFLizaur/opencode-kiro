import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, test } from "vitest"
import serverPlugin from "../src/index"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const dist = (name: string) => join(root, "dist", name)

const importDist = (name: string): Promise<{ default: Record<string, unknown> }> =>
  import(pathToFileURL(dist(name)).href) as Promise<{ default: Record<string, unknown> }>

describe("OpenCode V2 package contract", () => {
  test("exports only the V2 server and terminal entrypoints", async () => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      exports: Record<string, unknown>
      files: string[]
      peerDependencies: Record<string, string>
    }

    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./package.json", "./tui"])
    expect(pkg.exports["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" })
    expect(pkg.exports["./tui"]).toEqual({ types: "./dist/tui.d.ts", default: "./dist/tui.js" })
    expect(pkg.files).toEqual(["dist", "index.js", "tui.js"])
    expect(pkg.peerDependencies["@opencode/plugin"]).toBe(">=2.0.0")
  })

  test("build emits V2 entrypoints", async () => {
    expect(existsSync(dist("index.js"))).toBe(true)
    expect(existsSync(dist("tui.js"))).toBe(true)

    const [server, tui] = await Promise.all([importDist("index.js"), importDist("tui.js")])
    expect(server.default.id).toBe("opencode-kiro")
    expect(typeof server.default.setup).toBe("function")
    expect(tui.default.id).toBe("opencode-kiro")
    expect(typeof tui.default.setup).toBe("function")
  })

  test("applies ACP settings only when the Kiro provider exists", async () => {
    let updated: Record<string, unknown> | undefined
    const editor = {
      get: (id: string) => (id === "kiro" ? {} : undefined),
      update: (id: string, apply: (entry: { settings?: Record<string, unknown> }) => void) => {
        expect(id).toBe("kiro")
        const entry: { settings?: Record<string, unknown> } = { settings: { preserved: true } }
        apply(entry)
        updated = entry.settings
      },
    }
    const context = {
      location: { directory: "/workspace" },
      provider: { transform: async (apply: (value: typeof editor) => void) => apply(editor) },
    }

    await serverPlugin.setup(context as never)

    expect(updated).toEqual({
      preserved: true,
      cwd: "/workspace",
      agent: "opencode",
      trustAllTools: true,
      mcpTimeout: 45,
    })
  })
})
