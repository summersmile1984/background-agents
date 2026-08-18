import { describe, expect, it } from "vitest";
import {
  AGENT_HARNESSES,
  DEFAULT_AGENT_HARNESS,
  agentHarnessSchema,
  getAgentHarnessOrDefault,
} from "./agent-harness";

describe("agentHarnessSchema", () => {
  it("accepts every supported harness", () => {
    for (const harness of AGENT_HARNESSES) {
      expect(agentHarnessSchema.parse(harness)).toBe(harness);
    }
  });

  it("keeps OpenCode as the compatibility default", () => {
    expect(DEFAULT_AGENT_HARNESS).toBe("opencode");
    expect(getAgentHarnessOrDefault(undefined)).toBe("opencode");
    expect(getAgentHarnessOrDefault("unknown")).toBe("opencode");
  });
});
