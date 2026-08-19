import type { AgentHarness } from "@open-inspect/shared/types/agent-harness";
import type {
  AgentRuntimePreferences,
  AgentRuntimeReadinessResponse,
  HarnessCredentialMetadata,
  HarnessProviderReadiness,
  HarnessReadinessCode,
} from "@open-inspect/shared/types/agent-runtime";

function isExpired(credential: HarnessCredentialMetadata | undefined): boolean {
  return Boolean(credential?.expiresAt && new Date(credential.expiresAt).getTime() <= Date.now());
}

function credentialRoute(
  provider: "openai" | "anthropic",
  credential: HarnessCredentialMetadata | undefined,
  apiKeyConfigured: boolean
): HarnessProviderReadiness {
  if (apiKeyConfigured) return { provider, ready: true, code: "READY" };
  if (!credential?.configured) {
    return {
      provider,
      ready: false,
      code: "CREDENTIAL_MISSING",
      message: `${provider === "openai" ? "Codex" : "Claude"} credential is not configured`,
    };
  }
  if (isExpired(credential)) {
    return {
      provider,
      ready: false,
      code: "CREDENTIAL_EXPIRED",
      message: "Credential expiry metadata indicates that it has expired",
    };
  }
  return { provider, ready: true, code: "READY" };
}

function relayRoute(relayReady: boolean): HarnessProviderReadiness {
  return relayReady
    ? { provider: "deepseek", ready: true, code: "READY" }
    : {
        provider: "deepseek",
        ready: false,
        code: "RELAY_UNAVAILABLE",
        message: "The Host model relay is not configured or unavailable",
      };
}

function disabledRoutes(routes: HarnessProviderReadiness[]): HarnessProviderReadiness[] {
  return routes.map((route) => ({
    ...route,
    ready: false,
    code: "HARNESS_DISABLED" as HarnessReadinessCode,
    message: "Harness is disabled by the deployment administrator",
  }));
}

export function buildAgentRuntimeReadiness(input: {
  preferences: AgentRuntimePreferences;
  credentials: HarnessCredentialMetadata[];
  relayReady: boolean;
  openAiApiKeyConfigured: boolean;
  anthropicApiKeyConfigured: boolean;
  runtimeHarnesses?: readonly AgentHarness[];
}): AgentRuntimeReadinessResponse {
  const byKind = new Map(input.credentials.map((credential) => [credential.kind, credential]));
  const runtimeHarnesses = new Set(
    input.runtimeHarnesses ?? (["opencode", "codex", "claude", "deepseek"] as const)
  );

  const routesByHarness: Record<AgentHarness, HarnessProviderReadiness[]> = {
    opencode: [{ provider: "any", ready: true, code: "READY" }, relayRoute(input.relayReady)],
    codex: [
      credentialRoute(
        "openai",
        byKind.get("codex-auth-json")?.configured
          ? byKind.get("codex-auth-json")
          : byKind.get("codex-access-token"),
        input.openAiApiKeyConfigured
      ),
      relayRoute(input.relayReady),
    ],
    claude: [
      credentialRoute(
        "anthropic",
        byKind.get("claude-setup-token"),
        input.anthropicApiKeyConfigured
      ),
      relayRoute(input.relayReady),
    ],
    deepseek: [relayRoute(input.relayReady)],
  };

  return {
    checkedAt: Date.now(),
    preferences: input.preferences,
    credentials: input.credentials,
    harnesses: (["opencode", "codex", "claude", "deepseek"] as const).map((harness) => {
      const enabled = input.preferences.enabledHarnesses.includes(harness);
      const runtimeAvailable = runtimeHarnesses.has(harness);
      let routes = routesByHarness[harness];
      if (!enabled) routes = disabledRoutes(routes);
      else if (!runtimeAvailable) {
        routes = routes.map((route) => ({
          ...route,
          ready: false,
          code: "RUNTIME_UNAVAILABLE" as const,
          message: "Harness runtime is not available in the configured sandbox image",
        }));
      }
      return { harness, enabled, runtimeAvailable, routes };
    }),
  };
}
