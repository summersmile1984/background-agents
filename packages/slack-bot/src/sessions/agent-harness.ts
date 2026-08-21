import { extractProviderAndModel } from "@open-inspect/shared/models";
import type { AgentHarness } from "@open-inspect/shared/types/agent-harness";

/**
 * Prefer a provider-native harness for Slack-launched sessions. Slack currently
 * exposes a model preference but no separate harness picker, so leaving the
 * harness unset can pair an OpenAI subscription model with the deployment's
 * OpenCode default even when the native Codex runtime is configured.
 *
 * Providers without a native Open-Inspect harness stay unset and inherit the
 * workspace default (normally OpenCode).
 */
export function inferSlackAgentHarness(model: string): AgentHarness | undefined {
  switch (extractProviderAndModel(model).provider) {
    case "openai":
      return "codex";
    case "anthropic":
      return "claude";
    case "deepseek":
      return "deepseek";
    default:
      return undefined;
  }
}
