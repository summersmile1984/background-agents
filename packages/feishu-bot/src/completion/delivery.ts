import { extractAgentResponse } from "@open-inspect/shared/completion/extractor";
import { resolveOutboundCredential } from "@open-inspect/shared/service-auth";
import { buildCompletionCard } from "../cards";
import { replyFeishuCard } from "../feishu/client";
import { signedControlPlaneFetch } from "../internal-auth";
import { createLogger } from "../logger";
import type { Env } from "../types";
import type { FeishuCompletionJob } from "./job";
import { deliverFeishuMediaArtifacts } from "./media-upload";

const log = createLogger("completion-delivery");
const TUNNEL_URL_FETCH_TIMEOUT_MS = 5_000;

function selectPreviewUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const tunnelUrls = (value as { tunnelUrls?: unknown }).tunnelUrls;
  if (!tunnelUrls || typeof tunnelUrls !== "object" || Array.isArray(tunnelUrls)) return undefined;

  const entries = Object.entries(tunnelUrls).sort(([left], [right]) => {
    if (left === "4173") return -1;
    if (right === "4173") return 1;
    return Number(left) - Number(right);
  });
  for (const [, candidate] of entries) {
    if (typeof candidate !== "string") continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && !url.username && !url.password) return url.href;
    } catch {
      // Ignore malformed provider output and keep looking for a safe URL.
    }
  }
  return undefined;
}

async function fetchPreviewUrl(
  env: Env,
  sessionId: string,
  traceId: string | undefined
): Promise<string | undefined> {
  try {
    const response = await signedControlPlaneFetch(
      env,
      {
        method: "GET",
        url: `https://internal/sessions/${encodeURIComponent(sessionId)}/tunnel-urls`,
        traceId,
      },
      { signal: AbortSignal.timeout(TUNNEL_URL_FETCH_TIMEOUT_MS) }
    );
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return selectPreviewUrl(await response.json());
  } catch {
    return undefined;
  }
}

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
    const previewUrl = await fetchPreviewUrl(env, job.sessionId, job.traceId);
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
        previewUrl,
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
