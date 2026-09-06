import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockProcessFeishuCompletion } = vi.hoisted(() => ({
  mockProcessFeishuCompletion: vi.fn(),
}));

vi.mock("./delivery", () => ({
  processFeishuCompletion: mockProcessFeishuCompletion,
}));

import { consumeFeishuCompletions } from "./consumer";
import type { Env } from "../types";

const job = {
  version: 1,
  deliveryId: "00000000-0000-4000-8000-000000000001",
  sessionId: "session-1",
  messageId: "message-1",
  success: true,
  tenantKey: "tenant",
  chatId: "chat",
  rootMessageId: "root",
  targetLabel: "owner/repo",
  model: "openai/gpt-5.6-luna",
};

function batch(body: unknown) {
  const ack = vi.fn();
  return {
    ack,
    value: {
      messages: [{ id: "queue-1", body, attempts: 1, ack }],
    } as unknown as MessageBatch<unknown>,
  };
}

describe("Feishu completion queue consumer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("acks a completion only after persistent delivery succeeds", async () => {
    mockProcessFeishuCompletion.mockResolvedValue(undefined);
    const messageBatch = batch(job);

    await consumeFeishuCompletions(messageBatch.value, {} as Env);

    expect(mockProcessFeishuCompletion).toHaveBeenCalledOnce();
    expect(messageBatch.ack).toHaveBeenCalledOnce();
  });

  it("leaves a transient delivery failure unacked so the queue retries it", async () => {
    mockProcessFeishuCompletion.mockRejectedValue(new Error("ambiguous update"));
    const messageBatch = batch(job);

    await expect(consumeFeishuCompletions(messageBatch.value, {} as Env)).rejects.toThrow(
      "ambiguous update"
    );
    expect(messageBatch.ack).not.toHaveBeenCalled();
  });

  it("acks an invalid job that can never succeed on retry", async () => {
    const messageBatch = batch({ invalid: true });

    await consumeFeishuCompletions(messageBatch.value, {} as Env);

    expect(mockProcessFeishuCompletion).not.toHaveBeenCalled();
    expect(messageBatch.ack).toHaveBeenCalledOnce();
  });
});
