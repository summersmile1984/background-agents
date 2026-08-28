import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type { FeishuEventEnvelope } from "./payload";

const mocks = vi.hoisted(() => ({
  replySessionCard: vi.fn(),
  replySessionText: vi.fn(),
  resolveFeishuBotOpenId: vi.fn(),
  sendFeishuCard: vi.fn(),
  sendFeishuText: vi.fn(),
  lookupThreadSession: vi.fn(),
  listConversationSessions: vi.fn(),
  storePendingRequest: vi.fn(),
  listRepositoryCatalog: vi.fn(),
  sendPrompt: vi.fn(),
  updateThreadSession: vi.fn(),
}));

vi.mock("../conversation/delivery", () => ({
  replySessionCard: mocks.replySessionCard,
  replySessionText: mocks.replySessionText,
}));

vi.mock("../feishu/client", () => ({
  resolveFeishuBotOpenId: mocks.resolveFeishuBotOpenId,
  sendFeishuCard: mocks.sendFeishuCard,
  sendFeishuText: mocks.sendFeishuText,
}));

vi.mock("../conversation/store", () => ({
  clearThreadSession: vi.fn(),
  listConversationSessions: mocks.listConversationSessions,
  lookupThreadSession: mocks.lookupThreadSession,
  storePendingRequest: mocks.storePendingRequest,
  storeThreadSession: vi.fn(),
  updateThreadSession: mocks.updateThreadSession,
}));

vi.mock("../sessions/control-plane-client", () => ({
  createSession: vi.fn(),
  defaultHarnessForModel: (model: string) => {
    if (model.startsWith("openai/")) return "codex";
    if (model.startsWith("anthropic/")) return "claude";
    if (model.startsWith("deepseek/")) return "deepseek";
    return "inherit";
  },
  sendPrompt: mocks.sendPrompt,
}));

vi.mock("../targets", () => ({
  findRepositoryTarget: vi.fn(),
  inferRepositoryBranch: vi.fn(() => undefined),
  inferRepositoryTarget: vi.fn(() => undefined),
  listRepositoryCatalog: mocks.listRepositoryCatalog,
  listRepositoryTargets: vi.fn(),
}));

import {
  canReuseThreadSession,
  handleFeishuEvent,
  visualVerificationForPrompt,
} from "./dispatcher";

const thread = {
  version: 2,
  sessionId: "session-1",
  repositoryKey: "gitea-default:huangdong/chatbi",
  targetLabel: "huangdong/chatbi",
  model: "openai/gpt-5.6-luna",
  harness: "inherit",
  actorId: "feishu:tenant:user",
  chatType: "p2p",
  rootMessageId: "message-1",
  replyMode: "flat",
  state: "active",
  createdAt: 1,
  updatedAt: 1,
} as const;

describe("canReuseThreadSession", () => {
  it("does not route a native model to a legacy harness-unknown session", () => {
    expect(canReuseThreadSession({ ...thread, state: "stale" })).toBe(false);
  });

  it("reuses a session only when its current model and harness both match", () => {
    expect(canReuseThreadSession({ ...thread, harness: "codex" })).toBe(true);
    expect(canReuseThreadSession({ ...thread, harness: "opencode" })).toBe(false);
    expect(
      canReuseThreadSession({ ...thread, model: "openrouter/model", harness: "inherit" })
    ).toBe(true);
  });
});

describe("visualVerificationForPrompt", () => {
  it.each(["生产视觉验证", "请截图验证这个页面", "请验证 UI", "verify ui after the change"])(
    "enables verification for an explicit request: %s",
    (prompt) => {
      expect(visualVerificationForPrompt(prompt)).toEqual({});
    }
  );

  it("keeps ordinary coding prompts free of browser work", () => {
    expect(visualVerificationForPrompt("修复登录页面的按钮样式")).toBeUndefined();
  });
});

const event = {
  header: { event_type: "im.message.receive_v1", tenant_key: "tenant-1" },
  event: {
    sender: { sender_type: "user", sender_id: { open_id: "user-1" } },
    message: {
      chat_id: "chat-1",
      chat_type: "p2p",
      message_id: "message-1",
      message_type: "text",
      content: JSON.stringify({ text: "检查项目" }),
    },
  },
} satisfies FeishuEventEnvelope;

const env = {
  DEFAULT_MODEL: "openai/gpt-5.6-luna",
  WEB_APP_URL: "https://inspect.example.com",
} as Env;

