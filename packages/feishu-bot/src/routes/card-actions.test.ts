import { describe, expect, it } from "vitest";
import app from "../app";
import type { Env } from "../types";

const env = {
  FEISHU_VERIFICATION_TOKEN: "test-token",
} as Env;

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe("POST /card-actions", () => {
  it("returns Feishu's verified URL-validation challenge", async () => {
    const response = await app.fetch(
      new Request("https://feishu.test/card-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "url_verification", token: "test-token", challenge: "c-123" }),
      }),
      env,
      executionCtx
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ challenge: "c-123" });
  });

  it("does not expose a challenge for an unverified callback request", async () => {
    const response = await app.fetch(
      new Request("https://feishu.test/card-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "url_verification", token: "bad", challenge: "c-123" }),
      }),
      env,
      executionCtx
    );

    expect(response.status).toBe(401);
  });

  it("acknowledges a valid Event Subscription 2.0 action before background work", async () => {
    const background: Promise<unknown>[] = [];
    const response = await app.fetch(
      new Request("https://feishu.test/card-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          header: {
            token: "test-token",
            event_id: "evt-card-action",
            tenant_key: "tenant-card-action",
          },
          event: {
            context: { open_chat_id: "oc_card_action" },
            operator: { operator_id: { open_id: "ou_card_action" } },
            action: {
              value: {
                action: "select_connection",
                pendingId: "1cd968ae-f012-4a12-898e-f320808f1af7",
              },
              option: "scm-gitea",
            },
          },
        }),
      }),
      env,
      {
        ...executionCtx,
        waitUntil(promise: Promise<unknown>) {
          background.push(promise);
        },
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      toast: { type: "success", content: "正在处理，请稍候。" },
    });
    expect(background).toHaveLength(1);
  });
});
