import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimCardActionOnce: vi.fn(),
  claimThreadSelection: vi.fn(),
  deletePendingRequest: vi.fn(),
  getPendingRequest: vi.fn(),
  lookupThreadSession: vi.fn(),
  releaseThreadSelection: vi.fn(),
  replySessionCard: vi.fn(),
  replySessionText: vi.fn(),
  startNewSession: vi.fn(),
  findRepositoryTarget: vi.fn(),
  listRepositoryCatalog: vi.fn(),
}));

vi.mock("../conversation/store", () => ({
  claimCardActionOnce: mocks.claimCardActionOnce,
  claimThreadSelection: mocks.claimThreadSelection,
  deletePendingRequest: mocks.deletePendingRequest,
  getPendingRequest: mocks.getPendingRequest,
  lookupThreadSession: mocks.lookupThreadSession,
  releaseThreadSelection: mocks.releaseThreadSelection,
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
});
