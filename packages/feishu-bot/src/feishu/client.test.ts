import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { buildTurnWorkingCard } from "../launch-cards";
import {
  clearTenantAccessTokenCache,
  replyFeishuImage,
  replyFeishuText,
  resolveFeishuBotOpenId,
  updateFeishuCard,
  uploadFeishuMessageImage,
} from "./client";

const env = {
  FEISHU_APP_ID: "cli_test",
  FEISHU_APP_SECRET: "secret",
  FEISHU_API_BASE: "https://open.feishu.cn",
} as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Feishu message client", () => {
  beforeEach(() => {
    clearTenantAccessTokenCache();
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

    await expect(replyFeishuText(env, "om/message", "已收到，正在处理。")).resolves.toEqual({
      messageId: "reply-1",
    });
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

  it("creates a native topic reply and preserves returned message coordinates", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 3600 }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              message_id: "reply-2",
              root_id: "root-1",
              parent_id: "root-1",
              thread_id: "thread-1",
            },
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      replyFeishuText(env, "root-1", "开始处理", {
        replyInThread: true,
        idempotencyKey: "event-1",
      })
    ).resolves.toEqual({
      messageId: "reply-2",
      rootMessageId: "root-1",
      parentMessageId: "root-1",
      threadId: "thread-1",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      msg_type: "text",
      content: JSON.stringify({ text: "开始处理" }),
      reply_in_thread: true,
      uuid: "event-1",
    });
  });

  it("retries a transient reply with the same idempotency key", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 3600 })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 500, msg: "temporarily unavailable" }, 500))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: "reply-retried" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      replyFeishuText(env, "root-1", "已收到", { idempotencyKey: "event-retry" })
    ).resolves.toEqual({ messageId: "reply-retried" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      uuid: "event-retry",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      uuid: "event-retry",
    });
  });

  it("retries one ambiguous network failure when a key makes it safe", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 3600 })
      )
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: "reply-network" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      replyFeishuText(env, "root-1", "已收到", { idempotencyKey: "event-network" })
    ).resolves.toEqual({ messageId: "reply-network" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      uuid: "event-network",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      uuid: "event-network",
    });
  });

  it("resolves and caches the bot Open ID when no override is configured", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 3600 })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: "ok", bot: { open_id: "ou_bot_1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveFeishuBotOpenId(env)).resolves.toBe("ou_bot_1");
    await expect(resolveFeishuBotOpenId(env)).resolves.toBe("ou_bot_1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/bot/v3/info",
      expect.objectContaining({ headers: { Authorization: "Bearer tenant-token" } })
    );
  });

  it("uses an explicit bot Open ID override without network access", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveFeishuBotOpenId({ ...env, FEISHU_BOT_OPEN_ID: "ou_configured" })
    ).resolves.toBe("ou_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("patches a bot-owned card in place using Card JSON 2.0", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 3600 })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const card = buildTurnWorkingCard({
      sessionId: "session-1",
      targetLabel: "owner/repo",
      webAppUrl: "https://open-inspect.example",
      model: "openai/gpt-5.6-luna",
      task: "检查项目",
    });

    await expect(updateFeishuCard(env, "om/card", card)).resolves.toEqual({
      messageId: "om/card",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://open.feishu.cn/open-apis/im/v1/messages/om%2Fcard",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ content: JSON.stringify(card) }),
      })
    );
  });

  it("retries a transient card update and classifies definite fallback failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 3600 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 500, msg: "busy" }), {
          status: 503,
          headers: { "Retry-After": "0" },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    const card = { schema: "2.0", config: { update_multi: true }, body: { elements: [] } };
    await expect(updateFeishuCard(env, "card-1", card)).resolves.toEqual({
      messageId: "card-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 230031, msg: "Message can only be modified within 14 days" }, 400)
    );
    await expect(updateFeishuCard(env, "card-2", card)).rejects.toMatchObject({
      reason: "not_editable",
      status: 400,
    });
  });

  it("uses Feishu API codes for rate limits and definite missing-card failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 3600 })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 230020, msg: "frequency limit" }, 400))
      .mockResolvedValueOnce(jsonResponse({ code: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const card = { schema: "2.0", config: { update_multi: true }, body: { elements: [] } };

    await expect(updateFeishuCard(env, "card-rate-limited", card)).resolves.toEqual({
      messageId: "card-rate-limited",
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 230110, msg: "message has been deleted" }, 400)
    );
    await expect(updateFeishuCard(env, "card-deleted", card)).rejects.toMatchObject({
      reason: "target_missing",
      status: 400,
    });
  });

  it.each([
    [401, "permission", 1],
    [403, "permission", 1],
    [404, "target_missing", 1],
    [429, "rate_limited", 2],
  ] as const)(
    "classifies PATCH HTTP %i as %s after %i attempt(s)",
    async (status, reason, updateAttempts) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 3600 })
        );
      for (let attempt = 0; attempt < updateAttempts; attempt += 1) {
        fetchMock.mockResolvedValueOnce(jsonResponse({ code: 999, msg: "failure" }, status));
      }
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        updateFeishuCard(env, `card-http-${status}`, {
          schema: "2.0",
          config: { update_multi: true },
          body: { elements: [] },
        })
      ).rejects.toMatchObject({ reason, status });
      expect(fetchMock).toHaveBeenCalledTimes(1 + updateAttempts);
    }
  );

  it.each([
    [230027, "permission"],
    [230099, "invalid_card"],
  ] as const)("classifies PATCH API code %i as %s", async (code, reason) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 3600 })
      )
      .mockResolvedValueOnce(jsonResponse({ code, msg: "official error" }, 400));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateFeishuCard(env, `card-code-${code}`, {
        schema: "2.0",
        config: { update_multi: true },
        body: { elements: [] },
      })
    ).rejects.toMatchObject({ reason, status: 400 });
  });

  it("rejects mutable cards that omit Feishu's update_multi contract before network access", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateFeishuCard(env, "card-1", { schema: "2.0", body: { elements: [] } })
    ).rejects.toMatchObject({ reason: "invalid_card" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects cards larger than Feishu's 30 KB limit before network access", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateFeishuCard(env, "card-oversized", {
        schema: "2.0",
        config: { update_multi: true },
        body: { elements: [{ tag: "markdown", content: "x".repeat(31 * 1024) }] },
      })
    ).rejects.toMatchObject({ reason: "invalid_card" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a legacy action component",
      elements: [{ tag: "action", actions: [] }],
    },
    {
      name: "a button without behaviors",
      elements: [{ tag: "button", text: { tag: "plain_text", content: "Start" } }],
    },
    {
      name: "a form without a submit button",
      elements: [{ tag: "form", name: "settings", elements: [] }],
    },
    {
      name: "more than 200 components",
      elements: Array.from({ length: 201 }, () => ({ tag: "markdown", content: "x" })),
    },
  ])("rejects $name before network access", async ({ elements }) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateFeishuCard(env, "card-invalid-v2", {
        schema: "2.0",
        config: { update_multi: true },
        body: { elements },
      })
    ).rejects.toMatchObject({ reason: "invalid_card" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not turn an ambiguous card update into a duplicate reply decision", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 3600 })
      )
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateFeishuCard(env, "card-1", {
        schema: "2.0",
        config: { update_multi: true },
        body: { elements: [] },
      })
    ).rejects.toMatchObject({ reason: "ambiguous" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Feishu media client", () => {
  beforeEach(() => {
    clearTenantAccessTokenCache();
    vi.restoreAllMocks();
  });

  it("uploads a message image as multipart data and validates the image key", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 7200 })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { image_key: "img_v2_key" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadFeishuMessageImage(env, {
        bytes: new Uint8Array([1, 2, 3]).buffer,
        mimeType: "image/png",
        filename: "artifact.png",
      })
    ).resolves.toEqual({ imageKey: "img_v2_key" });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://open.feishu.cn/open-apis/im/v1/images");
    expect(init?.headers).toEqual({ Authorization: "Bearer tenant-token" });
    expect(init?.body).toBeInstanceOf(FormData);
    const body = init?.body as FormData;
    expect(body.get("image_type")).toBe("message");
    const image = body.get("image") as unknown as File;
    expect(image.name).toBe("artifact.png");
    expect(image.type).toBe("image/png");
    expect(image.size).toBe(3);
  });

  it("replies with an image message without putting the key in the URL", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 7200 })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: "reply-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(replyFeishuImage(env, "root/message", "img-key")).resolves.toEqual({
      messageId: "reply-1",
    });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://open.feishu.cn/open-apis/im/v1/messages/root%2Fmessage/reply");
    expect(JSON.parse(String(init?.body))).toEqual({
      msg_type: "image",
      content: JSON.stringify({ image_key: "img-key" }),
    });
  });

  it("classifies rate limits and rejects unsupported media before network access", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 7200 })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 999, msg: "limited" }, 429));
    vi.stubGlobal("fetch", fetchMock);

    const limited = uploadFeishuMessageImage(env, {
      bytes: new Uint8Array([1]).buffer,
      mimeType: "image/webp",
      filename: "artifact.webp",
    });
    await expect(limited).rejects.toMatchObject({
      reason: "rate_limited",
      status: 429,
    });

    await expect(
      uploadFeishuMessageImage(env, {
        bytes: new Uint8Array([1]).buffer,
        mimeType: "video/mp4",
        filename: "video.mp4",
      })
    ).rejects.toMatchObject({ reason: "invalid_media" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("includes the Feishu API error code and message for image upload failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 7200 })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 234001, msg: "invalid image" }, 400));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadFeishuMessageImage(env, {
        bytes: new Uint8Array([1, 2, 3]).buffer,
        mimeType: "image/png",
        filename: "artifact.png",
      })
    ).rejects.toMatchObject({
      reason: "invalid_media",
      status: 400,
      message: "Feishu image upload failed (http_status=400, code=234001, msg=invalid image)",
    });
  });
});
