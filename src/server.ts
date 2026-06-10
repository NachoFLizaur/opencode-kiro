import type { Hooks, PluginInput } from "@opencode-ai/plugin"

// V1 server plugin module (opencode shared.ts readV1Plugin). Real auth +
// provider seeding hooks land in task 07. This module must NEVER export a
// `tui` key — the loader rejects modules exporting both kinds.
const server = async (_input: PluginInput): Promise<Hooks> => ({})

export default { id: "kiro", server }
