import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { agentHarnessSchema, type AgentHarness } from "@open-inspect/shared/types/agent-harness";
import {
  runtimeConfigFragmentSchema,
  type RuntimeConfigFragment,
} from "@open-inspect/shared/types/runtime-launch";
import { z } from "zod";
import type { Env } from "../types";

const THREAD_TTL_SECONDS = 7 * 24 * 60 * 60;
const PENDING_TTL_SECONDS = 60 * 60;
const THREAD_SELECTION_TTL_SECONDS = 10 * 60;
const SESSION_INDEX_LIMIT = 30;

export interface FeishuConversationCoordinates {
  tenantKey: string;
  chatId: string;
  chatType: "p2p" | "group";
  rootMessageId: string;
  threadId?: string;
  replyMode: "thread" | "flat";
}

export interface FeishuThreadSession {
  version: 2;
  sessionId: string;
  repositoryKey: string;
  targetLabel: string;
  branch?: string;
  model: string;
  harness: AgentHarness | "inherit";
  reasoningEffort?: string;
  actorId: string;
  chatType: "p2p" | "group";
  rootMessageId: string;
  threadId?: string;
  replyMode: "thread" | "flat";
  state: "starting" | "active" | "delivery_failed" | "completed" | "failed" | "stale";
  createdAt: number;
  updatedAt: number;
  lastMessageId?: string;
}

export interface FeishuConversationSessionSummary {
  sessionId: string;
  repositoryKey?: string;
  targetLabel: string;
  branch?: string;
  model: string;
  harness?: AgentHarness | "inherit";
  reasoningEffort?: string;
  state?: FeishuThreadSession["state"];
  rootMessageId?: string;
  threadId?: string;
  replyMode?: "thread" | "flat";
  createdAt: number;
}

export interface FeishuPendingRequest extends FeishuConversationCoordinates {
  actorId: string;
  content: string;
  /** Repository/runtime selections are staged here until the final launch action. */
  selectedRepositoryKey?: string;
  selectedConnectionId?: string;
  runtime?: RuntimeConfigFragment;
  createdAt: number;
}

const legacyThreadSessionSchema = z.object({
  sessionId: z.string().min(1),
  repositoryKey: z.string().min(1),
  targetLabel: z.string().min(1),
  model: z.string().min(1),
  harness: z.union([agentHarnessSchema, z.literal("inherit")]).optional(),
  reasoningEffort: z.string().min(1).optional(),
  actorId: z.string().min(1),
  createdAt: z.number().finite().nonnegative(),
  lastMessageId: z.string().min(1).optional(),
});

const threadSessionSchema: z.ZodType<FeishuThreadSession> = z.object({
  version: z.literal(2),
  sessionId: z.string().min(1),
  repositoryKey: z.string().min(1),
  targetLabel: z.string().min(1),
  branch: z.string().min(1).optional(),
  model: z.string().min(1),
  harness: z.union([agentHarnessSchema, z.literal("inherit")]),
  reasoningEffort: z.string().min(1).optional(),
  actorId: z.string().min(1),
  chatType: z.enum(["p2p", "group"]),
  rootMessageId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  replyMode: z.enum(["thread", "flat"]),
  state: z.enum(["starting", "active", "delivery_failed", "completed", "failed", "stale"]),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  lastMessageId: z.string().min(1).optional(),
});

const pendingRequestSchema: z.ZodType<FeishuPendingRequest> = z.object({
  tenantKey: z.string().min(1),
  chatId: z.string().min(1),
  chatType: z.enum(["p2p", "group"]),
  rootMessageId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  replyMode: z.enum(["thread", "flat"]),
  actorId: z.string().min(1),
  content: z.string().trim().min(1),
  selectedRepositoryKey: z.string().min(1).optional(),
  selectedConnectionId: z.string().min(1).optional(),
  runtime: runtimeConfigFragmentSchema.optional(),
  createdAt: z.number().finite().nonnegative(),
});

const conversationSessionSummarySchema: z.ZodType<FeishuConversationSessionSummary> = z.object({
  sessionId: z.string().min(1),
  repositoryKey: z.string().min(1).optional(),
  targetLabel: z.string().min(1),
  branch: z.string().min(1).optional(),
  model: z.string().min(1),
  harness: z.union([agentHarnessSchema, z.literal("inherit")]).optional(),
  reasoningEffort: z.string().min(1).optional(),
  state: z
    .enum(["starting", "active", "delivery_failed", "completed", "failed", "stale"])
    .optional(),
  rootMessageId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  replyMode: z.enum(["thread", "flat"]).optional(),
  createdAt: z.number().finite().nonnegative(),
});

const conversationSessionIndexSchema = z.array(conversationSessionSummarySchema);

function threadKey(coordinates: FeishuConversationCoordinates): string {
  return `thread:${coordinates.tenantKey}:${coordinates.chatId}:${coordinates.rootMessageId}`;
}

function pendingKey(pendingId: string): string {
  return `pending:${pendingId}`;
}

