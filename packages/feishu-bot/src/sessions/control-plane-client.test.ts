import { describe, expect, it } from "vitest";
import { defaultHarnessForModel } from "./control-plane-client";

describe("defaultHarnessForModel", () => {
  it.each([
    ["openai/gpt-5.6-luna", "codex"],
    ["anthropic/claude-sonnet-4-6", "claude"],
    ["deepseek/deepseek-v4-flash", "deepseek"],
    ["mimo-v2.5", "inherit"],
  ] as const)("selects %s as %s", (model, expectedHarness) => {
    expect(defaultHarnessForModel(model)).toBe(expectedHarness);
  });
});
