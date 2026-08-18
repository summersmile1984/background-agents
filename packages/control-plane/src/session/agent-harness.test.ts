import { describe, expect, it, vi } from "vitest";
import { resolveAgentHarness } from "./agent-harness";

function store(defaultAgentHarness: "opencode" | "codex" | "claude" | "deepseek" | null) {
  return {
    getById: vi.fn(async () =>
      defaultAgentHarness ? { default_agent_harness: defaultAgentHarness } : null
    ),
  };
}

describe("resolveAgentHarness", () => {
  it("uses request, environment, deployment, then compatibility default", async () => {
    expect(
      await resolveAgentHarness({
        requested: "codex",
        environmentId: "env_1",
        environmentStore: store("claude") as never,
        deploymentDefault: "deepseek",
      })
    ).toBe("codex");
    expect(
      await resolveAgentHarness({
        environmentId: "env_1",
        environmentStore: store("claude") as never,
        deploymentDefault: "deepseek",
      })
    ).toBe("claude");
    expect(
      await resolveAgentHarness({
        environmentStore: store(null) as never,
        deploymentDefault: "deepseek",
      })
    ).toBe("deepseek");
    expect(
      await resolveAgentHarness({
        environmentStore: store(null) as never,
        deploymentDefault: "invalid",
      })
    ).toBe("opencode");
  });
});
