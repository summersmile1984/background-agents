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
  getRuntimeCatalog: vi.fn(),
  inferRepositoryTarget: vi.fn(() => null as unknown),
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

vi.mock("../sessions/runtime-catalog", () => ({
  getRuntimeCatalog: mocks.getRuntimeCatalog,
}));

vi.mock("../targets", () => ({
  findRepositoryTarget: vi.fn(),
  inferRepositoryBranch: vi.fn(() => undefined),
  inferRepositoryTarget: mocks.inferRepositoryTarget,
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
    mocks.getRuntimeCatalog.mockResolvedValue(null);
    mocks.inferRepositoryTarget.mockReturnValue(undefined);
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

  it("normalizes Feishu topic-group events to the group routing surface", async () => {
    mocks.replySessionText.mockResolvedValueOnce({
      messageId: "receipt-topic-group",
      threadId: "thread-topic-group",
    });
    const topicGroupEvent = {
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          chat_type: "topic_group" as const,
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

    await handleFeishuEvent(topicGroupEvent, groupEnv, "trace-topic-group");

    expect(mocks.replySessionText).toHaveBeenCalledWith(
      groupEnv,
      expect.objectContaining({ chatType: "group", replyMode: "thread" }),
      expect.stringContaining("已收到")
    );
    expect(mocks.storePendingRequest).toHaveBeenCalledWith(
      groupEnv,
      expect.objectContaining({ chatType: "group", replyMode: "thread" })
    );
  });

  it("falls back to flat replies when the new-thread rollout flag is disabled", async () => {
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
    const rollbackEnv = {
      ...env,
      FEISHU_TRIGGERS_ENABLED: "true",
      FEISHU_THREAD_REPLIES_ENABLED: "false",
      FEISHU_BOUND_THREAD_FOLLOWUPS_ENABLED: "false",
      FEISHU_BOT_OPEN_ID: "bot-1",
    };

    await handleFeishuEvent(groupEvent, rollbackEnv, "trace-rollback");

    expect(mocks.replySessionText).toHaveBeenCalledWith(
      rollbackEnv,
      expect.objectContaining({ chatType: "group", replyMode: "flat" }),
      expect.stringContaining("已收到")
    );
    expect(mocks.replySessionCard).toHaveBeenCalledWith(
      rollbackEnv,
      expect.objectContaining({ chatType: "group", replyMode: "flat" }),
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
    expect(mocks.replySessionText).toHaveBeenNthCalledWith(
      1,
      groupEnv,
      expect.objectContaining({ rootMessageId: "root-1", threadId: "thread-1" }),
      expect.stringContaining("本话题沿用已绑定仓库，无需重新选择")
    );
    expect(mocks.listRepositoryCatalog).not.toHaveBeenCalled();
    expect(mocks.updateThreadSession).toHaveBeenCalledWith(
      groupEnv,
      expect.objectContaining({ rootMessageId: "root-1" }),
      expect.objectContaining({ state: "active", lastMessageId: "follow-up-1" })
    );
  });

  it("preserves a stored topic when a reply event omits thread_id", async () => {
    mocks.lookupThreadSession.mockResolvedValue({
      ...thread,
      harness: "codex",
      actorId: "feishu:tenant-1:user-1",
      chatType: "group",
      rootMessageId: "root-omitted-thread",
      threadId: "stored-thread",
      replyMode: "thread",
    });
    const followUp = {
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          chat_type: "group" as const,
          message_id: "follow-up-omitted-thread",
          root_id: "root-omitted-thread",
          content: JSON.stringify({ text: "继续这个话题" }),
        },
      },
    } satisfies FeishuEventEnvelope;
    const groupEnv = {
      ...env,
      FEISHU_TRIGGERS_ENABLED: "true",
      FEISHU_BOUND_THREAD_FOLLOWUPS_ENABLED: "true",
      FEISHU_BOT_OPEN_ID: "bot-1",
    };

    await handleFeishuEvent(followUp, groupEnv, "trace-omitted-thread");

    expect(mocks.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        callbackContext: expect.objectContaining({
          rootMessageId: "root-omitted-thread",
          threadId: "stored-thread",
          replyMode: "thread",
        }),
      })
    );
    expect(mocks.replySessionText).toHaveBeenNthCalledWith(
      1,
      groupEnv,
      expect.objectContaining({
        rootMessageId: "root-omitted-thread",
        threadId: "stored-thread",
        replyMode: "thread",
      }),
      expect.stringContaining("本话题沿用已绑定仓库")
    );
  });

  it("routes a private-chat reply by its root message instead of the latest session", async () => {
    mocks.lookupThreadSession.mockResolvedValue({
      ...thread,
      harness: "codex",
      actorId: "feishu:tenant-1:user-1",
      chatType: "p2p",
      rootMessageId: "root-private-chat",
      replyMode: "flat",
      targetLabel: "huangdong/chatbi",
    });
    const privateReply = {
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          chat_type: "p2p" as const,
          message_id: "private-reply-1",
          root_id: "root-private-chat",
          parent_id: "root-private-chat",
          content: JSON.stringify({ text: "继续检查，不要修改文件" }),
        },
      },
    } satisfies FeishuEventEnvelope;

    await handleFeishuEvent(privateReply, env, "trace-private-reply");

    expect(mocks.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        content: "继续检查，不要修改文件",
        callbackContext: expect.objectContaining({
          rootMessageId: "root-private-chat",
          replyMode: "flat",
        }),
      })
    );
    expect(mocks.listRepositoryCatalog).not.toHaveBeenCalled();
  });

  it("uses parent_id when a private quote omits root_id", async () => {
    mocks.lookupThreadSession.mockResolvedValue({
      ...thread,
      harness: "codex",
      actorId: "feishu:tenant-1:user-1",
      chatType: "p2p",
      rootMessageId: "root-quote-only",
      targetLabel: "huangdong/chatbi",
    });
    const quoteReply = {
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          chat_type: "p2p" as const,
          message_id: "quote-only-reply",
          parent_id: "root-quote-only",
          content: JSON.stringify({ text: "继续处理引用的任务" }),
        },
      },
    } satisfies FeishuEventEnvelope;

    await handleFeishuEvent(quoteReply, env, "trace-quote-only");

    expect(mocks.lookupThreadSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ rootMessageId: "root-quote-only" })
    );
    expect(mocks.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", content: "继续处理引用的任务" })
    );
  });

  it("does not reveal the bound repository before rejecting another actor", async () => {
    mocks.lookupThreadSession.mockResolvedValue({
      ...thread,
      harness: "codex",
      actorId: "feishu:tenant-1:owner",
      targetLabel: "private-owner/secret-repository",
      chatType: "group",
      rootMessageId: "root-private",
      threadId: "thread-private",
      replyMode: "thread",
    });
    const crossActorEvent = {
      ...event,
      event: {
        ...event.event,
        message: {
          ...event.event.message,
          chat_type: "group" as const,
          message_id: "message-cross-actor",
          root_id: "root-private",
          thread_id: "thread-private",
          mentions: [{ id: { open_id: "bot-1" } }],
          content: JSON.stringify({ text: "继续" }),
        },
      },
    } satisfies FeishuEventEnvelope;
    const groupEnv = {
      ...env,
      FEISHU_TRIGGERS_ENABLED: "true",
      FEISHU_THREAD_REPLIES_ENABLED: "true",
      FEISHU_BOT_OPEN_ID: "bot-1",
    };

    await handleFeishuEvent(crossActorEvent, groupEnv, "trace-cross-actor");

    const replies = mocks.replySessionText.mock.calls.map(([, , text]) => text);
    expect(replies).toEqual([
      "已收到，正在检查这个话题的会话状态。",
      "只有发起该会话的用户可以在此主题继续操作。",
    ]);
    expect(replies.join(" ")).not.toContain("private-owner/secret-repository");
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    expect(mocks.listRepositoryCatalog).not.toHaveBeenCalled();
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

  it("stages runtime selection even when the repository is inferred from the prompt", async () => {
    const inferredTarget = {
      repositoryKey: "gitea-default:huangdong/chatbi",
      fullName: "huangdong/chatbi",
      displayName: "chatbi",
      provider: "gitea",
      connectionId: "gitea-default",
      connectionLabel: "Gitea",
      defaultBranch: "main",
    };
    mocks.inferRepositoryTarget.mockReturnValue(inferredTarget);
    mocks.getRuntimeCatalog.mockResolvedValue({
      harnesses: [
        {
          harness: "codex",
          displayName: "Codex",
          description: "Codex",
          enabled: true,
          runtimeAvailable: true,
          ready: true,
          settingsSchemaVersion: "1",
          settings: [],
          liveMutation: { model: false, effort: false, settings: [] },
          routes: [
            {
              routeId: "codex:openai:subscription",
              harness: "codex",
              provider: "openai",
              transport: "native",
              displayName: "Codex subscription",
              ready: true,
              code: "READY",
              models: [
                {
                  model: "openai/gpt-5.6-luna",
                  displayName: "GPT 5.6 Luna",
                  description: "",
                  category: "general",
                  routeId: "codex:openai:subscription",
                  provider: "openai",
                  enabled: true,
                  ready: true,
                  efforts: [],
                  supportsAttachments: true,
                  supportsToolEvents: true,
                  supportsLiveModelSwitch: false,
                },
              ],
            },
          ],
        },
      ],
      commands: [],
    });

    await handleFeishuEvent(event, env, "trace-inferred-runtime");

    expect(mocks.storePendingRequest).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        content: "检查项目",
        selectedRepositoryKey: inferredTarget.repositoryKey,
        selectedConnectionId: inferredTarget.connectionId,
      })
    );
    expect(mocks.replySessionCard).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ rootMessageId: "message-1" }),
      expect.any(Object)
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
