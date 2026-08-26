import type { MediaArtifactInfo } from "@open-inspect/shared/types/artifacts";
import {
  FeishuApiError,
  replyFeishuImage,
  replyFeishuText,
  uploadFeishuMessageImage,
} from "../feishu/client";
import { signedControlPlaneFetch } from "../internal-auth";
import { createLogger } from "../logger";
import type { Env } from "../types";

export const FEISHU_MEDIA_MAX_FILES_PER_COMPLETION = 3;
export const FEISHU_MEDIA_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const FEISHU_MEDIA_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const MEDIA_FETCH_TIMEOUT_MS = 30_000;
const DELIVERY_RECORD_TTL_SECONDS = 21 * 24 * 60 * 60;
const DELIVERY_LEASE_TTL_SECONDS = 60;

const log = createLogger("completion-media");

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

type ArtifactDeliveryState = "selected" | "uploaded" | "replied" | "failed" | "omitted";

interface ArtifactDeliveryRecord {
  state: ArtifactDeliveryState;
  replyMessageId?: string;
  reason?: string;
}

export interface FeishuMediaDeliveryRecord {
  version: 1;
  deliveryId: string;
  artifacts: Record<string, ArtifactDeliveryRecord>;
  warningState?: "sent" | "ambiguous";
  warningMessageId?: string;
  updatedAt: number;
  expiresAt: number;
}

export interface FeishuMediaDeliveryResult {
  replied: number;
  failed: number;
  omitted: number;
  suppressed: number;
}

interface DeliverMediaArtifactsInput {
  env: Env;
  deliveryId: string;
  tenantKey: string;
  sessionId: string;
  messageId: string;
  rootMessageId: string;
  artifacts: MediaArtifactInfo[];
  traceId?: string;
}

function isRecord(value: unknown): value is FeishuMediaDeliveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<FeishuMediaDeliveryRecord>;
  return (
    candidate.version === 1 &&
    typeof candidate.deliveryId === "string" &&
    Boolean(candidate.artifacts) &&
    typeof candidate.artifacts === "object" &&
    !Array.isArray(candidate.artifacts) &&
    typeof candidate.updatedAt === "number" &&
    typeof candidate.expiresAt === "number"
  );
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function feishuMediaDeliveryKey(
  input: Pick<DeliverMediaArtifactsInput, "tenantKey" | "rootMessageId" | "sessionId" | "messageId">
): Promise<string> {
  const digest = await sha256Hex(
    [input.tenantKey, input.rootMessageId, input.sessionId, input.messageId].join("|")
  );
  return `feishu:completion-media:v1:${digest}`;
}

async function loadRecord(
  env: Pick<Env, "FEISHU_KV">,
  key: string,
  deliveryId: string
): Promise<FeishuMediaDeliveryRecord> {
  const raw = await env.FEISHU_KV.get(key);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      log.warn("feishu.media.idempotency", { outcome: "invalid_record" });
    }
  }
  const now = Date.now();
  return {
    version: 1,
    deliveryId,
    artifacts: {},
    updatedAt: now,
    expiresAt: now + DELIVERY_RECORD_TTL_SECONDS * 1000,
  };
}

async function saveRecord(
  env: Pick<Env, "FEISHU_KV">,
  key: string,
  record: FeishuMediaDeliveryRecord
): Promise<void> {
  record.updatedAt = Date.now();
  await env.FEISHU_KV.put(key, JSON.stringify(record), {
    expirationTtl: DELIVERY_RECORD_TTL_SECONDS,
  });
}

async function cancelBody(body: ReadableStream | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // The response may already have been consumed or cancelled by the runtime.
  }
}

function orderedUniqueArtifacts(artifacts: MediaArtifactInfo[]): MediaArtifactInfo[] {
  const unique = [...new Map(artifacts.map((artifact) => [artifact.id, artifact])).values()];
  return [
    ...unique.filter((artifact) => artifact.type === "screenshot"),
    ...unique.filter((artifact) => artifact.type === "video"),
  ];
}

async function recordOutcome(
  input: DeliverMediaArtifactsInput,
  key: string,
  record: FeishuMediaDeliveryRecord,
  artifactId: string,
  outcome: ArtifactDeliveryRecord
): Promise<void> {
  record.artifacts[artifactId] = outcome;
  await saveRecord(input.env, key, record);
}

async function fetchArtifact(
  input: DeliverMediaArtifactsInput,
  artifact: MediaArtifactInfo,
  attemptedBytes: number
): Promise<
  | { kind: "ready"; bytes: ArrayBuffer; mimeType: string; extension: string; sizeBytes: number }
  | { kind: "failed"; reason: string; sizeBytes?: number }
  | { kind: "omitted"; reason: string; sizeBytes?: number }
