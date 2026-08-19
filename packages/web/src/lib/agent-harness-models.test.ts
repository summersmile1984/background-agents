import { describe, expect, it } from "vitest";
import type { ModelCategory } from "@open-inspect/shared/models";
import {
  getAgentHarnessModelOptions,
  getModelIds,
  getSessionAgentHarnessModelOptions,
  isModelCompatibleWithHarness,
} from "./agent-harness-models";

const enabledOptions: ModelCategory[] = [
  {
    category: "Mixed",
    models: [
      { id: "openai/gpt-5.4", name: "GPT", description: "" },
      { id: "anthropic/claude-sonnet-4-6", name: "Claude", description: "" },
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek", description: "" },
      { id: "xiaomi/mimo-v2.5", name: "MiMo", description: "" },
    ],
  },
];

describe("agent harness model compatibility", () => {
  it("matches native harnesses to their provider and leaves OpenCode unrestricted", () => {
    expect(isModelCompatibleWithHarness("openai/gpt-5.4", "codex")).toBe(true);
    expect(isModelCompatibleWithHarness("anthropic/claude-sonnet-4-6", "codex")).toBe(false);
    expect(isModelCompatibleWithHarness("anthropic/claude-sonnet-4-6", "claude")).toBe(true);
    expect(isModelCompatibleWithHarness("deepseek/deepseek-v4-flash", "codex")).toBe(true);
    expect(isModelCompatibleWithHarness("deepseek/deepseek-v4-flash", "claude")).toBe(true);
    expect(isModelCompatibleWithHarness("deepseek/deepseek-v4-pro", "deepseek")).toBe(true);
    expect(isModelCompatibleWithHarness("xiaomi/mimo-v2.5", "opencode")).toBe(true);
  });

  it("filters enabled options for a native harness", () => {
    expect(getModelIds(getAgentHarnessModelOptions(enabledOptions, "codex"))).toEqual([
      "openai/gpt-5.4",
      "deepseek/deepseek-v4-flash",
    ]);
    expect(getModelIds(getAgentHarnessModelOptions(enabledOptions, "claude"))).toEqual([
      "anthropic/claude-sonnet-4-6",
      "deepseek/deepseek-v4-flash",
    ]);
  });

  it("falls back to the native provider catalog when preferences hide it", () => {
    const deepseekModels = getModelIds(getAgentHarnessModelOptions(enabledOptions, "deepseek"));
    expect(deepseekModels.length).toBeGreaterThan(0);
    expect(deepseekModels.every((model) => model.startsWith("deepseek/"))).toBe(true);
  });

  it("locks native follow-up models to the provider selected at session creation", () => {
    expect(
      getModelIds(
        getSessionAgentHarnessModelOptions(enabledOptions, "codex", "deepseek/deepseek-v4-flash")
      )
    ).toEqual(["deepseek/deepseek-v4-flash"]);
    expect(
      getModelIds(getSessionAgentHarnessModelOptions(enabledOptions, "codex", "openai/gpt-5.4"))
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      getModelIds(getSessionAgentHarnessModelOptions(enabledOptions, "opencode", "openai/gpt-5.4"))
    ).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
      "deepseek/deepseek-v4-flash",
      "xiaomi/mimo-v2.5",
    ]);
  });
});
