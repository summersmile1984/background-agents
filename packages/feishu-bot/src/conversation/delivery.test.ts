import { beforeEach, describe, expect, it, vi } from "vitest";
import { replyFeishuCard, replyFeishuImage, replyFeishuText } from "../feishu/client";
import type { Env } from "../types";
import { replySessionCard, replySessionImage, replySessionText } from "./delivery";

vi.mock("../feishu/client", () => ({
  replyFeishuCard: vi.fn(),
  replyFeishuImage: vi.fn(),
  replyFeishuText: vi.fn(),
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
});
