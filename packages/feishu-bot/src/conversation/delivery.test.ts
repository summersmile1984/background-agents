import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  replyFeishuCard,
  replyFeishuImage,
  replyFeishuText,
  updateFeishuCard,
} from "../feishu/client";
import type { Env } from "../types";
import {
  replySessionCard,
  replySessionImage,
  replySessionText,
  updateSessionCard,
} from "./delivery";

vi.mock("../feishu/client", () => ({
  replyFeishuCard: vi.fn(),
  replyFeishuImage: vi.fn(),
  replyFeishuText: vi.fn(),
  updateFeishuCard: vi.fn(),
}));
vi.mock("./store", () => ({
  storeThreadMessageAlias: vi.fn().mockResolvedValue(undefined),
}));

const env = {} as Env;

describe("Feishu session delivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("always targets the stable root and opts native topics into thread delivery", async () => {
    await replySessionText(
      env,
      { rootMessageId: "root-1", replyMode: "thread" },
      "working",
      "event-1"
    );
    await replySessionCard(env, { rootMessageId: "root-1", replyMode: "thread" }, { card: true });
    await replySessionImage(env, { rootMessageId: "root-1", replyMode: "thread" }, "img-1");

    expect(replyFeishuText).toHaveBeenCalledWith(env, "root-1", "working", {
      replyInThread: true,
      idempotencyKey: "event-1",
    });
    expect(replyFeishuCard).toHaveBeenCalledWith(
      env,
      "root-1",
      { card: true },
      {
        replyInThread: true,
      }
    );
    expect(replyFeishuImage).toHaveBeenCalledWith(env, "root-1", "img-1", {
      replyInThread: true,
    });
  });

  it("keeps legacy and P2P sessions on the flat reply surface", async () => {
    await replySessionText(env, { rootMessageId: "root-2", replyMode: "flat" }, "done");

    expect(replyFeishuText).toHaveBeenCalledWith(env, "root-2", "done", {
      replyInThread: false,
    });
  });

  it("records outbound message IDs for quote-based continuation", async () => {
    const { storeThreadMessageAlias } = await import("./store");
    vi.mocked(replyFeishuCard).mockResolvedValueOnce({ messageId: "card-1" });
    const kvEnv = { ...env, FEISHU_KV: {} as Env["FEISHU_KV"] };
    const topicCoordinates = {
      tenantKey: "tenant-1",
      chatId: "chat-1",
      chatType: "group" as const,
      rootMessageId: "root-1",
      threadId: "thread-1",
      replyMode: "thread" as const,
    };

    await replySessionCard(kvEnv, topicCoordinates, { card: true });

    expect(storeThreadMessageAlias).toHaveBeenCalledWith(
      { FEISHU_KV: kvEnv.FEISHU_KV },
      topicCoordinates,
      "card-1"
    );
  });

  it("updates the existing lifecycle card without creating a new message alias", async () => {
    vi.mocked(updateFeishuCard).mockResolvedValueOnce({ messageId: "card-1" });

    await expect(updateSessionCard(env, "card-1", { schema: "2.0" })).resolves.toEqual({
      messageId: "card-1",
    });

    expect(updateFeishuCard).toHaveBeenCalledWith(env, "card-1", { schema: "2.0" });
    expect(replyFeishuCard).not.toHaveBeenCalled();
  });
});
