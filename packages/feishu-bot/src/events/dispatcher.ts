import type { FeishuCallbackContext } from "@open-inspect/shared/types/session-api";
import type { VisualVerificationSelection } from "@open-inspect/shared/types/visual-verification";
import { buildConnectionPickerCard, buildSessionListCard, buildWorkingCard } from "../cards";
import {
  clearThreadSession,
  listConversationSessions,
  lookupThreadSession,
  storePendingRequest,
  storeThreadSession,
  type FeishuConversationCoordinates,
  type FeishuThreadSession,
} from "../conversation/store";
import { replyFeishuCard, replyFeishuText, sendFeishuCard, sendFeishuText } from "../feishu/client";
import { createLogger } from "../logger";
import {
  createSession,
  defaultHarnessForModel,
  sendPrompt,
} from "../sessions/control-plane-client";
import {
  findRepositoryTarget,
  inferRepositoryTarget,
  listRepositoryCatalog,
  listRepositoryTargets,
} from "../targets";
import type { Env } from "../types";
import { parseFeishuText, type FeishuEventEnvelope } from "./payload";

const log = createLogger("event-dispatcher");

function actorId(tenantKey: string, openId: string): string {
  return `feishu:${tenantKey}:${openId}`;
}

function messageCoordinates(event: FeishuEventEnvelope): FeishuConversationCoordinates | null {
  const message = event.event?.message;
  const tenantKey = event.header?.tenant_key;
  if (!message?.chat_id || !message.message_id || !tenantKey) return null;
  return {
    tenantKey,
    chatId: message.chat_id,
    rootMessageId: message.root_id || message.message_id,
  };
}

function isGroupMentionForBot(event: FeishuEventEnvelope, botOpenId: string | undefined): boolean {
  if (!botOpenId) return false;
  return Boolean(
    event.event?.message?.mentions?.some((mention) => mention.id?.open_id === botOpenId)
  );
}

function isSessionListRequest(content: string): boolean {
  return ["会话", "会话列表", "我的会话", "sessions", "my sessions"].includes(
    content.trim().toLowerCase()
  );
}

/**
 * Keep visual verification opt-in for chat entrypoints while allowing users to
 * request it in ordinary language instead of relying on a slash command.
 */
export function visualVerificationForPrompt(
  content: string
): VisualVerificationSelection | undefined {
  const normalized = content.trim().toLowerCase();
  return normalized.includes("视觉验证") ||
    normalized.includes("截图验证") ||
    /(?:验证|verify)\s*ui\b/i.test(normalized)
    ? {}
    : undefined;
}

/**
 * A Feishu root message identifies the conversation, not a stable runtime
 * configuration. Reusing a session after the deployment model or harness has
 * changed can send a native model to the old harness. Missing `harness` means
 * the mapping predates the native-harness rollout, so starting clean is safer
 * than guessing how it was launched.
 */
export function canReuseThreadSession(existing: FeishuThreadSession, model: string): boolean {
  return existing.model === model && existing.harness === defaultHarnessForModel(model);
}

async function deliverFollowUp(input: {
  env: Env;
  coordinates: FeishuConversationCoordinates;
  actor: string;
  content: string;
  traceId: string;
}): Promise<boolean> {
  const existing = await lookupThreadSession(input.env, input.coordinates);
  if (!existing) return false;
  if (!canReuseThreadSession(existing, input.env.DEFAULT_MODEL)) {
    await clearThreadSession(input.env, input.coordinates);
    return false;
  }
  if (existing.actorId !== input.actor) {
    await sendFeishuText(
      input.env,
      input.coordinates.chatId,
      "只有发起该会话的用户可以在此主题继续操作。"
    );
    return true;
  }
  const callbackContext: FeishuCallbackContext = {
    source: "feishu",
    tenantKey: input.coordinates.tenantKey,
    chatId: input.coordinates.chatId,
    rootMessageId: input.coordinates.rootMessageId,
    targetLabel: existing.targetLabel,
    model: existing.model,
    reasoningEffort: existing.reasoningEffort,
  };
  const result = await sendPrompt({
    env: input.env,
    sessionId: existing.sessionId,
    content: input.content,
    actorId: input.actor,
    callbackContext,
    visualVerification: visualVerificationForPrompt(input.content),
    traceId: input.traceId,
  });
  if (!result.ok) {
    if (result.reason === "stale") {
      await clearThreadSession(input.env, input.coordinates);
      return false;
    }
    await sendFeishuText(input.env, input.coordinates.chatId, "暂时无法发送后续请求，请稍后重试。");
  }
  return true;
}

