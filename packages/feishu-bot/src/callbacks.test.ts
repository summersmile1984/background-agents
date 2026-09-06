import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockVerifyCallback } = vi.hoisted(() => ({
  mockVerifyCallback: vi.fn(),
}));

vi.mock("@open-inspect/shared/auth", () => ({
  verifyCallbackFromControlPlane: mockVerifyCallback,
}));

import app from "./app";
import type { Env } from "./types";

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe("Feishu signed completion callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyCallback.mockResolvedValue(true);
  });

  it("preserves the lifecycle delivery contract across the queue boundary", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = { FEISHU_COMPLETION_QUEUE: { send } } as unknown as Env;
    const payload = {
      sessionId: "session-1",
      messageId: "message-1",
      success: true,
      timestamp: Date.now(),
      signature: "valid-signature",
      context: {
        source: "feishu",
        tenantKey: "tenant",
        chatId: "chat",
        rootMessageId: "root",
        workingMessageId: "working-card-1",
        cardLifecycle: "single-card-v2",
        targetLabel: "owner/repo",
        routeId: "codex:openai:subscription",
        model: "openai/gpt-5.6-luna",
      },
    };

    const response = await app.fetch(
      new Request("https://feishu.test/callbacks/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      executionCtx
    );

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        messageId: "message-1",
        workingMessageId: "working-card-1",
        cardLifecycle: "single-card-v2",
        routeId: "codex:openai:subscription",
      }),
      { contentType: "json" }
    );
  });
});
