import { describe, expect, it } from "vitest";
import { listConversationSessions, storeThreadSession } from "./store";

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
}

describe("Feishu conversation session index", () => {
  it("keeps multiple root-task sessions for one chat", async () => {
    const env = { FEISHU_KV: new MemoryKv() as unknown as KVNamespace };
    const base = { tenantKey: "tenant", chatId: "chat" };
    await storeThreadSession(
      env,
      { ...base, rootMessageId: "root-one" },
      {
        sessionId: "session-one",
        repositoryKey: "repo-one",
        targetLabel: "Gitea / one",
        model: "model-a",
        actorId: "feishu:tenant:user",
        createdAt: 1,
      }
    );
    await storeThreadSession(
      env,
      { ...base, rootMessageId: "root-two" },
      {
        sessionId: "session-two",
        repositoryKey: "repo-two",
        targetLabel: "GitHub / two",
        model: "model-b",
        actorId: "feishu:tenant:user",
        createdAt: 2,
      }
    );

    await expect(
      listConversationSessions(env, { ...base, actorId: "feishu:tenant:user" })
    ).resolves.toEqual([
      { sessionId: "session-two", targetLabel: "GitHub / two", model: "model-b", createdAt: 2 },
      { sessionId: "session-one", targetLabel: "Gitea / one", model: "model-a", createdAt: 1 },
    ]);
  });
});
