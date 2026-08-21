import {
  MODEL_OPTIONS,
  getReasoningConfig,
  type ReasoningEffort,
  type ValidModel,
} from "@open-inspect/shared/models";
import type { AgentHarness } from "@open-inspect/shared/types/agent-harness";
import type {
  HarnessReadiness,
  HarnessReadinessCode,
} from "@open-inspect/shared/types/agent-runtime";
import type {
  RuntimeConfigurationScope,
  RuntimeEffortOption,
  RuntimeHarnessOption,
  RuntimeModelOption,
  RuntimeRouteOption,
  RuntimeSettingDefinition,
  RuntimeTransport,
} from "@open-inspect/shared/types/runtime-launch";

export const RUNTIME_CAPABILITY_CATALOG_VERSION = "2026-08-21.2";
export const RUNTIME_RESOLVER_VERSION = "1";
export const RUNTIME_SETTINGS_SCHEMA_VERSION = "1";

const CALLER_DEFAULT_SCOPES = [
  "user",
  "integration",
  "repository",
  "environment",
  "automation",
  "session",
] as const;
const OPERATOR_POLICY_SCOPE = ["installation"] as const;

const HARNESS_SETTINGS: Record<AgentHarness, RuntimeSettingDefinition[]> = {
  opencode: [
    {
      key: "sandboxMode",
      label: "Outer sandbox policy",
      description: "The harness runs inside the isolated Open-Inspect sandbox.",
      type: "enum",
      defaultValue: "isolated-sandbox",
      enumOptions: [{ value: "isolated-sandbox", label: "Isolated sandbox" }],
      allowedScopes: [...OPERATOR_POLICY_SCOPE],
      mutability: "session-start",
      visibility: "read-only",
      sensitive: false,
    },
  ],
  codex: [
    {
      key: "approvalPolicy",
      label: "Approval policy",
      description: "Background turns execute without an interactive approval prompt.",
      type: "enum",
      defaultValue: "never",
      enumOptions: [{ value: "never", label: "Never prompt" }],
      allowedScopes: [...OPERATOR_POLICY_SCOPE],
      mutability: "session-start",
      visibility: "read-only",
      sensitive: false,
    },
    {
      key: "sandboxMode",
      label: "Inner Codex sandbox",
      description: "Codex trusts the already-isolated outer sandbox workspace.",
      type: "enum",
      defaultValue: "danger-full-access",
      enumOptions: [{ value: "danger-full-access", label: "Full sandbox workspace access" }],
      allowedScopes: [...OPERATOR_POLICY_SCOPE],
      mutability: "session-start",
      visibility: "read-only",
      sensitive: false,
    },
  ],
  claude: [
    {
      key: "systemPromptAppend",
      label: "Additional instructions",
      description: "Append session-specific instructions to the Claude Code system preset.",
      type: "string",
      defaultValue: "",
      allowedScopes: [...CALLER_DEFAULT_SCOPES],
      mutability: "session-start",
      visibility: "user",
      sensitive: false,
      constraints: { maxLength: 8000, multiline: true },
    },
    {
      key: "permissionMode",
      label: "Permission mode",
      description: "Platform ceiling for autonomous background edits.",
      type: "enum",
      defaultValue: "acceptEdits",
      enumOptions: [{ value: "acceptEdits", label: "Accept edits" }],
      allowedScopes: [...OPERATOR_POLICY_SCOPE],
      mutability: "session-start",
      visibility: "read-only",
      sensitive: false,
    },
  ],
  deepseek: [
    {
      key: "approvalPolicy",
      label: "Approval policy",
      description: "Background turns execute without an interactive approval prompt.",
      type: "enum",
      defaultValue: "never",
      enumOptions: [{ value: "never", label: "Never prompt" }],
      allowedScopes: [...OPERATOR_POLICY_SCOPE],
      mutability: "session-start",
      visibility: "read-only",
      sensitive: false,
    },
    {
      key: "shellAccess",
      label: "Shell access",
      description: "CodeWhale may use the shell inside the isolated sandbox.",
      type: "boolean",
      defaultValue: true,
      allowedScopes: [...OPERATOR_POLICY_SCOPE],
      mutability: "session-start",
      visibility: "read-only",
      sensitive: false,
    },
    {
      key: "telemetry",
      label: "Telemetry",
      description: "Harness telemetry is disabled in the sandbox image.",
      type: "boolean",
      defaultValue: false,
      allowedScopes: [...OPERATOR_POLICY_SCOPE],
      mutability: "session-start",
      visibility: "read-only",
      sensitive: false,
    },
  ],
};

