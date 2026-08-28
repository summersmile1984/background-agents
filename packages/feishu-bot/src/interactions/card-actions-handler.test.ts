import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimCardActionOnce: vi.fn(),
  claimThreadSelection: vi.fn(),
  deletePendingRequest: vi.fn(),
  getPendingRequest: vi.fn(),
  lookupThreadSession: vi.fn(),
  releaseThreadSelection: vi.fn(),
  updatePendingRequest: vi.fn(),
  replySessionCard: vi.fn(),
  replySessionText: vi.fn(),
  startNewSession: vi.fn(),
  findRepositoryTarget: vi.fn(),
  listRepositoryCatalog: vi.fn(),
  getRuntimeCatalog: vi.fn(),
}));

vi.mock("../conversation/store", () => ({
  claimCardActionOnce: mocks.claimCardActionOnce,
  claimThreadSelection: mocks.claimThreadSelection,
  deletePendingRequest: mocks.deletePendingRequest,
  getPendingRequest: mocks.getPendingRequest,
  lookupThreadSession: mocks.lookupThreadSession,
  releaseThreadSelection: mocks.releaseThreadSelection,
  updatePendingRequest: mocks.updatePendingRequest,
}));

vi.mock("../conversation/delivery", () => ({
  replySessionCard: mocks.replySessionCard,
  replySessionText: mocks.replySessionText,
}));

vi.mock("../events/dispatcher", () => ({ startNewSession: mocks.startNewSession }));

vi.mock("../targets", () => ({
  findRepositoryTarget: mocks.findRepositoryTarget,
  listRepositoryCatalog: mocks.listRepositoryCatalog,
}));

vi.mock("../sessions/runtime-catalog", () => ({
  getRuntimeCatalog: mocks.getRuntimeCatalog,
}));

import { handleFeishuCardAction } from "./card-actions";

const pendingId = "1cd968ae-f012-4a12-898e-f320808f1af7";
const target = {
  repositoryKey: "repo-chatbi",
  fullName: "huangdong/chatbi",
  displayName: "chatbi",
  provider: "gitea",
  connectionId: "gitea-primary",
  connectionLabel: "Gitea",
  defaultBranch: "main",
};
const payload = {
  schema: "2.0",
  header: { event_id: "action-1", tenant_key: "tenant" },
  event: {
    context: { open_chat_id: "chat" },
    operator: { operator_id: { open_id: "user" } },
    action: {
      value: {
        action: "select_target",
        pendingId,
        connectionId: "gitea-primary",
        repositoryKey: "repo-chatbi",
        page: 0,
      },
    },
  },
};

function payloadWithRevision(selectionRevision: number) {
  return {
    ...payload,
    header: { event_id: `action-revision-${selectionRevision}`, tenant_key: "tenant" },
    event: {
      ...payload.event,
      action: {
        value: {
          ...payload.event.action.value,
          selectionRevision,
        },
      },
    },
  };
}

