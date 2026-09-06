import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSignedControlPlaneFetch } = vi.hoisted(() => ({
  mockSignedControlPlaneFetch: vi.fn(),
}));

vi.mock("../internal-auth", () => ({
  signedControlPlaneFetch: mockSignedControlPlaneFetch,
}));

import {
  createResolvedSession,
  createSession,
  defaultHarnessForModel,
  sendPrompt,
} from "./control-plane-client";

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

  it("forwards an explicit harness route and effort for staged launches", async () => {
    mockSignedControlPlaneFetch.mockResolvedValue(
      Response.json({ sessionId: "session-runtime", durableObjectId: "do-runtime" })
    );

    await createSession({
      env: { CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "test-secret" },
      target: {
        repositoryKey: "repo-1",
        fullName: "huangdong/chatbi",
        displayName: "chatbi",
        provider: "gitea",
        connectionId: "gitea-primary",
        connectionLabel: "Gitea",
        defaultBranch: "main",
      },
      model: "openai/gpt-5.6-luna",
      runtime: {
        harness: "codex",
        routeId: "codex:openai:subscription",
        model: "openai/gpt-5.6-luna",
        effort: "high",
      },
      actorId: "feishu:tenant:user",
    });

    const request = mockSignedControlPlaneFetch.mock.calls[0]?.[1] as { body?: string };
    expect(JSON.parse(request.body ?? "{}")).toMatchObject({
      runtime: {
        harness: "codex",
        routeId: "codex:openai:subscription",
        model: "openai/gpt-5.6-luna",
        effort: "high",
      },
    });
  });
});

describe("resolved session and prompt calls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [{ kind: "none" as const }, {}],
    [
      { kind: "repository" as const, repositoryKey: "repo-1", branch: "feature" },
      { repositoryKey: "repo-1", branch: "feature" },
    ],
    [
      { kind: "repository-set" as const, repositoryKeys: ["repo-1", "repo-2"] },
      { repositoryKeys: ["repo-1", "repo-2"] },
    ],
    [{ kind: "environment" as const, environmentId: "env-1" }, { environmentId: "env-1" }],
  ])("maps target %o to the public create-session contract", async (target, expected) => {
    mockSignedControlPlaneFetch.mockResolvedValue(
      Response.json({ sessionId: "session-1", status: "created" })
    );

    await expect(
      createResolvedSession({
        env: { CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "test-secret" },
        target,
        runtime: { harness: "codex", model: "openai/gpt-5.6-luna" },
        runtimeDraftDigest: "a".repeat(64),
        clientRequestId: "feishu-session:pending-1",
        actorId: "feishu:tenant:user",
      })
    ).resolves.toMatchObject({ ok: true, data: { sessionId: "session-1" } });

    const request = mockSignedControlPlaneFetch.mock.calls[0]?.[1] as { body?: string };
    expect(JSON.parse(request.body ?? "{}")).toEqual({
      ...expected,
      runtime: { harness: "codex", model: "openai/gpt-5.6-luna" },
      runtimeDraftDigest: "a".repeat(64),
      clientRequestId: "feishu-session:pending-1",
    });
  });

  it("surfaces an idempotency conflict with the existing session id", async () => {
    mockSignedControlPlaneFetch.mockResolvedValue(
      Response.json(
        {
          error: "request key already has a different body",
          code: "SESSION_CREATE_REQUEST_CONFLICT",
          sessionId: "session-existing",
        },
        { status: 409 }
      )
    );

    await expect(
      createResolvedSession({
        env: { CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "test-secret" },
        target: { kind: "none" },
        runtimeDraftDigest: "a".repeat(64),
        clientRequestId: "feishu-session:pending-1",
        actorId: "feishu:tenant:user",
      })
    ).resolves.toEqual({
      ok: false,
      reason: "conflict",
      status: 409,
      error: "request key already has a different body",
      sessionId: "session-existing",
    });
  });

  it("retries an ambiguous create once with the identical idempotency key", async () => {
    mockSignedControlPlaneFetch
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(Response.json({ sessionId: "session-recovered", status: "created" }));

    await expect(
      createResolvedSession({
        env: { CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "test-secret" },
        target: { kind: "none" },
        runtimeDraftDigest: "a".repeat(64),
        clientRequestId: "feishu-session:pending-retry",
        actorId: "feishu:tenant:user",
      })
    ).resolves.toMatchObject({ ok: true, data: { sessionId: "session-recovered" } });

    expect(mockSignedControlPlaneFetch).toHaveBeenCalledTimes(2);
    expect(mockSignedControlPlaneFetch.mock.calls[0]?.[1]).toMatchObject({
      body: expect.stringContaining('"clientRequestId":"feishu-session:pending-retry"'),
    });
    expect(mockSignedControlPlaneFetch.mock.calls[1]?.[1]).toMatchObject({
      body: expect.stringContaining('"clientRequestId":"feishu-session:pending-retry"'),
    });
  });

  it("forwards the turn idempotency key and working-card callback coordinate", async () => {
    mockSignedControlPlaneFetch.mockResolvedValue(
      Response.json({ messageId: "message-1", status: "queued" })
    );

    await expect(
      sendPrompt({
        env: { CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "test-secret" },
        sessionId: "session-1",
        content: "继续修复",
        actorId: "feishu:tenant:user",
        clientRequestId: "feishu-followup:message-1",
        callbackContext: {
          source: "feishu",
          tenantKey: "tenant",
          chatId: "chat",
          rootMessageId: "root",
          workingMessageId: "working-card-1",
          targetLabel: "owner/repo",
          routeId: "codex:openai:subscription",
          model: "openai/gpt-5.6-luna",
        },
      })
    ).resolves.toMatchObject({ ok: true, data: { messageId: "message-1" } });

    const request = mockSignedControlPlaneFetch.mock.calls[0]?.[1] as { body?: string };
    expect(JSON.parse(request.body ?? "{}")).toMatchObject({
      clientRequestId: "feishu-followup:message-1",
      callbackContext: {
        workingMessageId: "working-card-1",
        routeId: "codex:openai:subscription",
      },
    });
  });

  it("retries an ambiguous prompt once with the identical turn key", async () => {
    mockSignedControlPlaneFetch
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(Response.json({ messageId: "message-existing", status: "queued" }));
    const input = {
      env: { CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "test-secret" },
      sessionId: "session-1",
      content: "继续修复",
      actorId: "feishu:tenant:user",
      clientRequestId: "feishu-followup:message-retry",
      callbackContext: {
        source: "feishu" as const,
        tenantKey: "tenant",
        chatId: "chat",
        rootMessageId: "root",
        targetLabel: "owner/repo",
        model: "openai/gpt-5.6-luna",
      },
    };

    await expect(sendPrompt(input)).resolves.toMatchObject({
      ok: true,
      data: { messageId: "message-existing" },
    });
    expect(mockSignedControlPlaneFetch).toHaveBeenCalledTimes(2);
    for (const call of mockSignedControlPlaneFetch.mock.calls) {
      expect(call[1]).toMatchObject({
        body: expect.stringContaining('"clientRequestId":"feishu-followup:message-retry"'),
      });
    }
  });
});
