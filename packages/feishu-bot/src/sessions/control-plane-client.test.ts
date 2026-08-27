import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSignedControlPlaneFetch } = vi.hoisted(() => ({
  mockSignedControlPlaneFetch: vi.fn(),
}));

vi.mock("../internal-auth", () => ({
  signedControlPlaneFetch: mockSignedControlPlaneFetch,
}));

import { createSession, defaultHarnessForModel } from "./control-plane-client";

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

describe("createSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards an explicitly selected repository branch", async () => {
    mockSignedControlPlaneFetch.mockResolvedValue(
      Response.json({ sessionId: "session-1", durableObjectId: "do-1" })
    );

    await createSession({
      env: { CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "test-secret" },
      target: {
        repositoryKey: "repo-1",
        fullName: "summersmile1984/background-agents",
        displayName: "background-agents",
        provider: "github",
        connectionId: "scm_github_default",
        connectionLabel: "GitHub",
        defaultBranch: "main",
      },
      branch: "codex/visual-e2e-fixture",
      model: "openai/gpt-5.6-luna",
      actorId: "feishu:tenant:user",
    });

    const request = mockSignedControlPlaneFetch.mock.calls[0]?.[1] as { body?: string };
    expect(JSON.parse(request.body ?? "{}")).toMatchObject({
      repositoryKey: "repo-1",
      branch: "codex/visual-e2e-fixture",
      runtime: { harness: "codex", model: "openai/gpt-5.6-luna" },
    });
  });
});