describe("handleFeishuCardAction topic binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimCardActionOnce.mockResolvedValue(true);
    mocks.claimThreadSelection.mockResolvedValue(true);
    mocks.releaseThreadSelection.mockResolvedValue(undefined);
    mocks.deletePendingRequest.mockResolvedValue(undefined);
    mocks.replySessionText.mockResolvedValue(undefined);
    mocks.getPendingRequest.mockResolvedValue({
      tenantKey: "tenant",
      chatId: "chat",
      chatType: "group",
      rootMessageId: "root",
      threadId: "thread",
      replyMode: "thread",
      actorId: "feishu:tenant:user",
      content: "检查 chatbi",
      createdAt: 1,
    });
    mocks.lookupThreadSession.mockResolvedValue(null);
    mocks.listRepositoryCatalog.mockResolvedValue({
      connections: [],
      targets: [target],
    });
    mocks.findRepositoryTarget.mockReturnValue(target);
    mocks.startNewSession.mockResolvedValue(undefined);
    mocks.getRuntimeCatalog.mockResolvedValue(null);
    mocks.updatePendingRequest.mockResolvedValue(null);
  });

  it("rejects an old repository card after the topic is already bound", async () => {
    mocks.lookupThreadSession.mockResolvedValue({
      sessionId: "session-existing",
      repositoryKey: "repo-chatbi",
      targetLabel: "huangdong/chatbi",
      rootMessageId: "root",
      threadId: "thread",
    });

    const result = await handleFeishuCardAction(payload, {} as never, "trace-existing");

    expect(result).toEqual({ ok: false, content: "本话题已绑定仓库，无需重新选择。" });
    expect(mocks.deletePendingRequest).toHaveBeenCalledWith(expect.anything(), pendingId);
    expect(mocks.startNewSession).not.toHaveBeenCalled();
    expect(mocks.replySessionText).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rootMessageId: "root", threadId: "thread" }),
      expect.stringContaining("无需重新选择仓库")
    );
  });

  it("rejects an unexpired card when another actor clicks it", async () => {
    const crossActorPayload = {
      ...payload,
      header: { event_id: "action-cross-actor", tenant_key: "tenant" },
      event: {
        ...payload.event,
        operator: { operator_id: { open_id: "other-user" } },
      },
    };

    const result = await handleFeishuCardAction(
      crossActorPayload,
      {} as never,
      "trace-cross-actor-card"
    );

    expect(result).toEqual({
      ok: false,
      content: "该选择已过期或无权操作，请重新发起请求。",
    });
    expect(mocks.getPendingRequest).toHaveBeenCalledWith(expect.anything(), pendingId);
    expect(mocks.lookupThreadSession).not.toHaveBeenCalled();
    expect(mocks.listRepositoryCatalog).not.toHaveBeenCalled();
    expect(mocks.startNewSession).not.toHaveBeenCalled();
    expect(mocks.replySessionText).not.toHaveBeenCalled();
  });

  it("blocks a second repository choice while the first session is starting", async () => {
    mocks.claimThreadSelection.mockResolvedValue(false);

    const result = await handleFeishuCardAction(payload, {} as never, "trace-race");

    expect(result).toEqual({ ok: false, content: "本话题正在创建会话。" });
    expect(mocks.startNewSession).not.toHaveBeenCalled();
  });

  it("starts one session and releases the topic claim", async () => {
    const result = await handleFeishuCardAction(payload, {} as never, "trace-start");

    expect(result).toEqual({ ok: true, content: "已开始创建会话。" });
    expect(mocks.startNewSession).toHaveBeenCalledOnce();
    expect(mocks.releaseThreadSelection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rootMessageId: "root", threadId: "thread" }),
      "action-1"
    );
    expect(mocks.deletePendingRequest).toHaveBeenCalledWith(expect.anything(), pendingId);
  });

  it("rejects a card from an older staged selection revision", async () => {
    mocks.getPendingRequest.mockResolvedValue({
      ...(await mocks.getPendingRequest()),
      selectionRevision: 1,
    });

    const result = await handleFeishuCardAction(
      payloadWithRevision(0),
      {} as never,
      "trace-stale-revision"
    );

    expect(result).toEqual({
      ok: false,
      content: "这张卡片已过期，请使用该话题中最新的选择卡。",
    });
    expect(mocks.listRepositoryCatalog).not.toHaveBeenCalled();
    expect(mocks.startNewSession).not.toHaveBeenCalled();
  });

  it("stages repository selection before choosing a ready harness", async () => {
    mocks.getRuntimeCatalog.mockResolvedValue({
      harnesses: [
        {
          harness: "codex",
          displayName: "Codex",
          ready: true,
          routes: [{ routeId: "codex:openai:subscription", ready: true, models: [] }],
          settings: [],
        },
      ],
      commands: [],
    });
    mocks.updatePendingRequest.mockResolvedValue({
      ...mocks.getPendingRequest.mock.results[0]?.value,
      selectedRepositoryKey: target.repositoryKey,
      selectedConnectionId: target.connectionId,
    });

    const result = await handleFeishuCardAction(payload, {} as never, "trace-runtime-stage");

    expect(result).toEqual({ ok: true, content: "请选择 Harness。" });
    expect(mocks.startNewSession).not.toHaveBeenCalled();
    expect(mocks.replySessionCard).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rootMessageId: "root" }),
      expect.any(Object)
    );
    expect(mocks.updatePendingRequest).toHaveBeenCalledWith(
      expect.anything(),
      pendingId,
      expect.objectContaining({ selectedRepositoryKey: target.repositoryKey })
    );
  });

  it("validates the selected model and launches with the selected effort", async () => {
    const runtimeCatalog = {
      harnesses: [
        {
          harness: "codex" as const,
          displayName: "Codex",
          ready: true,
          settings: [],
          routes: [
            {
              routeId: "codex:openai:subscription",
              ready: true,
              models: [
                {
                  model: "openai/gpt-5.6-luna",
                  displayName: "GPT 5.6 Luna",
                  ready: true,
                  routeId: "codex:openai:subscription",
                  efforts: [{ value: "high", label: "high", nativeValue: "high", isDefault: true }],
                },
              ],
            },
          ],
        },
      ],
      commands: [],
    };
    mocks.getRuntimeCatalog.mockResolvedValue(runtimeCatalog);
    mocks.getPendingRequest.mockResolvedValueOnce({
      ...(await mocks.getPendingRequest()),
      selectedRepositoryKey: target.repositoryKey,
      selectedConnectionId: target.connectionId,
      runtime: {
        harness: "codex",
        routeId: "codex:openai:subscription",
        model: "openai/gpt-5.6-luna",
      },
    });
    mocks.getPendingRequest.mockResolvedValue({
      ...(await mocks.getPendingRequest()),
      selectedRepositoryKey: target.repositoryKey,
      selectedConnectionId: target.connectionId,
      runtime: {
        harness: "codex",
        routeId: "codex:openai:subscription",
        model: "openai/gpt-5.6-luna",
        effort: "high",
      },
    });
    mocks.updatePendingRequest.mockResolvedValue({
      ...(await mocks.getPendingRequest()),
      selectedRepositoryKey: target.repositoryKey,
      selectedConnectionId: target.connectionId,
      runtime: {
        harness: "codex",
        routeId: "codex:openai:subscription",
        model: "openai/gpt-5.6-luna",
        effort: "high",
      },
    });

    const effortPayload = {
      ...payload,
      header: { event_id: "action-effort", tenant_key: "tenant" },
      event: {
        ...payload.event,
        action: {
          value: {
            action: "select_effort",
            pendingId,
            connectionId: target.connectionId,
            repositoryKey: target.repositoryKey,
            harness: "codex",
            routeId: "codex:openai:subscription",
            model: "openai/gpt-5.6-luna",
            effort: "high",
          },
        },
      },
    };
    const result = await handleFeishuCardAction(effortPayload, {} as never, "trace-effort");

    expect(result).toEqual({ ok: true, content: "已开始创建会话。" });
    expect(mocks.startNewSession).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKey: target.repositoryKey,
        runtime: {
          harness: "codex",
          routeId: "codex:openai:subscription",
          model: "openai/gpt-5.6-luna",
          effort: "high",
        },
      })
    );
  });
});
