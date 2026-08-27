import { describe, expect, it } from "vitest";
import { feishuCallbackContextSchema } from "./session-api";

const legacy = {
  source: "feishu" as const,
  tenantKey: "tenant-1",
  chatId: "chat-1",
  rootMessageId: "root-1",
  targetLabel: "owner/repo",
  model: "openai/gpt-5.6-luna",
};

describe("Feishu callback context", () => {
  it("accepts legacy flat contexts during rolling upgrades", () => {
    expect(feishuCallbackContextSchema.safeParse(legacy).success).toBe(true);
  });

  it("preserves native topic and pinned runtime metadata", () => {
    expect(
      feishuCallbackContextSchema.parse({
        ...legacy,
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