export async function handleFeishuEvent(
  payload: FeishuEventEnvelope,
  env: Env,
  traceId: string
): Promise<void> {
  if (payload.header?.event_type !== "im.message.receive_v1") return;
  const sender = payload.event?.sender;
  const message = payload.event?.message;
  const coordinates = messageCoordinates(payload);
  const openId = sender?.sender_id?.open_id;
  const messageId = message?.message_id;
  if (!coordinates || !messageId || !openId || sender?.sender_type === "app") return;
  if (message?.message_type !== "text") {
    await sendFeishuText(
      env,
      coordinates.chatId,
      "目前请先发送文字请求；图片和文件支持将在后续版本开放。"
    );
    return;
  }
  if (message.chat_type === "group") {
    if (
      env.FEISHU_TRIGGERS_ENABLED !== "true" ||
      !isGroupMentionForBot(payload, env.FEISHU_BOT_OPEN_ID)
    ) {
      return;
    }
  } else if (message.chat_type !== "p2p") {
    return;
  }
  const content = parseFeishuText(message.content);
  if (!content) {
    await sendFeishuText(env, coordinates.chatId, "请在消息中写下要完成的开发任务。");
    return;
  }

  try {
    await replyFeishuText(
      env,
      messageId,
      "已收到，正在工作中。需要选择仓库时，我会继续发送选择卡片。"
    );
    log.info("message.receipt_sent", {
      trace_id: traceId,
      tenant_key: coordinates.tenantKey,
      chat_id: coordinates.chatId,
      message_id: messageId,
    });
  } catch (error) {
    // A receipt improves perceived responsiveness, but its failure must not
    // prevent the actual task from being processed.
    log.warn("message.receipt_failed", {
      trace_id: traceId,
      tenant_key: coordinates.tenantKey,
      chat_id: coordinates.chatId,
      message_id: messageId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  const actor = actorId(coordinates.tenantKey, openId);
  try {
    if (!message.root_id && isSessionListRequest(content)) {
      const sessions = await listConversationSessions(env, { ...coordinates, actorId: actor });
      await sendFeishuCard(
        env,
        coordinates.chatId,
        buildSessionListCard({ sessions, webAppUrl: env.WEB_APP_URL })
      );
      return;
    }
    if (await deliverFollowUp({ env, coordinates, actor, content, traceId })) return;

    const catalog = await listRepositoryCatalog(env, traceId);
    const { targets } = catalog;
    const inferred = inferRepositoryTarget(targets, content);
    if (!inferred) {
      if (targets.length === 0) {
        await sendFeishuText(
          env,
          coordinates.chatId,
          "当前没有可用仓库。请在 Open-Inspect 设置中检查 GitHub/Gitea connection。 "
        );
        return;
      }
      const pendingId = await storePendingRequest(env, { ...coordinates, actorId: actor, content });
      await replyFeishuCard(
        env,
        coordinates.rootMessageId,
        buildConnectionPickerCard({ pendingId, connections: catalog.connections })
      );
      return;
    }
    await startNewSession({
      env,
      coordinates,
      actor,
      content,
      targetKey: inferred.repositoryKey,
      traceId,
      targets,
    });
  } catch (error) {
    log.error("message.processing_failed", {
      trace_id: traceId,
      tenant_key: coordinates.tenantKey,
      chat_id: coordinates.chatId,
      message_id: messageId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    await replyFeishuText(
      env,
      messageId,
      "消息已收到，但后续处理暂时失败。请稍后重试；如果仍失败，请检查代码源连接。"
    ).catch((replyError) => {
      log.error("message.failure_reply_failed", {
        trace_id: traceId,
        message_id: messageId,
        error: replyError instanceof Error ? replyError : new Error(String(replyError)),
      });
    });
  }
}

export async function startNewSession(input: {
  env: Env;
  coordinates: FeishuConversationCoordinates;
  actor: string;
  content: string;
  targetKey: string;
  traceId: string;
  targets?: Awaited<ReturnType<typeof listRepositoryTargets>>;
}): Promise<void> {
  const targets = input.targets ?? (await listRepositoryTargets(input.env, input.traceId));
  const target = findRepositoryTarget(targets, input.targetKey);
  if (!target) {
    await sendFeishuText(input.env, input.coordinates.chatId, "该仓库已不可用，请重新发起请求。");
    return;
  }
  const model = input.env.DEFAULT_MODEL;
  const session = await createSession({
    env: input.env,
    target,
    model,
    actorId: input.actor,
    traceId: input.traceId,
  });
  if (!session) {
    await sendFeishuText(input.env, input.coordinates.chatId, "无法创建会话，请稍后重试。");
    return;
  }
  const workingMessageId = await replyFeishuCard(
    input.env,
    input.coordinates.rootMessageId,
    buildWorkingCard({
      targetLabel: target.fullName,
      model,
      sessionId: session.sessionId,
      webAppUrl: input.env.WEB_APP_URL,
    })
  ).catch(() => undefined);
  const callbackContext: FeishuCallbackContext = {
    source: "feishu",
    tenantKey: input.coordinates.tenantKey,
    chatId: input.coordinates.chatId,
    rootMessageId: input.coordinates.rootMessageId,
    ...(workingMessageId ? { workingMessageId } : {}),
    targetLabel: target.fullName,
    model,
  };
  const delivered = await sendPrompt({
    env: input.env,
    sessionId: session.sessionId,
    content: input.content,
    actorId: input.actor,
    callbackContext,
    visualVerification: visualVerificationForPrompt(input.content),
    traceId: input.traceId,
  });
  if (!delivered.ok) {
    await sendFeishuText(
      input.env,
      input.coordinates.chatId,
      "会话已创建，但请求没有送达。请在 Web 会话中重试。"
    );
    return;
  }
  await storeThreadSession(input.env, input.coordinates, {
    sessionId: session.sessionId,
    repositoryKey: target.repositoryKey,
    targetLabel: target.fullName,
    model,
    harness: defaultHarnessForModel(model),
    actorId: input.actor,
    createdAt: Date.now(),
    lastMessageId: input.coordinates.rootMessageId,
  });
  log.info("session.started", {
    trace_id: input.traceId,
    session_id: session.sessionId,
    repository_key: target.repositoryKey,
    tenant_key: input.coordinates.tenantKey,
  });
}
