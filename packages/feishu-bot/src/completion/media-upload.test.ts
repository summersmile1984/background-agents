import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import {
  FEISHU_MEDIA_MAX_IMAGE_BYTES,
  deliverFeishuMediaArtifacts,
  feishuMediaDeliveryKey,
} from "./media-upload";
import { clearTenantAccessTokenCache } from "../feishu/client";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  } as unknown as KVNamespace;
}

function createEnv(controlPlaneFetch: ReturnType<typeof vi.fn>): Env {
  return {
    FEISHU_KV: memoryKv(),
    CONTROL_PLANE: { fetch: controlPlaneFetch },
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "secret",
    FEISHU_VERIFICATION_TOKEN: "verify",
    SERVICE_AUTH_SECRET: "service-secret-at-least-32-characters",
  } as unknown as Env;
}

const baseInput = {
  deliveryId: "00000000-0000-4000-8000-000000000001",
  tenantKey: "tenant-1",
  chatId: "chat-1",
  sessionId: "session-1",
  messageId: "message-1",
  rootMessageId: "root-1",
};

describe("Feishu media completion delivery", () => {
  beforeEach(() => {
    clearTenantAccessTokenCache();
    vi.restoreAllMocks();
  });

  it("fetches protected media, uploads it, replies in-topic, and suppresses a replay", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const controlPlaneFetch = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "image/png", "Content-Length": String(bytes.byteLength) },
        })
    );
    const env = createEnv(controlPlaneFetch);
    const feishuFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 7200 })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { image_key: "image-key" } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: "reply-1" } }));
    vi.stubGlobal("fetch", feishuFetch);

    const input = {
      ...baseInput,
      env,
      artifacts: [
        {
          id: "artifact-1",
          type: "screenshot" as const,
          mimeType: "image/png",
          sizeBytes: bytes.byteLength,
          caption: "Dashboard",
        },
      ],
    };
    await expect(deliverFeishuMediaArtifacts(input)).resolves.toEqual({
      replied: 1,
      failed: 0,
      omitted: 0,
      suppressed: 0,
    });
    expect(controlPlaneFetch).toHaveBeenCalledTimes(1);
    expect(feishuFetch).toHaveBeenCalledTimes(3);

    await expect(deliverFeishuMediaArtifacts(input)).resolves.toEqual({
      replied: 0,
      failed: 0,
      omitted: 0,
      suppressed: 1,
    });
    expect(controlPlaneFetch).toHaveBeenCalledTimes(1);
    expect(feishuFetch).toHaveBeenCalledTimes(3);

    const key = await feishuMediaDeliveryKey(baseInput);
    const stored = JSON.parse(String(await env.FEISHU_KV.get(key)));
    expect(stored.artifacts["artifact-1"]).toEqual({
      state: "replied",
      replyMessageId: "reply-1",
    });
    expect(JSON.stringify(stored)).not.toContain("image-key");
  });

  it("omits a known oversized artifact without fetching it and sends one warning", async () => {
    const controlPlaneFetch = vi.fn();
    const env = createEnv(controlPlaneFetch);
    const feishuFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, tenant_access_token: "tenant-token", expire: 7200 })
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { message_id: "warning-1" } }));
    vi.stubGlobal("fetch", feishuFetch);

    await expect(
      deliverFeishuMediaArtifacts({
        ...baseInput,
        env,
        artifacts: [
          {
            id: "artifact-large",
            type: "screenshot",
            sizeBytes: FEISHU_MEDIA_MAX_IMAGE_BYTES + 1,
          },
        ],
      })
    ).resolves.toEqual({ replied: 0, failed: 0, omitted: 1, suppressed: 0 });

    expect(controlPlaneFetch).not.toHaveBeenCalled();
    expect(feishuFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(feishuFetch.mock.calls[1][1]?.body))).toMatchObject({
      msg_type: "text",
    });
  });
});
