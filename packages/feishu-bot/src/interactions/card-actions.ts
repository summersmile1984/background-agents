import { z } from "zod";
import { buildRepositoryPickerCard, REPOSITORIES_PER_PAGE } from "../cards";
import {
  claimThreadSelection,
  claimCardActionOnce,
  deletePendingRequest,
  getPendingRequest,
  lookupThreadSession,
  releaseThreadSelection,
} from "../conversation/store";
import { replySessionCard, replySessionText } from "../conversation/delivery";
import { startNewSession } from "../events/dispatcher";
import { createLogger } from "../logger";
import { findRepositoryTarget, listRepositoryCatalog } from "../targets";
import type { Env } from "../types";

const log = createLogger("card-actions");

const cardActionValueSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("select_connection"),
    pendingId: z.string().uuid(),
    // New button cards carry the selection in value. Keep this optional so
    // already-sent select_static cards using action.option remain valid.
    connectionId: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("select_target"),
    pendingId: z.string().uuid(),
    connectionId: z.string().min(1),
    repositoryKey: z.string().min(1).optional(),
    page: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("repository_page"),
    pendingId: z.string().uuid(),
    connectionId: z.string().min(1),
    page: z.number().int().nonnegative(),
  }),
]);

const cardActionFieldsSchema = z.object({
  context: z.object({ open_chat_id: z.string().min(1).optional() }).optional(),
  open_chat_id: z.string().min(1).optional(),
  operator: z
    .object({
      // Legacy card callbacks put the Open ID directly on `operator`.
      open_id: z.string().min(1).optional(),
      // Event subscription 2.0 callbacks nest it below `operator_id`.
      operator_id: z.object({ open_id: z.string().min(1).optional() }).optional(),
    })
    .optional(),
  action: z
    .object({
      value: cardActionValueSchema.optional(),
      option: z.string().min(1).optional(),
    })
    .optional(),
});

const cardActionSchema = cardActionFieldsSchema.extend({
  header: z
    .object({
      event_id: z.string().min(1).optional(),
      tenant_key: z.string().min(1).optional(),
    })
    .optional(),
  // Feishu event subscription 2.0 wraps action fields in `event`, whereas
  // the legacy card callback format keeps them at the top level.
  event: cardActionFieldsSchema.optional(),
});

function actorId(tenantKey: string, openId: string): string {
  return `feishu:${tenantKey}:${openId}`;
}

export function parseFeishuCardAction(payload: unknown): {
  value: z.infer<typeof cardActionValueSchema>;
  targetKey?: string;
  tenantKey: string;
  chatId: string;
  openId: string;
  actionId: string;
} | null {
  const parsed = cardActionSchema.safeParse(payload);
  if (!parsed.success) return null;
  const actionPayload = parsed.data.event ?? parsed.data;
  const value = actionPayload.action?.value;
  const targetKey =
    actionPayload.action?.option ??
    (value?.action === "select_connection"
      ? value.connectionId
      : value?.action === "select_target"
        ? value.repositoryKey
        : undefined);
  const tenantKey = parsed.data.header?.tenant_key;
  const chatId = actionPayload.context?.open_chat_id ?? actionPayload.open_chat_id;
  const openId = actionPayload.operator?.open_id ?? actionPayload.operator?.operator_id?.open_id;
  const actionId = parsed.data.header?.event_id;
  if (!value || !tenantKey || !chatId || !openId || !actionId) return null;
  return { value, targetKey, tenantKey, chatId, openId, actionId };
}

/**
 * Resolve a repository picker action.  The callback's selected option is
 * never trusted alone: the opaque pending record fixes the actor, chat and
 * topic; startNewSession re-reads the current repository catalog before it
 * creates a session.
 */
