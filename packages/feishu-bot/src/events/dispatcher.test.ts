import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type { FeishuEventEnvelope } from "./payload";

const mocks = vi.hoisted(() => ({
  replyFeishuCard: vi.fn(),
  replyFeishuText: vi.fn(),
  sendFeishuCard: vi.fn(),
  sendFeishuText: vi.fn(),
  lookupThreadSession: vi.fn(),
  listConversationSessions: vi.fn(),
  storePendingRequest: vi.fn(),
  listRepositoryCatalog: vi.fn(),
}));

vi.mock("../feishu/client", () => ({
  replyFeishuCard: mocks.replyFeishuCard,
  replyFeishuText: mocks.replyFeishuText,
  sendFeishuCard: mocks.sendFeishuCard,
  sendFeishuText: mocks.sendFeishuText,
}));

vi.mock("../conversation/store", () => ({
  clearThreadSession: vi.fn(),
  listConversationSessions: mocks.listConversationSessions,
  lookupThreadSession: mocks.lookupThreadSession,
  storePendingRequest: mocks.storePendingRequest,
  storeThreadSession: vi.fn(),
}));

vi.mock("../sessions/control-plane-client", () => ({
  createSession: vi.fn(),
  defaultHarnessForModel: (model: string) => (model.includes("gpt-") ? "codex" : "opencode"),
  sendPrompt: vi.fn(),
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
  sessionId: "session-1",
  repositoryKey: "gitea-default:huangdong/chatbi",
  targetLabel: "huangdong/chatbi",
  model: "openai/gpt-5.6-luna",
  actorId: "feishu:tenant:user",
  createdAt: 1,
} as const;

describe("canReuseThreadSession", () => {
  it("does not route a native model to a legacy harness-unknown session", () => {
    expect(canReuseThreadSession(thread, "openai/gpt-5.6-luna")).toBe(false);
  });

  it("reuses a session only when its current model and harness both match", () => {
    expect(canReuseThreadSession({ ...thread, harness: "codex" }, "openai/gpt-5.6-luna")).toBe(
      true
    );
    expect(canReuseThreadSession({ ...thread, harness: "opencode" }, "openai/gpt-5.6-luna")).toBe(
      false
    );
    expect(canReuseThreadSession({ ...thread, harness: "codex" }, "openai/gpt-5.6-sol")).toBe(
      false
    );
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
    mocks.replyFeishuText.mockResolvedValue("receipt-1");
    mocks.replyFeishuCard.mockResolvedValue("picker-1");
    mocks.lookupThreadSession.mockResolvedValue(null);
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

  it("acknowledges the message before repository discovery and selection", async () => {
    await handleFeishuEvent(event, env, "trace-1");

    expect(mocks.replyFeishuText).toHaveBeenCalledWith(
      env,
      "message-1",
      expect.stringContaining("已收到，正在工作中")
    );
    expect(mocks.replyFeishuCard).toHaveBeenCalledOnce();
    expect(mocks.replyFeishuText.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.listRepositoryCatalog.mock.invocationCallOrder[0]
    );
  });

  it("reports a visible failure after an acknowledged message", async () => {
    mocks.listRepositoryCatalog.mockRejectedValueOnce(new Error("catalog unavailable"));

    await expect(handleFeishuEvent(event, env, "trace-2")).resolves.toBeUndefined();

    expect(mocks.replyFeishuText).toHaveBeenCalledTimes(2);
    expect(mocks.replyFeishuText).toHaveBeenLastCalledWith(
      env,
      "message-1",
      expect.stringContaining("后续处理暂时失败")
    );
  });
});