function threadSelectionKey(coordinates: FeishuConversationCoordinates): string {
  return `thread-selection:${coordinates.tenantKey}:${coordinates.chatId}:${coordinates.rootMessageId}`;
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
  if (parsed.success) return parsed.data;
  const legacy = legacyThreadSessionSchema.safeParse(value);
  if (!legacy.success) return null;
  return {
    version: 2,
    ...legacy.data,
    harness: legacy.data.harness ?? "inherit",
    chatType: coordinates.chatType,
    rootMessageId: coordinates.rootMessageId,
    replyMode: "flat",
    state: legacy.data.harness ? "active" : "stale",
    updatedAt: legacy.data.createdAt,
  };
}

export async function storeThreadSession(
  env: Pick<Env, "FEISHU_KV">,
  coordinates: FeishuConversationCoordinates,
  session: FeishuThreadSession
): Promise<void> {
  const store = createKvCacheStore(env.FEISHU_KV);
  const normalized = threadSessionSchema.parse({
    ...session,
    chatType: coordinates.chatType,
    rootMessageId: coordinates.rootMessageId,
    threadId: coordinates.threadId ?? session.threadId,
    replyMode: coordinates.replyMode,
  });
  await store.put(threadKey(coordinates), JSON.stringify(normalized), {
    expirationTtl: THREAD_TTL_SECONDS,
  });
  const key = sessionIndexKey({ ...coordinates, actorId: normalized.actorId });
  const previous = conversationSessionIndexSchema.safeParse(await store.get(key, "json"));
  const index = previous.success ? previous.data : [];
  const summary: FeishuConversationSessionSummary = {
    sessionId: normalized.sessionId,
    repositoryKey: normalized.repositoryKey,
    targetLabel: normalized.targetLabel,
    ...(normalized.branch ? { branch: normalized.branch } : {}),
    model: normalized.model,
    harness: normalized.harness,
    ...(normalized.reasoningEffort ? { reasoningEffort: normalized.reasoningEffort } : {}),
    state: normalized.state,
    rootMessageId: normalized.rootMessageId,
    ...(normalized.threadId ? { threadId: normalized.threadId } : {}),
    replyMode: normalized.replyMode,
    createdAt: normalized.createdAt,
  };
  const next = [summary, ...index.filter((item) => item.sessionId !== summary.sessionId)].slice(
    0,
    SESSION_INDEX_LIMIT
  );
  await store.put(key, JSON.stringify(next), { expirationTtl: THREAD_TTL_SECONDS });
}

export async function updateThreadSession(
  env: Pick<Env, "FEISHU_KV">,
  coordinates: FeishuConversationCoordinates,
  patch: Partial<
    Pick<
      FeishuThreadSession,
      "state" | "lastMessageId" | "threadId" | "replyMode" | "reasoningEffort" | "branch"
    >
  >
): Promise<FeishuThreadSession | null> {
  const current = await lookupThreadSession(env, coordinates);
  if (!current) return null;
  const next: FeishuThreadSession = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };
  await storeThreadSession(
    env,
    {
      ...coordinates,
      threadId: patch.threadId ?? coordinates.threadId ?? current.threadId,
      replyMode: patch.replyMode ?? current.replyMode,
    },
    next
  );
  return next;
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

/**
 * Best-effort guard against two repository buttons starting sessions for the
 * same topic before the first session mapping has been persisted.
 */
export async function claimThreadSelection(
  env: Pick<Env, "FEISHU_KV">,
  coordinates: FeishuConversationCoordinates,
  claimId: string
): Promise<boolean> {
  const store = createKvCacheStore(env.FEISHU_KV);
  const key = threadSelectionKey(coordinates);
  if (await store.get(key)) return false;
  await store.put(key, claimId, { expirationTtl: THREAD_SELECTION_TTL_SECONDS });
  return true;
}

export async function releaseThreadSelection(
  env: Pick<Env, "FEISHU_KV">,
  coordinates: FeishuConversationCoordinates,
  claimId: string
): Promise<void> {
  const store = createKvCacheStore(env.FEISHU_KV);
  const key = threadSelectionKey(coordinates);
  if ((await store.get(key)) === claimId) await store.delete(key);
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
  if (parsed.success) return parsed.data;
  const legacy = z
    .object({
      tenantKey: z.string().min(1),
      chatId: z.string().min(1),
      rootMessageId: z.string().min(1),
      actorId: z.string().min(1),
      content: z.string().trim().min(1),
      createdAt: z.number().finite().nonnegative(),
    })
    .safeParse(value);
  return legacy.success ? { ...legacy.data, chatType: "p2p", replyMode: "flat" } : null;
}

export async function updatePendingRequest(
  env: Pick<Env, "FEISHU_KV">,
  pendingId: string,
  patch: Partial<
    Pick<FeishuPendingRequest, "selectedRepositoryKey" | "selectedConnectionId" | "runtime">
  >
): Promise<FeishuPendingRequest | null> {
  const current = await getPendingRequest(env, pendingId);
  if (!current) return null;
  const next = pendingRequestSchema.parse({ ...current, ...patch });
  await createKvCacheStore(env.FEISHU_KV).put(pendingKey(pendingId), JSON.stringify(next), {
    expirationTtl: PENDING_TTL_SECONDS,
  });
  return next;
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
