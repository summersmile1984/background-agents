import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_RUNTIME_PREFERENCES,
  agentRuntimePreferencesSchema,
  harnessCredentialKindSchema,
} from "./agent-runtime";

describe("agent runtime contracts", () => {
  it("keeps every Harness enabled with OpenCode as the compatibility default", () => {
    expect(DEFAULT_AGENT_RUNTIME_PREFERENCES).toEqual({
      defaultAgentHarness: "opencode",
      enabledHarnesses: ["opencode", "codex", "claude", "deepseek"],
    });
  });

  it("requires the default Harness to remain enabled", () => {
    expect(
      agentRuntimePreferencesSchema.safeParse({
        defaultAgentHarness: "codex",
        enabledHarnesses: ["opencode"],
      }).success
    ).toBe(false);
  });

  it("owns the native credential kind allowlist", () => {
    expect(harnessCredentialKindSchema.options).toEqual([
      "codex-auth-json",
      "codex-access-token",
      "claude-setup-token",
    ]);
  });
});