describe("handleFeishuEvent receipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replySessionText.mockResolvedValue({ messageId: "receipt-1" });
    mocks.replySessionCard.mockResolvedValue({ messageId: "picker-1" });
    mocks.resolveFeishuBotOpenId.mockResolvedValue("bot-1");
    mocks.lookupThreadSession.mockResolvedValue(null);
    mocks.sendPrompt.mockResolvedValue({ ok: true, data: {} });
    mocks.updateThreadSession.mockResolvedValue(null);
    mocks.storePendingRequest.mockResolvedValue("pending-1");
    mocks.listRepositoryCatalog.mockResolvedValue({
      connections: [
        {
          id: "gitea-default",
          label: "Gitea",
          provider: "gitea",
          repositoryCount: 1,
          catalogStatus: "available",
        },
      ],
      targets: [
        {
          connectionId: "gitea-default",
          provider: "gitea",
          repositoryKey: "gitea-default:huangdong/chatbi",
          fullName: "huangdong/chatbi",
          displayName: "chatbi",
          connectionLabel: "Gitea",
          defaultBranch: "main",
        },
      ],
    });
  });

  it("promotes a new group root request to a native topic", async () => {
    mocks.replySessionText.mockResolvedValueOnce({
      messageId: "receipt-group",
      threadId: "thread-group",
    });
    const groupEvent = {
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          chat_type: "group" as const,
          mentions: [{ id: { open_id: "bot-1" } }],
        },
      },
    } satisfies FeishuEventEnvelope;
    const groupEnv = {
      ...env,
      FEISHU_TRIGGERS_ENABLED: "true",
      FEISHU_THREAD_REPLIES_ENABLED: "true",
      FEISHU_BOT_OPEN_ID: "bot-1",
    };

    await handleFeishuEvent(groupEvent, groupEnv, "trace-group");

    expect(mocks.resolveFeishuBotOpenId).toHaveBeenCalledWith(groupEnv);
    expect(mocks.replySessionText).toHaveBeenCalledWith(
      groupEnv,
      expect.objectContaining({
        chatType: "group",
        rootMessageId: "message-1",
        replyMode: "thread",
      }),
      expect.stringContaining("已收到")
    );
    expect(mocks.storePendingRequest).toHaveBeenCalledWith(
      groupEnv,
      expect.objectContaining({
        rootMessageId: "message-1",
        threadId: "thread-group",
        replyMode: "thread",
      })
    );
    expect(mocks.replySessionCard).toHaveBeenCalledWith(
      groupEnv,
      expect.objectContaining({ threadId: "thread-group", replyMode: "thread" }),
      expect.any(Object)
    );
  });

  it("accepts the rich-text payload produced by a topic-group root", async () => {
    const groupEvent = {
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          chat_type: "group" as const,
          message_type: "post",
          mentions: [{ id: { open_id: "bot-1" } }],
          content: JSON.stringify({
            title: "",
            content: [
              [
                { tag: "at", user_id: "bot-1", user_name: "代码智能体" },
                { tag: "text", text: " 帮我看看 chatbi 项目", style: [] },
              ],
            ],
          }),
        },
      },
    } satisfies FeishuEventEnvelope;
    const groupEnv = {
      ...env,
      FEISHU_TRIGGERS_ENABLED: "true",
      FEISHU_THREAD_REPLIES_ENABLED: "true",
      FEISHU_BOT_OPEN_ID: "bot-1",
    };

    await handleFeishuEvent(groupEvent, groupEnv, "trace-group-post");

    expect(mocks.replySessionText).toHaveBeenCalledWith(
      groupEnv,
      expect.any(Object),
      expect.stringContaining("已收到")
    );
    expect(mocks.storePendingRequest).toHaveBeenCalledWith(
      groupEnv,
      expect.objectContaining({ content: "帮我看看 chatbi 项目" })
    );
  });

  it("ignores an unbound unmentioned group message before catalog discovery", async () => {
    const groupEvent = {
      ...event,
      event: {
        ...event.event,
        message: { ...event.event.message, chat_type: "group" as const },
      },
    } satisfies FeishuEventEnvelope;

    await handleFeishuEvent(
      groupEvent,
      {
        ...env,
        FEISHU_TRIGGERS_ENABLED: "true",
        FEISHU_THREAD_REPLIES_ENABLED: "true",
        FEISHU_BOUND_THREAD_FOLLOWUPS_ENABLED: "true",
        FEISHU_BOT_OPEN_ID: "bot-1",
      },
      "trace-ignore"
    );

    expect(mocks.lookupThreadSession).toHaveBeenCalledOnce();
    expect(mocks.resolveFeishuBotOpenId).not.toHaveBeenCalled();
    expect(mocks.replySessionText).not.toHaveBeenCalled();
    expect(mocks.listRepositoryCatalog).not.toHaveBeenCalled();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
  });

  it("continues the owner's bound group topic without another mention", async () => {
    mocks.lookupThreadSession.mockResolvedValue({
      ...thread,
      harness: "codex",
      actorId: "feishu:tenant-1:user-1",
      chatType: "group",
      rootMessageId: "root-1",
      threadId: "thread-1",
      replyMode: "thread",
      branch: "codex/topic-a",
    });
    const followUp = {
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          chat_type: "group" as const,
          message_id: "follow-up-1",
          root_id: "root-1",
          thread_id: "thread-1",
          content: JSON.stringify({ text: "继续并截图验证" }),
        },
      },
    } satisfies FeishuEventEnvelope;
    const groupEnv = {
      ...env,
      FEISHU_TRIGGERS_ENABLED: "true",
      FEISHU_THREAD_REPLIES_ENABLED: "true",
      FEISHU_BOUND_THREAD_FOLLOWUPS_ENABLED: "true",
      FEISHU_BOT_OPEN_ID: "bot-1",
    };

    await handleFeishuEvent(followUp, groupEnv, "trace-follow-up");

    expect(mocks.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        content: "继续并截图验证",
        callbackContext: expect.objectContaining({
          rootMessageId: "root-1",
          threadId: "thread-1",
          replyMode: "thread",
          branch: "codex/topic-a",
          harness: "codex",
        }),
      })
    );
    expect(mocks.listRepositoryCatalog).not.toHaveBeenCalled();
    expect(mocks.updateThreadSession).toHaveBeenCalledWith(
      groupEnv,
      expect.objectContaining({ rootMessageId: "root-1" }),
      expect.objectContaining({ state: "active", lastMessageId: "follow-up-1" })
    );
  });

  it("keeps two topic roots routed to two independent sessions", async () => {
    const sessions = new Map([
      [
        "root-a",
        {
          ...thread,
          sessionId: "session-a",
          harness: "codex" as const,
          actorId: "feishu:tenant-1:user-1",
          chatType: "group" as const,
          rootMessageId: "root-a",
          threadId: "thread-a",
          replyMode: "thread" as const,
        },
      ],
      [
        "root-b",
        {
          ...thread,
          sessionId: "session-b",
          harness: "codex" as const,
          actorId: "feishu:tenant-1:user-1",
          chatType: "group" as const,
          rootMessageId: "root-b",
          threadId: "thread-b",
          replyMode: "thread" as const,
        },
      ],
    ]);
    mocks.lookupThreadSession.mockImplementation(
      async (_env, coordinates: { rootMessageId: string }) =>
        sessions.get(coordinates.rootMessageId) ?? null
    );
    const groupEnv = {
      ...env,
      FEISHU_TRIGGERS_ENABLED: "true",
      FEISHU_BOUND_THREAD_FOLLOWUPS_ENABLED: "true",
      FEISHU_BOT_OPEN_ID: "bot-1",
    };
    const followUp = (root: string, threadId: string, text: string): FeishuEventEnvelope => ({
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          chat_type: "group",
          message_id: `message-${root}`,
          root_id: root,
          thread_id: threadId,
          content: JSON.stringify({ text }),
        },
      },
    });

    await handleFeishuEvent(followUp("root-a", "thread-a", "prompt-a"), groupEnv, "trace-a");
    await handleFeishuEvent(followUp("root-b", "thread-b", "prompt-b"), groupEnv, "trace-b");

    expect(mocks.sendPrompt.mock.calls.map(([input]) => [input.sessionId, input.content])).toEqual([
      ["session-a", "prompt-a"],
      ["session-b", "prompt-b"],
    ]);
  });

  it("acknowledges the message before repository discovery and selection", async () => {
    await handleFeishuEvent(event, env, "trace-1");

    expect(mocks.replySessionText).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ rootMessageId: "message-1", replyMode: "flat" }),
      expect.stringContaining("已收到，正在工作中")
    );
    expect(mocks.replySessionCard).toHaveBeenCalledOnce();
    expect(mocks.replySessionText.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.listRepositoryCatalog.mock.invocationCallOrder[0]
    );
  });

  it("reports a visible failure after an acknowledged message", async () => {
    mocks.listRepositoryCatalog.mockRejectedValueOnce(new Error("catalog unavailable"));

    await expect(handleFeishuEvent(event, env, "trace-2")).resolves.toBeUndefined();

    expect(mocks.replySessionText).toHaveBeenCalledTimes(2);
    expect(mocks.replySessionText).toHaveBeenLastCalledWith(
      env,
      expect.objectContaining({ rootMessageId: "message-1", replyMode: "flat" }),
      expect.stringContaining("后续处理暂时失败")
    );
  });

  it("reports a refreshing repository catalog distinctly from an empty deployment", async () => {
    mocks.listRepositoryCatalog.mockResolvedValueOnce({
      connections: [
        {
          id: "gitea-default",
          label: "Gitea",
          provider: "gitea",
          repositoryCount: 0,
          catalogStatus: "refreshing",
        },
      ],
      targets: [],
    });

    await handleFeishuEvent(event, env, "trace-refreshing");

    expect(mocks.replySessionText).toHaveBeenLastCalledWith(
      env,
      expect.any(Object),
      expect.stringContaining("正在刷新")
    );
  });
});