> {
  const mediaUrl = `https://internal/sessions/${encodeURIComponent(input.sessionId)}/media/${encodeURIComponent(artifact.id)}`;
  let response: Response;
  try {
    response = await signedControlPlaneFetch(
      input.env,
      { method: "GET", url: mediaUrl, traceId: input.traceId },
      { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) }
    );
  } catch {
    return { kind: "failed", reason: "fetch_error" };
  }

  if (!response.ok || !response.body) {
    await cancelBody(response.body);
    return {
      kind: "failed",
      reason: response.status === 404 ? "not_found" : `fetch_http_${response.status}`,
    };
  }

  const mimeType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim() ?? "";
  const extension = EXTENSIONS[mimeType];
  const sizeBytes = Number(response.headers.get("Content-Length"));
  if (!extension || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    await cancelBody(response.body);
    return { kind: "failed", reason: "invalid_media_headers" };
  }
  if (
    sizeBytes > FEISHU_MEDIA_MAX_IMAGE_BYTES ||
    attemptedBytes + sizeBytes > FEISHU_MEDIA_MAX_TOTAL_BYTES
  ) {
    await cancelBody(response.body);
    return { kind: "omitted", reason: "size_limit", sizeBytes };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    return { kind: "failed", reason: "body_read_failed", sizeBytes };
  }
  if (bytes.byteLength !== sizeBytes) {
    return { kind: "failed", reason: "content_length_mismatch", sizeBytes };
  }
  return { kind: "ready", bytes, mimeType, extension, sizeBytes };
}

async function sendAggregateWarning(
  input: DeliverMediaArtifactsInput,
  key: string,
  record: FeishuMediaDeliveryRecord,
  result: FeishuMediaDeliveryResult
): Promise<void> {
  if (result.failed === 0 && result.omitted === 0) return;
  if (record.warningState === "sent" || record.warningState === "ambiguous") return;

  const parts: string[] = [];
  if (result.failed > 0) parts.push(`${result.failed} 个媒体发送失败`);
  if (result.omitted > 0) parts.push(`${result.omitted} 个媒体因格式或大小限制未发送`);
  const text = `${parts.join("，")}。完整媒体仍保留在 Open-Inspect Web 会话中。`;
  try {
    const warningMessageId = await replyFeishuText(input.env, input.rootMessageId, text);
    record.warningState = "sent";
    if (warningMessageId) record.warningMessageId = warningMessageId;
  } catch (error) {
    if (error instanceof FeishuApiError && error.reason === "ambiguous") {
      record.warningState = "ambiguous";
    }
    log.warn("feishu.media.warning", {
      trace_id: input.traceId,
      session_id: input.sessionId,
      message_id: input.messageId,
      outcome: "error",
      reason: error instanceof FeishuApiError ? error.reason : "unknown",
    });
  }
  await saveRecord(input.env, key, record);
}

