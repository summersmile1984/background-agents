import { describe, expect, it } from "vitest";
import {
  listConversationSessions,
  lookupThreadSession,
  storeThreadSession,
  updateThreadSession,
} from "./store";

class MemoryKv {
  private readonly data = new Map<string, string>();

  async get(key: string, type?: "json"): Promise<unknown> {
    const value = this.data.get(key);
    if (value == null) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  seed(key: string, value: unknown): void {
    this.data.set(key, JSON.stringify(value));
  }
}

describe("Feishu conversation session index", () => {
  it("keeps multiple root-task sessions for one chat", async () => {
    const env = { FEISHU_KV: new MemoryKv() as unknown as KVNamespace };
    const base = {
      tenantKey: "tenant",
      chatId: "chat",
      chatType: "p2p" as const,
      replyMode: "flat" as const,
    };
    await storeThreadSession(
      env,
      { ...base, rootMessageId: "root-one" },
      {
        version: 2,
        sessionId: "session-one",
        repositoryKey: "repo-one",
        targetLabel: "Gitea / one",
        model: "model-a",
        harness: "inherit",
        actorId: "feishu:tenant:user",
        chatType: "p2p",
        rootMessageId: "root-one",
        replyMode: "flat",
        state: "active",
        createdAt: 1,
        updatedAt: 1,
      }
    );
    await storeThreadSession(
      env,
      { ...base, rootMessageId: "root-two" },
      {
        version: 2,
        sessionId: "session-two",
        repositoryKey: "repo-two",
        targetLabel: "GitHub / two",
        model: "model-b",
        harness: "inherit",
        actorId: "feishu:tenant:user",
        chatType: "p2p",
        rootMessageId: "root-two",
        replyMode: "flat",
        state: "active",
        createdAt: 2,
        updatedAt: 2,
      }
    );

    await expect(
      listConversationSessions(env, { ...base, actorId: "feishu:tenant:user" })
    ).resolves.toMatchObject([
      {
        sessionId: "session-two",
        targetLabel: "GitHub / two",
        model: "model-b",
        state: "active",
        rootMessageId: "root-two",
      },
      {
        sessionId: "session-one",
        targetLabel: "Gitea / one",
        model: "model-a",
        state: "active",
        rootMessageId: "root-one",
      },
    ]);
  });

  it("normalizes a legacy mapping to a safe flat V2 record", async () => {
    const kv = new MemoryKv();
    const env = { FEISHU_KV: kv as unknown as KVNamespace };
    kv.seed("thread:tenant:chat:legacy-root", {
      sessionId: "legacy-session",
      repositoryKey: "repo-legacy",
      targetLabel: "Legacy / repo",
      model: "openai/gpt-5.6-luna",
      actorId: "feishu:tenant:user",
      createdAt: 10,
    });

    await expect(
      lookupThreadSession(env, {
        tenantKey: "tenant",
        chatId: "chat",
        chatType: "group",
        rootMessageId: "legacy-root",
        threadId: "new-thread-coordinate",
        replyMode: "thread",
      })
    ).resolves.toMatchObject({
      version: 2,
      sessionId: "legacy-session",
      harness: "inherit",
      chatType: "group",
      rootMessageId: "legacy-root",
      replyMode: "flat",
      state: "stale",
    });
  });

  it("refreshes state without changing a session's pinned reply surface", async () => {
    const env = { FEISHU_KV: new MemoryKv() as unknown as KVNamespace };
    const coordinates = {
      tenantKey: "tenant",
      chatId: "chat",
      chatType: "group" as const,
      rootMessageId: "root-thread",
      threadId: "thread-1",
      replyMode: "thread" as const,
    };
    await storeThreadSession(env, coordinates, {
      version: 2,
      sessionId: "session-thread",
      repositoryKey: "repo-thread",
      targetLabel: "GitHub / thread",
      model: "openai/gpt-5.6-luna",
      harness: "codex",
      actorId: "feishu:tenant:user",
      chatType: "group",
      rootMessageId: "root-thread",
      threadId: "thread-1",
      replyMode: "thread",
      state: "starting",
      createdAt: 1,
      updatedAt: 1,
    });

    await updateThreadSession(
      env,
      { ...coordinates, replyMode: "flat" },
      { state: "completed", lastMessageId: "reply-2" }
    );

    await expect(lookupThreadSession(env, coordinates)).resolves.toMatchObject({
      state: "completed",
      lastMessageId: "reply-2",
      replyMode: "thread",
      threadId: "thread-1",
    });
  });
});
