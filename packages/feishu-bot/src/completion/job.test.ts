import { describe, expect, it } from "vitest";
import { feishuCompletionJobSchema } from "./job";

const base = {
  version: 1 as const,
  deliveryId: "00000000-0000-4000-8000-000000000001",
  sessionId: "session-1",
  messageId: "message-1",
  success: true,
  tenantKey: "tenant-1",
  chatId: "chat-1",
  rootMessageId: "root-1",
  targetLabel: "owner/repo",
  model: "openai/gpt-5.6-luna",
};

describe("Feishu completion job compatibility", () => {
  it("accepts a legacy flat job without thread fields", () => {
    expect(feishuCompletionJobSchema.safeParse(base).success).toBe(true);
  });

  it("preserves native topic and runtime metadata on new jobs", () => {
    expect(
      feishuCompletionJobSchema.parse({
        ...base,
        chatType: "group",
        threadId: "thread-1",
        replyMode: "thread",
        branch: "codex/topic-a",
        harness: "codex",
        reasoningEffort: "high",
      })
    ).toMatchObject({
      chatType: "group",
      threadId: "thread-1",
      replyMode: "thread",
      branch: "codex/topic-a",
      harness: "codex",
      reasoningEffort: "high",
    });
  });
});
