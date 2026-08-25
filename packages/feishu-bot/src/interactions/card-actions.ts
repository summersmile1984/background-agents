import { z } from "zod";
import { buildRepositoryPickerCard, REPOSITORIES_PER_PAGE } from "../cards";
import {
  claimCardActionOnce,
  deletePendingRequest,
  getPendingRequest,
} from "../conversation/store";
import { replyFeishuCard, sendFeishuText } from "../feishu/client";
import { startNewSession } from "../events/dispatcher";
import { createLogger } from "../logger";
import { findRepositoryConnection, findRepositoryTarget, listRepositoryTargets } from "../targets";
import type { Env } from "../types";

const log = createLogger("card-actions");

const cardActionValueSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("select_connection"), pendingId: z.string().uuid() }),
  z.object({
    action: z.literal("select_target"),
    pendingId: z.string().uuid(),
    connectionId: z.string().min(1),
    page: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("repository_page"),
    pendingId: z.string().uuid(),
    connectionId: z.string().min(1),
    page: z.number().int().nonnegative(),
  }),
]);

const cardActionSchema = z.object({
  header: z
    .object({
      event_id: z.string().min(1).optional(),
      tenant_key: z.string().min(1).optional(),
    })
    .optional(),
  context: z.object({ open_chat_id: z.string().min(1).optional() }).optional(),
  open_chat_id: z.string().min(1).optional(),
  operator: z.object({ open_id: z.string().min(1).optional() }).optional(),
  action: z
    .object({
      value: cardActionValueSchema.optional(),
      option: z.string().min(1).optional(),
    })
    .optional(),
});

function actorId(tenantKey: string, openId: string): string {
  return `feishu:${tenantKey}:${openId}`;
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
  const parsed = cardActionSchema.safeParse(payload);
  const value = parsed.data?.action?.value;
  const targetKey = parsed.data?.action?.option;
  const tenantKey = parsed.data?.header?.tenant_key;
  const chatId = parsed.data?.context?.open_chat_id ?? parsed.data?.open_chat_id;
  const openId = parsed.data?.operator?.open_id;
  const actionId = parsed.data?.header?.event_id;
  if (!parsed.success || !value || !tenantKey || !chatId || !openId || !actionId) {
    return { ok: false, content: "请求无效，请重新发起。" };
  }
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
  try {
    const targets = await listRepositoryTargets(env, traceId);
    if (value.action === "select_connection" || value.action === "repository_page") {
      const connectionId = value.action === "select_connection" ? targetKey : value.connectionId;
      if (!connectionId) return { ok: false, content: "代码源无效，请重新发起请求。" };
      const connection = findRepositoryConnection(targets, connectionId);
      if (!connection) return { ok: false, content: "代码源已不可用，请重新发起请求。" };
      const repositories = targets.filter((target) => target.connectionId === connection.id);
      const page = value.action === "repository_page" ? value.page : 0;
      const pageCount = Math.max(1, Math.ceil(repositories.length / REPOSITORIES_PER_PAGE));
      if (page >= pageCount) return { ok: false, content: "该页已不存在，请重新选择代码源。" };
      await replyFeishuCard(
        env,
        pending.rootMessageId,
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
    await startNewSession({
      env,
      coordinates: {
        tenantKey: pending.tenantKey,
        chatId: pending.chatId,
        rootMessageId: pending.rootMessageId,
      },
      actor,
      content: pending.content,
      targetKey: selected.repositoryKey,
      traceId,
      targets,
    });
    await deletePendingRequest(env, value.pendingId);
    return { ok: true, content: "已开始创建会话。" };
  } catch (error) {
    log.error("card.select_target", {
      trace_id: traceId,
      pending_id: value.pendingId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    await sendFeishuText(env, chatId, "暂时无法创建会话，请稍后重试。").catch(() => undefined);
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
