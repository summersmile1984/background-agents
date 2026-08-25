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

describe("POST /events", () => {
  it("returns Feishu's challenge only after verification-token validation", async () => {
    const response = await app.fetch(
      new Request("https://feishu.test/events", {
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

  it("does not expose a challenge for an unverified request", async () => {
    const response = await app.fetch(
      new Request("https://feishu.test/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "url_verification", token: "bad", challenge: "c-123" }),
      }),
      env,
      executionCtx
    );

    expect(response.status).toBe(401);
  });
});
