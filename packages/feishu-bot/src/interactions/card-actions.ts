import { z } from "zod";
import {
  claimCardActionOnce,
  deletePendingRequest,
  getPendingRequest,
} from "../conversation/store";
import { sendFeishuText } from "../feishu/client";
import { startNewSession } from "../events/dispatcher";
import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger("card-actions");

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
      value: z
        .object({ action: z.literal("select_target"), pendingId: z.string().uuid() })
        .optional(),
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
  if (!parsed.success || !value || !targetKey || !tenantKey || !chatId || !openId || !actionId) {
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
    await startNewSession({
      env,
      coordinates: {
        tenantKey: pending.tenantKey,
        chatId: pending.chatId,
        rootMessageId: pending.rootMessageId,
      },
      actor,
      content: pending.content,
      targetKey,
      traceId,
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
