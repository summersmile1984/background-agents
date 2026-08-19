import {
  extractProviderAndModel,
  MODEL_OPTIONS,
  normalizeModelId,
  type ModelCategory,
} from "@open-inspect/shared/models";
import type { AgentHarness } from "@open-inspect/shared/types/agent-harness";

const MODEL_PROVIDERS_BY_HARNESS: Partial<Record<AgentHarness, readonly string[]>> = {
  codex: ["openai", "deepseek"],
  claude: ["anthropic", "deepseek"],
  deepseek: ["deepseek"],
};

export function isModelCompatibleWithHarness(model: string, harness: AgentHarness): boolean {
  if (harness === "opencode") return true;
  const providers = MODEL_PROVIDERS_BY_HARNESS[harness];
  return providers
    ? providers.some((provider) => normalizeModelId(model).startsWith(`${provider}/`))
    : false;
}

function filterOptions(options: ModelCategory[], harness: AgentHarness): ModelCategory[] {
  return options
    .map((category) => ({
      ...category,
      models: category.models.filter((model) => isModelCompatibleWithHarness(model.id, harness)),
    }))
    .filter((category) => category.models.length > 0);
}

/**
 * Native harnesses can only consume their own provider's model identifiers.
 * If model preferences hide every compatible entry, fall back to that
 * provider's catalog so selecting the harness never displays an unrelated model.
 */
export function getAgentHarnessModelOptions(
  enabledOptions: ModelCategory[],
  harness: AgentHarness | null | undefined
): ModelCategory[] {
  if (!harness || harness === "opencode") return enabledOptions;
  const enabledCompatible = filterOptions(enabledOptions, harness);
  return enabledCompatible.length > 0 ? enabledCompatible : filterOptions(MODEL_OPTIONS, harness);
}

/**
 * Native harnesses choose their provider when the sandbox process starts.
 * Follow-up prompts may change models within that provider, but crossing to a
 * different provider requires a new session so the harness can be restarted
 * with the matching transport and credentials.
 */
export function getSessionAgentHarnessModelOptions(
  enabledOptions: ModelCategory[],
  harness: AgentHarness | null | undefined,
  sessionModel: string | null | undefined
): ModelCategory[] {
  const harnessOptions = getAgentHarnessModelOptions(enabledOptions, harness);
  if (!harness || harness === "opencode" || !sessionModel) return harnessOptions;

  const provider = extractProviderAndModel(sessionModel).provider;
  const providerOptions = harnessOptions
    .map((category) => ({
      ...category,
      models: category.models.filter(
        (model) => extractProviderAndModel(model.id).provider === provider
      ),
    }))
    .filter((category) => category.models.length > 0);
  return providerOptions.length > 0 ? providerOptions : harnessOptions;
}

export function getModelIds(options: ModelCategory[]): string[] {
  return options.flatMap((category) => category.models.map((model) => model.id));
}
