import { describe, expect, it } from "vitest";
import { buildAgentRuntimeReadiness } from "./readiness";

const credentials = [
  {
    kind: "codex-auth-json" as const,
    configured: true,
    updatedAt: 1,
    expiresAt: null,
    fingerprint: "sha256:codex",
  },
  {
    kind: "codex-access-token" as const,
    configured: false,
    updatedAt: null,
    expiresAt: null,
    fingerprint: null,
  },
  {
    kind: "claude-setup-token" as const,
    configured: false,
    updatedAt: null,
    expiresAt: null,
    fingerprint: null,
  },
];

describe("buildAgentRuntimeReadiness", () => {
  it("reports provider paths independently", () => {
    const result = buildAgentRuntimeReadiness({
      preferences: {
        defaultAgentHarness: "codex",
        enabledHarnesses: ["opencode", "codex", "claude", "deepseek"],
      },
      credentials,
      relayReady: true,
      openAiApiKeyConfigured: false,
      anthropicApiKeyConfigured: false,
    });
    expect(result.harnesses.find((item) => item.harness === "codex")?.routes).toEqual([
      { provider: "openai", ready: true, code: "READY" },
      { provider: "deepseek", ready: true, code: "READY" },
    ]);
    expect(result.harnesses.find((item) => item.harness === "claude")?.routes[0]).toMatchObject({
      provider: "anthropic",
      ready: false,
      code: "CREDENTIAL_MISSING",
    });
  });

  it("overrides every route when a Harness is disabled or missing from the image", () => {
    const result = buildAgentRuntimeReadiness({
      preferences: { defaultAgentHarness: "opencode", enabledHarnesses: ["opencode", "codex"] },
      credentials,
      relayReady: true,
      openAiApiKeyConfigured: false,
      anthropicApiKeyConfigured: false,
      runtimeHarnesses: ["opencode"],
    });
    expect(result.harnesses.find((item) => item.harness === "codex")?.routes[0].code).toBe(
      "RUNTIME_UNAVAILABLE"
    );
    expect(result.harnesses.find((item) => item.harness === "claude")?.routes[0].code).toBe(
      "HARNESS_DISABLED"
    );
  });
});
