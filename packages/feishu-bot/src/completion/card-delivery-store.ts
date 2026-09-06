import { deliveryIdempotencyKey } from "../conversation/delivery-id";
import type { Env } from "../types";
import type { FeishuCompletionJob } from "./job";

const CARD_DELIVERY_TTL_SECONDS = 21 * 24 * 60 * 60;

export type CompletionCardDeliveryState = "patched" | "fallback" | "ambiguous";

interface CompletionCardDeliveryRecord {
  version: 1;
  state: CompletionCardDeliveryState;
  updatedAt: number;
}

function isRecord(value: unknown): value is CompletionCardDeliveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CompletionCardDeliveryRecord>;
  return (
    candidate.version === 1 &&
    ["patched", "fallback", "ambiguous"].includes(candidate.state ?? "") &&
    typeof candidate.updatedAt === "number"
  );
}

async function deliveryIdentity(job: FeishuCompletionJob): Promise<string> {
  return deliveryIdempotencyKey(
    [job.tenantKey, job.rootMessageId, job.sessionId, job.messageId].join("|"),
    "completion-card"
  );
}

export async function completionCardDeliveryIdempotencyKey(
  job: FeishuCompletionJob
): Promise<string> {
  return deliveryIdentity(job);
}

export async function getCompletionCardDeliveryState(
  env: Pick<Env, "FEISHU_KV">,
  job: FeishuCompletionJob
): Promise<CompletionCardDeliveryState | null> {
  const key = `completion-card:${await deliveryIdentity(job)}`;
  const raw = await env.FEISHU_KV.get(key);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value.state : null;
  } catch {
    return null;
  }
}

export async function setCompletionCardDeliveryState(
  env: Pick<Env, "FEISHU_KV">,
  job: FeishuCompletionJob,
  state: CompletionCardDeliveryState
): Promise<void> {
  const key = `completion-card:${await deliveryIdentity(job)}`;
  await env.FEISHU_KV.put(
    key,
    JSON.stringify({
      version: 1,
      state,
      updatedAt: Date.now(),
    } satisfies CompletionCardDeliveryRecord),
    { expirationTtl: CARD_DELIVERY_TTL_SECONDS }
  );
}