function settingValueError(definition: RuntimeSettingDefinition, value: unknown): string | null {
  if (definition.type === "string") {
    if (typeof value !== "string") return "must be a string";
    const maxLength = definition.constraints?.maxLength;
    return typeof maxLength === "number" && value.length > maxLength
      ? `must contain at most ${maxLength} characters`
      : null;
  }
  if (definition.type === "boolean") return typeof value === "boolean" ? null : "must be boolean";
  if (definition.type === "integer") return Number.isInteger(value) ? null : "must be an integer";
  if (definition.type === "enum") {
    return typeof value === "string" &&
      definition.enumOptions?.some((option) => option.value === value)
      ? null
      : "must be one of the advertised values";
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? null
    : "must be a list of strings";
}

export function validateRuntimeConfigurationSettings(input: {
  harness: AgentHarness;
  scope: RuntimeConfigurationScope;
  settings: Record<string, unknown>;
}): string | null {
  const definitions = new Map(HARNESS_SETTINGS[input.harness].map((entry) => [entry.key, entry]));
  for (const [key, value] of Object.entries(input.settings)) {
    const definition = definitions.get(key);
    if (!definition) return `Unknown ${input.harness} setting: ${key}`;
    if (!definition.allowedScopes.includes(input.scope)) {
      return `${definition.label} cannot be configured at ${input.scope} scope`;
    }
    if (definition.visibility !== "user" && input.scope !== "installation") {
      return `${definition.label} is enforced by installation policy`;
    }
    const invalid = settingValueError(definition, value);
    if (invalid) return `${definition.label} ${invalid}`;
  }
  return null;
}

interface RouteDefinition {
  routeId: string;
  harness: AgentHarness;
  provider: "any" | "openai" | "anthropic" | "deepseek";
  transport: RuntimeTransport;
  displayName: string;
}

const HARNESS_PRESENTATION: Record<AgentHarness, { displayName: string; description: string }> = {
  opencode: {
    displayName: "OpenCode",
    description: "Upstream-compatible general provider harness",
  },
  codex: {
    displayName: "Codex",
    description: "Native Codex app-server with subscription login support",
  },
  claude: {
    displayName: "Claude Code",
    description: "Claude Agent SDK with setup-token session resume",
  },
  deepseek: {
    displayName: "DeepSeek Harness",
    description: "Native CodeWhale app-server through the Host model relay",
  },
};

export const RUNTIME_ROUTE_DEFINITIONS: readonly RouteDefinition[] = [
  {
    routeId: "opencode:any:configured-provider",
    harness: "opencode",
    provider: "any",
    transport: "opencode-provider",
    displayName: "Configured OpenCode providers",
  },
  {
    routeId: "opencode:deepseek:host-relay",
    harness: "opencode",
    provider: "deepseek",
    transport: "host-relay",
    displayName: "DeepSeek through Host relay",
  },
  {
    routeId: "codex:openai:subscription",
    harness: "codex",
    provider: "openai",
    transport: "native",
    displayName: "OpenAI subscription or API key",
  },
  {
    routeId: "codex:deepseek:host-relay",
    harness: "codex",
    provider: "deepseek",
    transport: "host-relay",
    displayName: "DeepSeek through Host relay",
  },
  {
    routeId: "claude:anthropic:setup-token",
    harness: "claude",
    provider: "anthropic",
    transport: "native",
    displayName: "Anthropic setup-token or API key",
  },
  {
    routeId: "claude:deepseek:host-relay",
    harness: "claude",
    provider: "deepseek",
    transport: "host-relay",
    displayName: "DeepSeek through Host relay",
  },
  {
    routeId: "deepseek:deepseek:host-relay",
    harness: "deepseek",
    provider: "deepseek",
    transport: "host-relay",
    displayName: "DeepSeek through Host relay",
  },
] as const;

const CODEX_EFFORTS = new Set<ReasoningEffort>(["none", "low", "medium", "high", "xhigh"]);
const CLAUDE_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh", "max"]);

function providerForModel(model: string): string {
  return model.split("/", 1)[0] ?? "";
}

function routeOwnsModel(route: RouteDefinition, model: string): boolean {
  const provider = providerForModel(model);
  if (route.provider === "any") return provider !== "deepseek";
  return provider === route.provider;
}

function effortOptions(harness: AgentHarness, model: string): RuntimeEffortOption[] {
  const config = getReasoningConfig(model);
  if (!config || harness === "deepseek") return [];
  const supported =
    harness === "codex"
      ? CODEX_EFFORTS
      : harness === "claude"
        ? CLAUDE_EFFORTS
        : new Set(config.efforts);
  return config.efforts
    .filter((effort) => supported.has(effort))
    .map((effort) => ({
      value: effort,
      label: effort,
      nativeValue: effort,
      isDefault: config.default === effort,
    }));
}

function routeReadiness(
  route: RouteDefinition,
  readiness: HarnessReadiness
): { ready: boolean; code: HarnessReadinessCode | "READY"; message?: string } {
  const dynamic = readiness.routes.find((candidate) => candidate.provider === route.provider);
  if (!dynamic) {
    return {
      ready: false,
      code: "PROVIDER_UNAVAILABLE",
      message: "The runtime route is not advertised by this deployment",
    };
  }
  return { ready: dynamic.ready, code: dynamic.code, message: dynamic.message };
}

function buildModelOptions(input: {
  route: RouteDefinition;
  routeReady: boolean;
  routeMessage?: string;
  enabledModels: ReadonlySet<string>;
}): RuntimeModelOption[] {
  return MODEL_OPTIONS.flatMap((group) =>
    group.models
      .filter((model) => routeOwnsModel(input.route, model.id))
      .map((model): RuntimeModelOption => {
        const enabled = input.enabledModels.has(model.id);
        return {
          model: model.id,
          displayName: model.name,
          description: model.description,
          category: group.category,
          routeId: input.route.routeId,
          provider: providerForModel(model.id),
          enabled,
          ready: input.routeReady && enabled,
          ...(!input.routeReady
            ? { disabledReason: input.routeMessage ?? "Runtime route is not ready" }
            : !enabled
              ? { disabledReason: "Model is disabled in Settings → Models" }
              : {}),
          efforts: effortOptions(input.route.harness, model.id),
          supportsAttachments: true,
          supportsToolEvents: true,
          supportsLiveModelSwitch: input.route.harness === "opencode",
        };
      })
  );
}

export function buildRuntimeHarnessOptions(input: {
  readiness: HarnessReadiness[];
  enabledModels: readonly ValidModel[];
}): RuntimeHarnessOption[] {
  const readinessByHarness = new Map(input.readiness.map((entry) => [entry.harness, entry]));
  const enabledModels = new Set<string>(input.enabledModels);
  return (["opencode", "codex", "claude", "deepseek"] as const).map((harness) => {
    const dynamic = readinessByHarness.get(harness) ?? {
      harness,
      enabled: false,
      runtimeAvailable: false,
      routes: [],
    };
    const routes: RuntimeRouteOption[] = RUNTIME_ROUTE_DEFINITIONS.filter(
      (route) => route.harness === harness
    ).map((route) => {
      const routeState = routeReadiness(route, dynamic);
      const models = buildModelOptions({
        route,
        routeReady: routeState.ready,
        routeMessage: routeState.message,
        enabledModels,
      });
      return {
        routeId: route.routeId,
        harness,
        provider: route.provider,
        transport: route.transport,
        displayName: route.displayName,
        ready: routeState.ready && models.some((model) => model.ready),
        code: routeState.code,
        ...(routeState.message ? { message: routeState.message } : {}),
        models,
      };
    });
    const presentation = HARNESS_PRESENTATION[harness];
    const ready =
      dynamic.enabled && dynamic.runtimeAvailable && routes.some((route) => route.ready);
    return {
      harness,
      ...presentation,
      enabled: dynamic.enabled,
      runtimeAvailable: dynamic.runtimeAvailable,
      ready,
      settingsSchemaVersion: RUNTIME_SETTINGS_SCHEMA_VERSION,
      settings: HARNESS_SETTINGS[harness],
      liveMutation: {
        model: harness === "opencode",
        effort: harness === "opencode",
        settings: [],
      },
      ...(!ready
        ? {
            disabledReason: !dynamic.enabled
              ? "Harness is disabled by the deployment administrator"
              : !dynamic.runtimeAvailable
                ? "Harness runtime is not available in the sandbox image"
                : "No enabled model route is ready",
          }
        : {}),
      routes,
    };
  });
}
