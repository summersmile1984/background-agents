import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { z } from "zod";
import type { Env } from "../types";

const THREAD_TTL_SECONDS = 7 * 24 * 60 * 60;
const PENDING_TTL_SECONDS = 60 * 60;
const SESSION_INDEX_LIMIT = 30;

export interface FeishuConversationCoordinates {
  tenantKey: string;
  chatId: string;
  rootMessageId: string;
}

export interface FeishuThreadSession {
  sessionId: string;
  repositoryKey: string;
  targetLabel: string;
  model: string;
  reasoningEffort?: string;
  actorId: string;
  createdAt: number;
  lastMessageId?: string;
}

export interface FeishuConversationSessionSummary {
  sessionId: string;
  targetLabel: string;
  model: string;
  createdAt: number;
}

export interface FeishuPendingRequest extends FeishuConversationCoordinates {
  actorId: string;
  content: string;
  createdAt: number;
}

const threadSessionSchema: z.ZodType<FeishuThreadSession> = z.object({
  sessionId: z.string().min(1),
  repositoryKey: z.string().min(1),
  targetLabel: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  actorId: z.string().min(1),
  createdAt: z.number().finite().nonnegative(),
  lastMessageId: z.string().min(1).optional(),
});

const pendingRequestSchema: z.ZodType<FeishuPendingRequest> = z.object({
  tenantKey: z.string().min(1),
  chatId: z.string().min(1),
  rootMessageId: z.string().min(1),
  actorId: z.string().min(1),
  content: z.string().trim().min(1),
  createdAt: z.number().finite().nonnegative(),
});

const conversationSessionSummarySchema: z.ZodType<FeishuConversationSessionSummary> = z.object({
  sessionId: z.string().min(1),
  targetLabel: z.string().min(1),
  model: z.string().min(1),
  createdAt: z.number().finite().nonnegative(),
});

const conversationSessionIndexSchema = z.array(conversationSessionSummarySchema);

function threadKey(coordinates: FeishuConversationCoordinates): string {
  return `thread:${coordinates.tenantKey}:${coordinates.chatId}:${coordinates.rootMessageId}`;
}

function pendingKey(pendingId: string): string {
  return `pending:${pendingId}`;
}

function sessionIndexKey(
  input: Pick<FeishuConversationCoordinates, "tenantKey" | "chatId"> & {
    actorId: string;
  }
): string {
  return `session-index:${input.tenantKey}:${input.chatId}:${input.actorId}`;
}

export async function lookupThreadSession(
  env: Pick<Env, "FEISHU_KV">,
  coordinates: FeishuConversationCoordinates
): Promise<FeishuThreadSession | null> {
  const value = await createKvCacheStore(env.FEISHU_KV).get(threadKey(coordinates), "json");
  const parsed = threadSessionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function storeThreadSession(
  env: Pick<Env, "FEISHU_KV">,
  coordinates: FeishuConversationCoordinates,
  session: FeishuThreadSession
): Promise<void> {
  const store = createKvCacheStore(env.FEISHU_KV);
  await store.put(threadKey(coordinates), JSON.stringify(session), {
    expirationTtl: THREAD_TTL_SECONDS,
  });
  const key = sessionIndexKey({ ...coordinates, actorId: session.actorId });
  const previous = conversationSessionIndexSchema.safeParse(await store.get(key, "json"));
  const index = previous.success ? previous.data : [];
  const summary: FeishuConversationSessionSummary = {
    sessionId: session.sessionId,
    targetLabel: session.targetLabel,
    model: session.model,
    createdAt: session.createdAt,
  };
  const next = [summary, ...index.filter((item) => item.sessionId !== summary.sessionId)].slice(
    0,
    SESSION_INDEX_LIMIT
  );
  await store.put(key, JSON.stringify(next), { expirationTtl: THREAD_TTL_SECONDS });
}

export async function listConversationSessions(
  env: Pick<Env, "FEISHU_KV">,
  input: Pick<FeishuConversationCoordinates, "tenantKey" | "chatId"> & { actorId: string }
): Promise<FeishuConversationSessionSummary[]> {
  const value = await createKvCacheStore(env.FEISHU_KV).get(sessionIndexKey(input), "json");
  const parsed = conversationSessionIndexSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export async function clearThreadSession(
  env: Pick<Env, "FEISHU_KV">,
  coordinates: FeishuConversationCoordinates
): Promise<void> {
  await createKvCacheStore(env.FEISHU_KV).delete(threadKey(coordinates));
}

export async function storePendingRequest(
  env: Pick<Env, "FEISHU_KV">,
  input: Omit<FeishuPendingRequest, "createdAt">
): Promise<string> {
  const pendingId = crypto.randomUUID();
  const record: FeishuPendingRequest = { ...input, createdAt: Date.now() };
  await createKvCacheStore(env.FEISHU_KV).put(
    pendingKey(pendingId),
    JSON.stringify(pendingRequestSchema.parse(record)),
    { expirationTtl: PENDING_TTL_SECONDS }
  );
  return pendingId;
}

export async function getPendingRequest(
  env: Pick<Env, "FEISHU_KV">,
  pendingId: string
): Promise<FeishuPendingRequest | null> {
  const value = await createKvCacheStore(env.FEISHU_KV).get(pendingKey(pendingId), "json");
  const parsed = pendingRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function deletePendingRequest(
  env: Pick<Env, "FEISHU_KV">,
  pendingId: string
): Promise<void> {
  await createKvCacheStore(env.FEISHU_KV).delete(pendingKey(pendingId));
}

export async function claimEventOnce(
  env: Pick<Env, "FEISHU_KV">,
  eventId: string
): Promise<boolean> {
  const store = createKvCacheStore(env.FEISHU_KV);
  const key = `event:${eventId}`;
  if (await store.get(key)) return false;
  await store.put(key, "1", { expirationTtl: 24 * 60 * 60 });
  return true;
}

export async function claimCardActionOnce(
  env: Pick<Env, "FEISHU_KV">,
  actionId: string
): Promise<boolean> {
  const store = createKvCacheStore(env.FEISHU_KV);
  const key = `card-action:${actionId}`;
  if (await store.get(key)) return false;
  await store.put(key, "1", { expirationTtl: 60 * 60 });
  return true;
}
