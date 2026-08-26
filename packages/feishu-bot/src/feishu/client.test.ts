import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { clearTenantAccessTokenCache, replyFeishuText } from "./client";

const env = {
  FEISHU_APP_ID: "cli_test",
  FEISHU_APP_SECRET: "secret",
} as Env;

describe("Feishu message client", () => {
  beforeEach(() => {
    clearTenantAccessTokenCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replies to the received message with plain text", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 3600 }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { message_id: "reply-1" } }), {
          status: 200,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(replyFeishuText(env, "om/message", "已收到，正在处理。")).resolves.toBe(
      "reply-1"
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/im/v1/messages/om%2Fmessage/reply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          msg_type: "text",
          content: JSON.stringify({ text: "已收到，正在处理。" }),
        }),
      })
    );
  });

  it("preserves safe Feishu error details for production diagnosis", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 3600 }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 230001, msg: "invalid message card" }), {
          status: 400,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(replyFeishuText(env, "om_1", "test")).rejects.toThrow(
      "http_status=400, code=230001, msg=invalid message card"
    );
  });
});
