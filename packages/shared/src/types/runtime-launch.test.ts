import { describe, expect, it } from "vitest";
import {
  resolveRuntimeLaunchDraftRequestSchema,
  runtimeConfigFragmentSchema,
  runtimeLaunchCallerChannelSchema,
  runtimeLaunchTargetSchema,
} from "./runtime-launch";

describe("runtime launch contracts", () => {
  it("accepts stable repository targets and explicit runtime choices", () => {
    expect(
      resolveRuntimeLaunchDraftRequestSchema.parse({
        target: { kind: "repository", repositoryKey: "repo-1", branch: "main" },
        runtime: {
          harness: "codex",
          routeId: "codex:openai:subscription",
          model: "openai/gpt-5.6-luna",
          effort: "high",
          settings: { systemInstructions: "Be concise" },
        },
      })
    ).toMatchObject({ target: { repositoryKey: "repo-1" }, runtime: { harness: "codex" } });
  });

  it("rejects duplicate multi-repository targets", () => {
    expect(
      runtimeLaunchTargetSchema.safeParse({
        kind: "repository-set",
        repositoryKeys: ["repo-1", "repo-1"],
      }).success
    ).toBe(false);
  });

  it("allows explicit inheritance without treating it as a harness", () => {
    expect(
      runtimeConfigFragmentSchema.parse({
        harness: "inherit",
        routeId: "auto",
        model: "inherit",
        effort: "inherit",
      })
    ).toEqual({ harness: "inherit", routeId: "auto", model: "inherit", effort: "inherit" });
  });

  it("accepts Feishu as an immutable launch caller channel", () => {
    expect(runtimeLaunchCallerChannelSchema.parse("feishu")).toBe("feishu");
  });
});
