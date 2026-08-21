import { describe, expect, it } from "vitest";
import { inferSlackAgentHarness } from "./agent-harness";

describe("inferSlackAgentHarness", () => {
  it.each([
    ["openai/gpt-5.6-luna", "codex"],
    ["gpt-5.6-luna", "codex"],
    ["anthropic/claude-sonnet-4-6", "claude"],
    ["claude-sonnet-4-6", "claude"],
    ["deepseek/deepseek-v4-flash", "deepseek"],
  ] as const)("maps %s to %s", (model, expected) => {
    expect(inferSlackAgentHarness(model)).toBe(expected);
  });

  it("inherits the workspace harness for providers without a native runtime", () => {
    expect(inferSlackAgentHarness("xai/grok-4.6")).toBeUndefined();
  });
});
