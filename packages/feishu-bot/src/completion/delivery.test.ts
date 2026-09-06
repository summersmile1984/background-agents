import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractAgentResponse } from "@open-inspect/shared/completion/extractor";
import { replySessionCard, updateSessionCard } from "../conversation/delivery";
import { FeishuApiError } from "../feishu/client";
import type { Env } from "../types";
import { processFeishuCompletion } from "./delivery";
import { deliverFeishuMediaArtifacts } from "./media-upload";
import type { FeishuCompletionJob } from "./job";

vi.mock("@open-inspect/shared/completion/extractor", () => ({ extractAgentResponse: vi.fn() }));
vi.mock("../conversation/delivery", () => ({
  replySessionCard: vi.fn(),
  updateSessionCard: vi.fn(),
}));
vi.mock("../conversation/store", () => ({
  updateThreadSession: vi.fn().mockResolvedValue(null),
}));
vi.mock("./media-upload", () => ({ deliverFeishuMediaArtifacts: vi.fn() }));

class MemoryKv {
  readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
}

const completionKv = new MemoryKv();

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
  FEISHU_KV: completionKv as unknown as KVNamespace,
  CONTROL_PLANE: {
    fetch: vi.fn().mockResolvedValue(Response.json({ tunnelUrls: {} })),
  },
} as unknown as Env;

describe("Feishu completion delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completionKv.data.clear();
    vi.mocked(replySessionCard).mockResolvedValue({ messageId: "completion-1" });
    vi.mocked(updateSessionCard).mockResolvedValue({ messageId: "working-1" });
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
      chatId: job.chatId,
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

  it("rewrites loopback URLs in the agent response to the public preview", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "预览：http://127.0.0.1:4173/responsive",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [],
      success: true,
    });
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValue(
      Response.json({
        tunnelUrls: { "4173": "https://preview.example/sandbox/sandbox-1/4173/" },
      })
    );

    await processFeishuCompletion(job, env);

    const card = JSON.stringify(vi.mocked(replySessionCard).mock.calls[0]?.[2]);
    expect(card).toContain("https://preview.example/sandbox/sandbox-1/4173/responsive");
    expect(card).not.toContain("http://127.0.0.1:4173");
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

  it("keeps a pull-request action on the same topic as the completion card", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "PR created",
      toolCalls: [],
      artifacts: [
        {
          type: "pr",
          url: "https://gitea.example/huangdong/chatbi/pulls/3",
          label: "PR #3",
        },
      ],
      mediaArtifacts: [],
      success: true,
    });
    const topicJob: FeishuCompletionJob = {
      ...job,
      chatType: "group",
      threadId: "thread-pr",
      replyMode: "thread",
      branch: "codex/chatbi-pr",
      harness: "codex",
    };

    await processFeishuCompletion(topicJob, env);

    expect(replySessionCard).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        rootMessageId: "root-1",
        threadId: "thread-pr",
        replyMode: "thread",
      }),
      expect.any(Object),
      topicJob.deliveryId
    );
    expect(JSON.stringify(vi.mocked(replySessionCard).mock.calls[0]?.[2])).toContain(
      "https://gitea.example/huangdong/chatbi/pulls/3"
    );
  });

  it("patches a lifecycle card after the rollout flag has been disabled", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "Done",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [],
      success: true,
    });

    await processFeishuCompletion(
      {
        ...job,
        workingMessageId: "working-1",
        cardLifecycle: "single-card-v2",
      },
      { ...env, FEISHU_SINGLE_CARD_LAUNCH_ENABLED: "false" }
    );

    expect(updateSessionCard).toHaveBeenCalledWith(
      expect.any(Object),
      "working-1",
      expect.objectContaining({ schema: "2.0" })
    );
    expect(replySessionCard).not.toHaveBeenCalled();
  });

  it("keeps legacy reply delivery when the rollout flag is enabled", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "Done",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [],
      success: true,
    });

    const legacyJob = { ...job, workingMessageId: "legacy-working-1" };
    const enabledEnv = { ...env, FEISHU_SINGLE_CARD_LAUNCH_ENABLED: "true" };
    await processFeishuCompletion(legacyJob, enabledEnv);

    expect(updateSessionCard).not.toHaveBeenCalled();
    expect(replySessionCard).toHaveBeenCalledWith(
      enabledEnv,
      expect.any(Object),
      expect.not.objectContaining({ schema: "2.0" }),
      legacyJob.deliveryId
    );
  });

  it("falls back to one idempotent reply only for a definite uneditable target", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "Done",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [],
      success: true,
    });
    vi.mocked(updateSessionCard).mockRejectedValue(
      new FeishuApiError("not_editable", "message expired", 400)
    );
    const singleCardEnv = { ...env, FEISHU_SINGLE_CARD_LAUNCH_ENABLED: "true" };

    await processFeishuCompletion(
      {
        ...job,
        workingMessageId: "working-1",
        cardLifecycle: "single-card-v2",
      },
      singleCardEnv
    );

    expect(replySessionCard).toHaveBeenCalledOnce();
    expect(replySessionCard).toHaveBeenCalledWith(
      singleCardEnv,
      expect.any(Object),
      expect.objectContaining({ schema: "2.0" }),
      expect.any(String)
    );

    await processFeishuCompletion(
      {
        ...job,
        deliveryId: "00000000-0000-4000-8000-000000000002",
        workingMessageId: "working-1",
        cardLifecycle: "single-card-v2",
      },
      singleCardEnv
    );
    expect(updateSessionCard).toHaveBeenCalledOnce();
    expect(replySessionCard).toHaveBeenCalledOnce();
  });

  it("downgrades an invalid V2 replacement to a legacy fallback card", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "Done",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [],
      success: true,
    });
    vi.mocked(updateSessionCard).mockRejectedValue(
      new FeishuApiError("invalid_card", "replacement card rejected", 400)
    );

    await processFeishuCompletion(
      {
        ...job,
        workingMessageId: "working-invalid-v2",
        cardLifecycle: "single-card-v2",
      },
      env
    );

    expect(replySessionCard).toHaveBeenCalledWith(
      env,
      expect.any(Object),
      expect.not.objectContaining({ schema: "2.0" }),
      expect.any(String)
    );
  });

  it("never creates a fallback message for an ambiguous patch outcome", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "Done",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [],
      success: true,
    });
    vi.mocked(updateSessionCard).mockRejectedValue(
      new FeishuApiError("ambiguous", "update outcome unknown")
    );

    await expect(
      processFeishuCompletion(
        {
          ...job,
          workingMessageId: "working-1",
          cardLifecycle: "single-card-v2",
        },
        { ...env, FEISHU_SINGLE_CARD_LAUNCH_ENABLED: "true" }
      )
    ).rejects.toMatchObject({ reason: "ambiguous" });

    expect(replySessionCard).not.toHaveBeenCalled();
  });

  it("deduplicates a replay after the completion card was patched", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "Done",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [],
      success: true,
    });
    const singleCardEnv = { ...env, FEISHU_SINGLE_CARD_LAUNCH_ENABLED: "true" };
    const singleCardJob = {
      ...job,
      workingMessageId: "working-1",
      cardLifecycle: "single-card-v2" as const,
    };

    await processFeishuCompletion(singleCardJob, singleCardEnv);
    await processFeishuCompletion(
      { ...singleCardJob, deliveryId: "00000000-0000-4000-8000-000000000002" },
      singleCardEnv
    );

    expect(updateSessionCard).toHaveBeenCalledOnce();
    expect(replySessionCard).not.toHaveBeenCalled();
  });
});
