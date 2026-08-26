import { extractAgentResponse } from "@open-inspect/shared/completion/extractor";
import { resolveOutboundCredential } from "@open-inspect/shared/service-auth";
import { buildCompletionCard } from "../cards";
import { replyFeishuCard } from "../feishu/client";
import { createLogger } from "../logger";
import type { Env } from "../types";
import type { FeishuCompletionJob } from "./job";
import { deliverFeishuMediaArtifacts } from "./media-upload";

const log = createLogger("completion-delivery");

function pullRequestUrl(
  artifacts: Awaited<ReturnType<typeof extractAgentResponse>>["artifacts"]
): string | undefined {
  for (const artifact of artifacts) {
    if (artifact.type === "pr" && artifact.url) return artifact.url;
  }
  return undefined;
}

export async function processFeishuCompletion(job: FeishuCompletionJob, env: Env): Promise<void> {
  try {
    const response = await extractAgentResponse(
      {
        fetcher: env.CONTROL_PLANE,
        auth: resolveOutboundCredential("feishu-bot", env),
        log,
      },
      job.sessionId,
      job.messageId,
      job.traceId
    );
    await replyFeishuCard(
      env,
      job.rootMessageId,
      buildCompletionCard({
        sessionId: job.sessionId,
        targetLabel: job.targetLabel,
        textContent: response.textContent,
        success: job.success && response.success,
        error: response.error || job.error,
        webAppUrl: env.WEB_APP_URL,
        pullRequestUrl: pullRequestUrl(response.artifacts),
        visualVerification: response.visualVerification,
      })
    );
    if (env.FEISHU_MEDIA_DELIVERY_ENABLED === "true" && response.mediaArtifacts.length > 0) {
      await deliverFeishuMediaArtifacts({
        env,
        deliveryId: job.deliveryId,
        tenantKey: job.tenantKey,
        sessionId: job.sessionId,
        messageId: job.messageId,
        rootMessageId: job.rootMessageId,
        artifacts: response.mediaArtifacts,
        traceId: job.traceId,
      });
    }
    log.info("completion.delivered", {
      delivery_id: job.deliveryId,
      session_id: job.sessionId,
      message_id: job.messageId,
      outcome: "success",
    });
  } catch (error) {
    log.error("completion.delivery", {
      delivery_id: job.deliveryId,
      session_id: job.sessionId,
      message_id: job.messageId,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
