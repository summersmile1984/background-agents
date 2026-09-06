import { describe, expect, it, vi } from "vitest";
import { createLaunchPending, getLaunchPending, updateLaunchPending } from "./launch-store";

class MemoryKv {
  readonly data = new Map<string, string>();

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

describe("Feishu launch pending store", () => {
  it("round-trips V2 launch state and increments selection revisions", async () => {
    const kv = new MemoryKv();
    const env = { FEISHU_KV: kv as unknown as KVNamespace };
    const created = await createLaunchPending(env, {
      tenantKey: "tenant",
      chatId: "chat",
      chatType: "group",
      rootMessageId: "root",
      threadId: "thread",
      replyMode: "thread",
      incomingMessageId: "incoming",
      actorId: "feishu:tenant:user",
      content: "实现任务",
    });

    expect(created).toMatchObject({ version: 2, phase: "resolving", selectionRevision: 0 });
    const updated = await updateLaunchPending(env, created.pendingId, (current) => ({
      ...current,
      phase: "configuring",
      view: "workspace",
      editor: {
        kind: "workspace",
        base: current.intent,
        draft: { target: { kind: "none" } },
      },
    }));

    expect(updated).toMatchObject({ selectionRevision: 1, editor: { base: { target: null } } });
    await expect(getLaunchPending(env, created.pendingId)).resolves.toEqual(updated);
  });

  it("rejects corrupt persisted state instead of trusting callback-owned data", async () => {
    const kv = new MemoryKv();
    const id = "00000000-0000-4000-8000-000000000001";
    kv.data.set(`launch-pending:${id}`, JSON.stringify({ version: 2, pendingId: id }));

    await expect(
      getLaunchPending({ FEISHU_KV: kv as unknown as KVNamespace }, id)
    ).resolves.toBeNull();
  });

  it("never refreshes a launch card beyond its maximum lifetime", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
      const kv = new MemoryKv();
      const env = { FEISHU_KV: kv as unknown as KVNamespace };
      const created = await createLaunchPending(env, {
        tenantKey: "tenant",
        chatId: "chat",
        chatType: "p2p",
        rootMessageId: "root",
        replyMode: "flat",
        incomingMessageId: "incoming",
        actorId: "feishu:tenant:user",
        content: "实现任务",
      });

      vi.advanceTimersByTime(3 * 60 * 60 * 1_000);
      await expect(
        updateLaunchPending(env, created.pendingId, (current) => ({
          ...current,
          view: "workspace",
        }))
      ).resolves.not.toBeNull();

      vi.advanceTimersByTime(61 * 60 * 1_000);
      await expect(getLaunchPending(env, created.pendingId)).resolves.toBeNull();
      await expect(
        updateLaunchPending(env, created.pendingId, (current) => current)
      ).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