export async function handleFeishuCardAction(
  payload: unknown,
  env: Env,
  traceId: string
): Promise<{ ok: true; content?: string } | { ok: false; content: string }> {
  const action = parseFeishuCardAction(payload);
  if (!action) {
    return { ok: false, content: "请求无效，请重新发起。" };
  }
  const { value, targetKey, tenantKey, chatId, openId, actionId } = action;
  if (!(await claimCardActionOnce(env, actionId))) return { ok: true, content: "该操作已处理。" };
  const pending = await getPendingRequest(env, value.pendingId);
  const actor = actorId(tenantKey, openId);
  if (
    !pending ||
    pending.actorId !== actor ||
    pending.tenantKey !== tenantKey ||
    pending.chatId !== chatId
  ) {
    return { ok: false, content: "该选择已过期或无权操作，请重新发起请求。" };
  }
  const coordinates = {
    tenantKey: pending.tenantKey,
    chatId: pending.chatId,
    chatType: pending.chatType,
    rootMessageId: pending.rootMessageId,
    ...(pending.threadId ? { threadId: pending.threadId } : {}),
    replyMode: pending.replyMode,
  };
  try {
    const existing = await lookupThreadSession(env, coordinates);
    if (existing) {
      await deletePendingRequest(env, value.pendingId);
      log.info("card_action.thread_already_bound", {
        trace_id: traceId,
        pending_id: value.pendingId,
        session_id: existing.sessionId,
        repository_key: existing.repositoryKey,
        root_message_id: existing.rootMessageId,
        ...(existing.threadId ? { thread_id: existing.threadId } : {}),
      });
      await replySessionText(
        env,
        coordinates,
        `本话题已绑定 ${existing.targetLabel}，无需重新选择仓库。请直接在本话题继续发送消息。`
      );
      return { ok: false, content: "本话题已绑定仓库，无需重新选择。" };
    }
    const catalog = await listRepositoryCatalog(env, traceId);
    const { targets } = catalog;
    if (value.action === "select_connection" || value.action === "repository_page") {
      const connectionId = value.action === "select_connection" ? targetKey : value.connectionId;
      if (!connectionId) return { ok: false, content: "代码源无效，请重新发起请求。" };
      const connection = catalog.connections.find((candidate) => candidate.id === connectionId);
      if (!connection) return { ok: false, content: "代码源已不可用，请重新发起请求。" };
      if (connection.catalogStatus === "refreshing") {
        await replySessionText(
          env,
          pending,
          `${connection.label} 的仓库目录仍在刷新，请稍候几秒后重新选择。`
        );
        return { ok: false, content: "目录仍在刷新。" };
      }
      const repositories = targets.filter((target) => target.connectionId === connection.id);
      const page = value.action === "repository_page" ? value.page : 0;
      const pageCount = Math.max(1, Math.ceil(repositories.length / REPOSITORIES_PER_PAGE));
      if (page >= pageCount) return { ok: false, content: "该页已不存在，请重新选择代码源。" };
      await replySessionCard(
        env,
        pending,
        buildRepositoryPickerCard({
          pendingId: value.pendingId,
          connection,
          repositories,
          page,
        })
      );
      return { ok: true, content: "请选择仓库。" };
    }
    if (!targetKey) return { ok: false, content: "仓库无效，请重新选择。" };
    const selected = findRepositoryTarget(targets, targetKey);
    if (!selected || selected.connectionId !== value.connectionId) {
      return { ok: false, content: "仓库已不可用，请重新选择。" };
    }
    if (!(await claimThreadSelection(env, coordinates, actionId))) {
      await replySessionText(env, coordinates, "本话题正在创建会话，请勿重复选择仓库。");
      return { ok: false, content: "本话题正在创建会话。" };
    }
    try {
      // Re-check after taking the topic claim so a completed earlier action
      // cannot be overwritten by this stale card.
      const boundAfterClaim = await lookupThreadSession(env, coordinates);
      if (boundAfterClaim) {
        await deletePendingRequest(env, value.pendingId);
        await replySessionText(
          env,
          coordinates,
          `本话题已绑定 ${boundAfterClaim.targetLabel}，无需重新选择仓库。`
        );
        return { ok: false, content: "本话题已绑定仓库。" };
      }
      await startNewSession({
        env,
        coordinates,
        actor,
        content: pending.content,
        targetKey: selected.repositoryKey,
        traceId,
        targets,
      });
    } finally {
      await releaseThreadSelection(env, coordinates, actionId);
    }
    await deletePendingRequest(env, value.pendingId);
    return { ok: true, content: "已开始创建会话。" };
  } catch (error) {
    log.error("card.select_target", {
      trace_id: traceId,
      pending_id: value.pendingId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    if (pending) {
      await replySessionText(env, pending, "暂时无法创建会话，请稍后重试。").catch(() => undefined);
    }
    return { ok: false, content: "创建会话失败。" };
  }
}

/** Acknowledgement card response shape used by the Feishu card callback API. */
export function cardActionResponse(result: {
  ok: boolean;
  content?: string;
}): Record<string, unknown> {
  return {
    toast: {
      type: result.ok ? "success" : "error",
      content: result.content || (result.ok ? "已处理" : "操作失败"),
    },
  };
}
