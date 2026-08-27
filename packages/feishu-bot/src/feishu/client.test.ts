import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import {
  clearTenantAccessTokenCache,
  replyFeishuImage,
  replyFeishuText,
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

    await expect(replyFeishuText(env, "om/message", "已收到，正在处理。")).resolves.toBe("reply-1");
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

    await expect(replyFeishuImage(env, "root/message", "img-key")).resolves.toBe("reply-1");

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
      message:
        "Feishu image upload failed (http_status=400, code=234001, msg=invalid image)",
    });
  });
});