export async function deliverFeishuMediaArtifacts(
  input: DeliverMediaArtifactsInput
): Promise<FeishuMediaDeliveryResult> {
  const startedAt = Date.now();
  const ordered = orderedUniqueArtifacts(input.artifacts);
  const selected = ordered.slice(0, FEISHU_MEDIA_MAX_FILES_PER_COMPLETION);
  const key = await feishuMediaDeliveryKey(input);
  const leaseKey = `${key}:lease`;
  const result: FeishuMediaDeliveryResult = {
    replied: 0,
    failed: 0,
    omitted: ordered.length - selected.length,
    suppressed: 0,
  };

  const existingLease = await input.env.FEISHU_KV.get(leaseKey);
  if (existingLease) {
    result.suppressed = selected.length;
    log.info("feishu.media.delivery", {
      outcome: "duplicate_in_flight",
      delivery_id: input.deliveryId,
    });
    return result;
  }
  await input.env.FEISHU_KV.put(leaseKey, input.deliveryId, {
    expirationTtl: DELIVERY_LEASE_TTL_SECONDS,
  });

  const record = await loadRecord(input.env, key, input.deliveryId);
  let attemptedBytes = 0;
  try {
    for (const artifact of ordered.slice(FEISHU_MEDIA_MAX_FILES_PER_COMPLETION)) {
      if (!record.artifacts[artifact.id]) {
        await recordOutcome(input, key, record, artifact.id, {
          state: "omitted",
          reason: "file_count_limit",
        });
      }
    }

    for (const artifact of selected) {
      const prior = record.artifacts[artifact.id];
      if (prior?.state === "replied" || prior?.state === "uploaded") {
        result.suppressed += 1;
        continue;
      }
      if (prior?.state === "omitted") {
        result.omitted += 1;
        continue;
      }
      if (artifact.type !== "screenshot") {
        result.omitted += 1;
        await recordOutcome(input, key, record, artifact.id, {
          state: "omitted",
          reason: "video_delivery_disabled",
        });
        continue;
      }
      if (
        artifact.sizeBytes !== undefined &&
        (artifact.sizeBytes > FEISHU_MEDIA_MAX_IMAGE_BYTES ||
          attemptedBytes + artifact.sizeBytes > FEISHU_MEDIA_MAX_TOTAL_BYTES)
      ) {
        result.omitted += 1;
        await recordOutcome(input, key, record, artifact.id, {
          state: "omitted",
          reason: "size_limit",
        });
        continue;
      }

      await recordOutcome(input, key, record, artifact.id, { state: "selected" });
      const fetched = await fetchArtifact(input, artifact, attemptedBytes);
      if (fetched.sizeBytes !== undefined) attemptedBytes += fetched.sizeBytes;
      if (fetched.kind === "omitted") {
        result.omitted += 1;
        await recordOutcome(input, key, record, artifact.id, {
          state: "omitted",
          reason: fetched.reason,
        });
        continue;
      }
      if (fetched.kind === "failed") {
        result.failed += 1;
        await recordOutcome(input, key, record, artifact.id, {
          state: "failed",
          reason: fetched.reason,
        });
        log.warn("feishu.media.fetch", {
          trace_id: input.traceId,
          session_id: input.sessionId,
          message_id: input.messageId,
          artifact_id: artifact.id,
          outcome: "error",
          reason: fetched.reason,
        });
        continue;
      }

      let imageKey: string;
      try {
        const uploaded = await uploadFeishuMessageImage(input.env, {
          bytes: fetched.bytes,
          mimeType: fetched.mimeType,
          filename: `artifact-${artifact.id}.${fetched.extension}`,
        });
        imageKey = uploaded.imageKey;
        await recordOutcome(input, key, record, artifact.id, { state: "uploaded" });
        log.info("feishu.media.upload", {
          trace_id: input.traceId,
          artifact_id: artifact.id,
          mime_type: fetched.mimeType,
          size_bytes: fetched.sizeBytes,
          outcome: "success",
        });
      } catch (error) {
        result.failed += 1;
        const reason = error instanceof FeishuApiError ? error.reason : "unknown";
        await recordOutcome(input, key, record, artifact.id, { state: "failed", reason });
        log.warn("feishu.media.upload", {
          trace_id: input.traceId,
          artifact_id: artifact.id,
          outcome: "error",
          reason,
        });
        continue;
      }

      try {
        const replyMessageId = await replyFeishuImage(input.env, input.rootMessageId, imageKey);
        result.replied += 1;
        await recordOutcome(input, key, record, artifact.id, {
          state: "replied",
          ...(replyMessageId ? { replyMessageId } : {}),
        });
        log.info("feishu.media.reply", {
          trace_id: input.traceId,
          artifact_id: artifact.id,
          outcome: "success",
        });
      } catch (error) {
        result.failed += 1;
        const reason = error instanceof FeishuApiError ? error.reason : "unknown";
        // Keep `uploaded` so a replay never blindly creates a duplicate reply after an
        // ambiguous outbound outcome. The image key intentionally is not persisted.
        await recordOutcome(input, key, record, artifact.id, { state: "uploaded", reason });
        log.warn("feishu.media.reply", {
          trace_id: input.traceId,
          artifact_id: artifact.id,
          outcome: "error",
          reason,
        });
      }
    }

    await sendAggregateWarning(input, key, record, result);
    log.info("feishu.media.delivery", {
      trace_id: input.traceId,
      delivery_id: input.deliveryId,
      session_id: input.sessionId,
      message_id: input.messageId,
      outcome: "complete",
      replied: result.replied,
      failed: result.failed,
      omitted: result.omitted,
      suppressed: result.suppressed,
      attempted_bytes: attemptedBytes,
      duration_ms: Date.now() - startedAt,
    });
    return result;
  } finally {
    const leaseOwner = await input.env.FEISHU_KV.get(leaseKey).catch(() => null);
    if (leaseOwner === input.deliveryId) await input.env.FEISHU_KV.delete(leaseKey);
  }
}
