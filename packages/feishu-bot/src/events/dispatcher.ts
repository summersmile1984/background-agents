import type { FeishuCallbackContext } from "@open-inspect/shared/types/session-api";
import { buildRepositoryPickerCard, buildWorkingCard } from "../cards";
import {
  lookupThreadSession,
  storePendingRequest,
  storeThreadSession,
  type FeishuConversationCoordinates,
} from "../conversation/store";
import { sendFeishuCard, sendFeishuText } from "../feishu/client";
import { createLogger } from "../logger";
import { createSession, sendPrompt } from "../sessions/control-plane-client";
import { findRepositoryTarget, inferRepositoryTarget, listRepositoryTargets } from "../targets";
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

async function deliverFollowUp(input: {
  env: Env;
  coordinates: FeishuConversationCoordinates;
  actor: string;
  content: string;
  traceId: string;
}): Promise<boolean> {
  const existing = await lookupThreadSession(input.env, input.coordinates);
  if (!existing) return false;
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
    traceId: input.traceId,
  });
  if (!result.ok) {
    await sendFeishuText(
      input.env,
      input.coordinates.chatId,
      result.reason === "stale"
        ? "该会话已不可继续，请新建会话。"
        : "暂时无法发送后续请求，请稍后重试。"
    );
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
  if (!coordinates || !openId || sender?.sender_type === "app") return;
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
  const actor = actorId(coordinates.tenantKey, openId);
  if (await deliverFollowUp({ env, coordinates, actor, content, traceId })) return;

  const targets = await listRepositoryTargets(env, traceId);
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
    await sendFeishuCard(
      env,
      coordinates.chatId,
      buildRepositoryPickerCard({ pendingId, repositories: targets })
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
  const workingMessageId = await sendFeishuCard(
    input.env,
    input.coordinates.chatId,
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
