import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractAgentResponse } from "@open-inspect/shared/completion/extractor";
import { replySessionCard } from "../conversation/delivery";
import type { Env } from "../types";
import { processFeishuCompletion } from "./delivery";
import { deliverFeishuMediaArtifacts } from "./media-upload";
import type { FeishuCompletionJob } from "./job";

vi.mock("@open-inspect/shared/completion/extractor", () => ({ extractAgentResponse: vi.fn() }));
vi.mock("../conversation/delivery", () => ({ replySessionCard: vi.fn() }));
vi.mock("../conversation/store", () => ({
  updateThreadSession: vi.fn().mockResolvedValue(null),
}));
vi.mock("./media-upload", () => ({ deliverFeishuMediaArtifacts: vi.fn() }));

const job: FeishuCompletionJob = {
  version: 1,
  deliveryId: "00000000-0000-4000-8000-000000000001",
  sessionId: "session-1",
  messageId: "message-1",
  success: true,
  tenantKey: "tenant-1",
  chatId: "chat-1",
  rootMessageId: "root-1",
  targetLabel: "github · owner/repo",
  model: "openai/gpt-5.6-luna",
  traceId: "trace-1",
};

const env = {
  FEISHU_MEDIA_DELIVERY_ENABLED: "true",
  WEB_APP_URL: "https://open-inspect.example",
  SERVICE_AUTH_SECRET: "service-secret-at-least-32-characters",
  CONTROL_PLANE: {
    fetch: vi.fn().mockResolvedValue(Response.json({ tunnelUrls: {} })),
  },
} as unknown as Env;

describe("Feishu completion delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(replySessionCard).mockResolvedValue({ messageId: "completion-1" });
    vi.mocked(deliverFeishuMediaArtifacts).mockResolvedValue({
      replied: 1,
      failed: 0,
      omitted: 0,
      suppressed: 0,
    });
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValue(Response.json({ tunnelUrls: {} }));
  });

  it("posts the completion card before delivering prompt-scoped media", async () => {
    const screenshot = {
      id: "artifact-1",
      type: "screenshot" as const,
      mimeType: "image/png",
      sizeBytes: 4,
    };
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "Done",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [screenshot],
      success: true,
    });

    await processFeishuCompletion(job, env);

    expect(replySessionCard).toHaveBeenCalledOnce();
    expect(deliverFeishuMediaArtifacts).toHaveBeenCalledWith({
      env,
      deliveryId: job.deliveryId,
      tenantKey: job.tenantKey,
      sessionId: job.sessionId,
      messageId: job.messageId,
      rootMessageId: job.rootMessageId,
      chatType: "p2p",
      replyMode: "flat",
      artifacts: [screenshot],
      traceId: job.traceId,
    });
    expect(vi.mocked(replySessionCard).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deliverFeishuMediaArtifacts).mock.invocationCallOrder[0]
    );
  });

  it("keeps existing behavior when media delivery is disabled", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "Done",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [{ id: "artifact-1", type: "screenshot" }],
      success: true,
    });

    await processFeishuCompletion(job, {
      ...env,
      FEISHU_MEDIA_DELIVERY_ENABLED: "false",
    });

    expect(replySessionCard).toHaveBeenCalledOnce();
    expect(deliverFeishuMediaArtifacts).not.toHaveBeenCalled();
  });

  it("adds the preferred sandbox preview URL to the completion card", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "Done",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [],
      success: true,
    });
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValue(
      Response.json({
        tunnelUrls: {
          "3000": "https://3000-sandbox.example/",
          "4173": "https://4173-sandbox.example/",
        },
      })
    );

    await processFeishuCompletion(job, env);

    expect(JSON.stringify(vi.mocked(replySessionCard).mock.calls[0]?.[2])).toContain(
      "https://4173-sandbox.example/"
    );
  });

  it("keeps completion cards and media inside the stored native topic", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "Done in topic",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [{ id: "artifact-topic", type: "screenshot" }],
      success: true,
    });
    const topicJob: FeishuCompletionJob = {
      ...job,
      chatType: "group",
      threadId: "thread-1",
      replyMode: "thread",
      branch: "codex/topic-a",
      harness: "codex",
      reasoningEffort: "high",
    };

    await processFeishuCompletion(topicJob, env);

    expect(replySessionCard).toHaveBeenCalledWith(
      env,
      {
        tenantKey: "tenant-1",
        chatId: "chat-1",
        chatType: "group",
        rootMessageId: "root-1",
        threadId: "thread-1",
        replyMode: "thread",
      },
      expect.any(Object),
      topicJob.deliveryId
    );
    expect(deliverFeishuMediaArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        rootMessageId: "root-1",
        chatType: "group",
        threadId: "thread-1",
        replyMode: "thread",
      })
    );
    const card = JSON.stringify(vi.mocked(replySessionCard).mock.calls[0]?.[2]);
    expect(card).toContain("codex/topic-a");
    expect(card).toContain("codex");
    expect(card).toContain("high");
  });
});
