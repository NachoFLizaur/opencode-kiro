import type { Config } from "@opencode-ai/plugin"
import { buildKiroModels } from "./models"

/**
 * Seed `cfg.provider.kiro` with the static 12-model Kiro provider entry.
 *
 * Called from the plugin `config` hook, which receives opencode's SHARED
 * cached config object — mutations here are visible to provider init, which
 * reads `cfg.provider` only after all plugin config hooks ran (ordering
 * codified upstream: provider.ts "load plugins first so config() hook runs
 * before reading cfg.provider").
 *
 * IDEMPOTENT by skip: when `cfg.provider.kiro` already exists — user config,
 * or a future opencode where the models.dev catalog entry (sst/models.dev
 * PR #1312) surfaces as a config-level entry — the seed steps aside entirely
 * and never clobbers or merges into it.
 *
 * Pure with respect to its input (mutates and returns `cfg`, no other
 * effects) and exported for direct unit testing.
 */
export function seedProviderConfig(cfg: Config): Config {
  cfg.provider ??= {}
  if (cfg.provider["kiro"]) return cfg
  cfg.provider["kiro"] = {
    npm: "kiro-acp-ai-provider",
    name: "Kiro",
    models: buildKiroModels(),
  }
  return cfg
}
