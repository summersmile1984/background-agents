import type { FeishuCallbackContext } from "@open-inspect/shared/types/session-api";
import type { VisualVerificationSelection } from "@open-inspect/shared/types/visual-verification";
import { buildConnectionPickerCard, buildSessionListCard, buildWorkingCard } from "../cards";
import {
  listConversationSessions,
  lookupThreadSession,
  storePendingRequest,
  storeThreadSession,
  updateThreadSession,
  type FeishuConversationCoordinates,
  type FeishuThreadSession,
} from "../conversation/store";
import { replySessionCard, replySessionText } from "../conversation/delivery";
import { resolveFeishuBotOpenId, sendFeishuCard } from "../feishu/client";
import { createLogger } from "../logger";
import {
  createSession,
  defaultHarnessForModel,
  sendPrompt,
} from "../sessions/control-plane-client";
import {
  findRepositoryTarget,
  inferRepositoryBranch,
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

function messageCoordinates(
  event: FeishuEventEnvelope,
  env: Pick<Env, "FEISHU_THREAD_REPLIES_ENABLED">
): FeishuConversationCoordinates | null {
  const message = event.event?.message;
  const tenantKey = event.header?.tenant_key;
  if (!message?.chat_id || !message.message_id || !message.chat_type || !tenantKey) return null;
  const replyMode =
    message.thread_id ||
    (message.chat_type === "group" && env.FEISHU_THREAD_REPLIES_ENABLED === "true")
      ? "thread"
      : "flat";
  return {
    tenantKey,
    chatId: message.chat_id,
    chatType: message.chat_type,
    rootMessageId: message.root_id || message.message_id,
    ...(message.thread_id ? { threadId: message.thread_id } : {}),
    replyMode,
  };
}

async function isGroupMentionForBot(event: FeishuEventEnvelope, env: Env): Promise<boolean> {
  const mentions = event.event?.message?.mentions;
  if (!mentions?.length) return false;
  const botOpenId = await resolveFeishuBotOpenId(env);
  return mentions.some((mention) => mention.id?.open_id === botOpenId);
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
export function canReuseThreadSession(existing: FeishuThreadSession): boolean {
  return existing.state !== "stale" && existing.harness === defaultHarnessForModel(existing.model);
}

async function deliverFollowUp(input: {
  env: Env;
  coordinates: FeishuConversationCoordinates;
  existing: FeishuThreadSession;
  actor: string;
  messageId: string;
  content: string;
  traceId: string;
}): Promise<boolean> {
  const existing = input.existing;
  if (!canReuseThreadSession(existing)) {
    await updateThreadSession(input.env, input.coordinates, { state: "stale" });
    await replySessionText(
      input.env,
      input.coordinates,
      "这个话题绑定的会话使用旧版或不兼容的运行配置，不能安全续办。请发送新的顶层任务创建新会话。"
    );
    return true;
  }
  if (existing.actorId !== input.actor) {
    await replySessionText(
      input.env,
      input.coordinates,
      "只有发起该会话的用户可以在此主题继续操作。"
    );
    return true;
  }
  const callbackContext: FeishuCallbackContext = {
    source: "feishu",
    tenantKey: input.coordinates.tenantKey,
    chatId: input.coordinates.chatId,
    rootMessageId: input.coordinates.rootMessageId,
    chatType: input.coordinates.chatType,
    ...(input.coordinates.threadId ? { threadId: input.coordinates.threadId } : {}),
    replyMode: input.coordinates.replyMode,
    targetLabel: existing.targetLabel,
    ...(existing.branch ? { branch: existing.branch } : {}),
    harness: existing.harness,
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
      await updateThreadSession(input.env, input.coordinates, { state: "stale" });
      await replySessionText(
        input.env,
        input.coordinates,
        "这个话题绑定的会话已经失效。请发送新的顶层任务创建新会话。"
      );
      return true;
    }
    await replySessionText(input.env, input.coordinates, "暂时无法发送后续请求，请稍后重试。");
  } else {
    await updateThreadSession(input.env, input.coordinates, {
      state: "active",
      lastMessageId: input.messageId,
    });
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
  let coordinates = messageCoordinates(payload, env);
  const openId = sender?.sender_id?.open_id;
  const messageId = message?.message_id;
  if (!coordinates || !messageId || !openId || sender?.sender_type === "app") return;
  const actor = actorId(coordinates.tenantKey, openId);
  let mentioned = false;
  if (message?.chat_type === "group") {
    if (env.FEISHU_TRIGGERS_ENABLED !== "true") return;
    try {
      mentioned = await isGroupMentionForBot(payload, env);
    } catch (error) {
      log.error("bot_identity.resolve", {
        trace_id: traceId,
        chat_id: coordinates.chatId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
  } else if (message?.chat_type !== "p2p") {
    return;
  }
  let existing: FeishuThreadSession | null;
  try {
    existing = await lookupThreadSession(env, coordinates);
  } catch (error) {
    log.error("thread_session.lookup", {
      trace_id: traceId,
      tenant_key: coordinates.tenantKey,
      chat_id: coordinates.chatId,
      chat_type: coordinates.chatType,
      root_message_id: coordinates.rootMessageId,
      reply_mode: coordinates.replyMode,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    if (message?.chat_type === "group" && !mentioned) return;
    await replySessionText(
      env,
      coordinates,
      "消息已收到，但暂时无法读取会话状态。为避免创建重复沙盒，请稍后重试。"
    ).catch(() => undefined);
    return;
  }
  if (existing && coordinates.threadId && existing.replyMode !== "thread") {
    existing =
      (await updateThreadSession(env, coordinates, {
        threadId: coordinates.threadId,
        replyMode: "thread",
      })) ?? existing;
  }
  if (message?.chat_type === "group") {
    const boundFollowUp =
      env.FEISHU_BOUND_THREAD_FOLLOWUPS_ENABLED === "true" && existing?.actorId === actor;
    if (!mentioned && !boundFollowUp) return;
  }
  if (message?.message_type !== "text") {
    await replySessionText(
      env,
      coordinates,
      "目前请先发送文字请求；图片和文件支持将在后续版本开放。"
    );
    return;
  }
  const content = parseFeishuText(message.content);
  if (!content) {
    await replySessionText(env, coordinates, "请在消息中写下要完成的开发任务。");
    return;
  }

  if (!message.root_id && isSessionListRequest(content)) {
    const sessions = await listConversationSessions(env, { ...coordinates, actorId: actor });
    await sendFeishuCard(
      env,
      coordinates.chatId,
      buildSessionListCard({ sessions, webAppUrl: env.WEB_APP_URL })
    );
    return;
  }

  try {
    const receipt = await replySessionText(
      env,
      coordinates,
      "已收到，正在工作中。需要选择仓库时，我会继续发送选择卡片。"
    );
    if (receipt?.threadId && receipt.threadId !== coordinates.threadId) {
      coordinates = { ...coordinates, threadId: receipt.threadId, replyMode: "thread" };
    }
    log.info("message.receipt_sent", {
      trace_id: traceId,
      tenant_key: coordinates.tenantKey,
      chat_id: coordinates.chatId,
      message_id: messageId,
      root_message_id: coordinates.rootMessageId,
      ...(coordinates.threadId ? { thread_id: coordinates.threadId } : {}),
      chat_type: coordinates.chatType,
      reply_mode: coordinates.replyMode,
      mapping_found: Boolean(existing),
      mention_present: mentioned,
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

  try {
    if (
      existing &&
      (await deliverFollowUp({
        env,
        coordinates,
        existing,
        actor,
        messageId,
        content,
        traceId,
      }))
    )
      return;

    const catalog = await listRepositoryCatalog(env, traceId);
    const { targets } = catalog;
    const inferred = inferRepositoryTarget(targets, content);
    if (!inferred) {
      if (targets.length === 0) {
        await replySessionText(
          env,
          coordinates,
          "当前没有可用仓库。请在 Open-Inspect 设置中检查 GitHub/Gitea connection。 "
        );
        return;
      }
      const pendingId = await storePendingRequest(env, { ...coordinates, actorId: actor, content });
      await replySessionCard(
        env,
        coordinates,
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
    await replySessionText(
      env,
      coordinates,
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
    await replySessionText(input.env, input.coordinates, "该仓库已不可用，请重新发起请求。");
    return;
  }
  const model = input.env.DEFAULT_MODEL;
  const branch = inferRepositoryBranch(target, input.content);
  const session = await createSession({
    env: input.env,
    target,
    branch,
    model,
    actorId: input.actor,
    traceId: input.traceId,
  });
  if (!session) {
    await replySessionText(input.env, input.coordinates, "无法创建会话，请稍后重试。");
    return;
  }
  const now = Date.now();
  await storeThreadSession(input.env, input.coordinates, {
    version: 2,
    sessionId: session.sessionId,
    repositoryKey: target.repositoryKey,
    targetLabel: target.fullName,
    ...(branch ? { branch } : {}),
    model,
    harness: defaultHarnessForModel(model),
    actorId: input.actor,
    chatType: input.coordinates.chatType,
    rootMessageId: input.coordinates.rootMessageId,
    ...(input.coordinates.threadId ? { threadId: input.coordinates.threadId } : {}),
    replyMode: input.coordinates.replyMode,
    state: "starting",
    createdAt: now,
    updatedAt: now,
    lastMessageId: input.coordinates.rootMessageId,
  });
  const workingMessage = await replySessionCard(
    input.env,
    input.coordinates,
    buildWorkingCard({
      targetLabel: target.fullName,
      model,
      ...(branch ? { branch } : {}),
      harness: defaultHarnessForModel(model),
      chatType: input.coordinates.chatType,
      replyMode: input.coordinates.replyMode,
      sessionId: session.sessionId,
      webAppUrl: input.env.WEB_APP_URL,
    })
  ).catch(() => undefined);
  if (workingMessage?.threadId && workingMessage.threadId !== input.coordinates.threadId) {
    input.coordinates = {
      ...input.coordinates,
      threadId: workingMessage.threadId,
      replyMode: "thread",
    };
    await updateThreadSession(input.env, input.coordinates, { threadId: workingMessage.threadId });
  }
  const callbackContext: FeishuCallbackContext = {
    source: "feishu",
    tenantKey: input.coordinates.tenantKey,
    chatId: input.coordinates.chatId,
    rootMessageId: input.coordinates.rootMessageId,
    chatType: input.coordinates.chatType,
    ...(input.coordinates.threadId ? { threadId: input.coordinates.threadId } : {}),
    replyMode: input.coordinates.replyMode,
    ...(branch ? { branch } : {}),
    harness: defaultHarnessForModel(model),
    ...(workingMessage?.messageId ? { workingMessageId: workingMessage.messageId } : {}),
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
    await updateThreadSession(input.env, input.coordinates, {
      state: delivered.reason === "stale" ? "stale" : "delivery_failed",
    });
    await replySessionText(
      input.env,
      input.coordinates,
      "会话已创建，但请求没有送达。请在 Web 会话中重试。"
    );
    return;
  }
  await updateThreadSession(input.env, input.coordinates, { state: "active" });
  log.info("session.started", {
    trace_id: input.traceId,
    session_id: session.sessionId,
    repository_key: target.repositoryKey,
    tenant_key: input.coordinates.tenantKey,
    chat_id: input.coordinates.chatId,
    chat_type: input.coordinates.chatType,
    root_message_id: input.coordinates.rootMessageId,
    ...(input.coordinates.threadId ? { thread_id: input.coordinates.threadId } : {}),
    reply_mode: input.coordinates.replyMode,
    session_state: "active",
  });
}
