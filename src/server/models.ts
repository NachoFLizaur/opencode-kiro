import type { Config } from "@opencode-ai/plugin"
import { KIRO_MODEL_DEFAULTS } from "kiro-acp-ai-provider"

/**
 * Per-model map in opencode's config schema (`cfg.provider.<id>.models`),
 * derived from the live plugin Config type so the seed always matches the
 * host schema (ProviderConfig.models in @opencode-ai/sdk types).
 */
export type KiroModelConfigMap = NonNullable<NonNullable<Config["provider"]>[string]["models"]>

/**
 * Map the SDK's static catalog (`KIRO_MODEL_DEFAULTS`, 12 models — the single
 * source of truth, no duplicated model literals here) into opencode's config
 * model shape.
 *
 * Field mapping (config field ← SDK field):
 * - `name`           ← `name`
 * - `limit.context`  ← `contextWindow`
 * - `limit.output`   ← `outputLimit`
 * - `modalities`     ← derived from `imageInput`: input `["text","image"]`
 *                      when true, `["text"]` when false; output always
 *                      `["text"]` (image input is capability-driven via
 *                      modalities — no core support needed)
 * - `tool_call`      ← `toolCall`
 * - `reasoning`      ← `reasoning`
 * - `temperature`    ← `temperature` (must be explicit: opencode defaults a
 *                      config model's temperature capability to FALSE when
 *                      absent — provider.ts capabilities merge)
 */
export function buildKiroModels(): KiroModelConfigMap {
  const models: KiroModelConfigMap = {}
  for (const defaults of Object.values(KIRO_MODEL_DEFAULTS)) {
    models[defaults.id] = {
      name: defaults.name,
      limit: { context: defaults.contextWindow, output: defaults.outputLimit },
      modalities: {
        input: defaults.imageInput ? ["text", "image"] : ["text"],
        output: ["text"],
      },
      tool_call: defaults.toolCall,
      reasoning: defaults.reasoning,
      temperature: defaults.temperature,
    }
  }
  return models
}
