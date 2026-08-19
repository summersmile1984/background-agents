import { z } from "zod";
import { AGENT_HARNESSES, DEFAULT_AGENT_HARNESS, agentHarnessSchema } from "./agent-harness";

export const harnessCredentialKindSchema = z.enum([
  "codex-auth-json",
  "codex-access-token",
  "claude-setup-token",
]);

export type HarnessCredentialKind = z.infer<typeof harnessCredentialKindSchema>;

export const agentRuntimePreferencesSchema = z
  .object({
    defaultAgentHarness: agentHarnessSchema.default(DEFAULT_AGENT_HARNESS),
    enabledHarnesses: z
      .array(agentHarnessSchema)
      .min(1)
      .default([...AGENT_HARNESSES]),
  })
  .superRefine((value, ctx) => {
    if (!value.enabledHarnesses.includes(value.defaultAgentHarness)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultAgentHarness"],
        message: "The default harness must be enabled",
      });
    }
  });

export type AgentRuntimePreferences = z.infer<typeof agentRuntimePreferencesSchema>;

export const DEFAULT_AGENT_RUNTIME_PREFERENCES: AgentRuntimePreferences = {
  defaultAgentHarness: DEFAULT_AGENT_HARNESS,
  enabledHarnesses: [...AGENT_HARNESSES],
};

export interface HarnessCredentialMetadata {
  kind: HarnessCredentialKind;
  configured: boolean;
  updatedAt: number | null;
  expiresAt: string | null;
  fingerprint: string | null;
}

export type HarnessReadinessCode =
  | "READY"
  | "HARNESS_DISABLED"
  | "RUNTIME_UNAVAILABLE"
  | "MODEL_INCOMPATIBLE"
  | "CREDENTIAL_MISSING"
  | "CREDENTIAL_EXPIRED"
  | "RELAY_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE";

export interface HarnessProviderReadiness {
  provider: "any" | "openai" | "anthropic" | "deepseek";
  ready: boolean;
  code: HarnessReadinessCode;
  message?: string;
}

export interface HarnessReadiness {
  harness: (typeof AGENT_HARNESSES)[number];
  enabled: boolean;
  runtimeAvailable: boolean;
  routes: HarnessProviderReadiness[];
}

export interface AgentRuntimeReadinessResponse {
  checkedAt: number;
  preferences: AgentRuntimePreferences;
  credentials: HarnessCredentialMetadata[];
  harnesses: HarnessReadiness[];
  hostRelay?: HostModelRelayStatus;
}

export interface HostModelRelayStatus {
  connected: boolean;
  checkedAt: number;
  relay: "online" | "unavailable" | "not-configured";
  deepseek: {
    configured: boolean;
    fingerprint: string | null;
  };
  errorCode?: "NOT_CONFIGURED" | "UNAUTHORIZED" | "UNAVAILABLE" | "INVALID_RESPONSE";
}
