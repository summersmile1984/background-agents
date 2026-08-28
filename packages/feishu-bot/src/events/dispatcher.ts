import type { FeishuCallbackContext } from "@open-inspect/shared/types/session-api";
import type { VisualVerificationSelection } from "@open-inspect/shared/types/visual-verification";
import type { RuntimeConfigFragment } from "@open-inspect/shared/types/runtime-launch";
import { RUNTIME_COMMANDS } from "@open-inspect/shared/runtime-commands";
import {
  buildConnectionPickerCard,
  buildRuntimeHarnessPickerCard,
  buildSessionListCard,
  buildWorkingCard,
} from "../cards";
import {
  findConversationSessionByShortId,
  listConversationSessions,
  lookupThreadMessageAlias,
  lookupThreadSession,
  storeThreadMessageAlias,
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
  invokeRuntimeCommand,
  sendPrompt,
} from "../sessions/control-plane-client";
import { getRuntimeCatalog } from "../sessions/runtime-catalog";
import {
  findRepositoryTarget,
  inferRepositoryBranch,
  inferRepositoryTarget,
  listRepositoryCatalog,
  listRepositoryTargets,
} from "../targets";
import type { Env } from "../types";
import { parseSessionReference } from "../conversation/session-short-id";
import { parseFeishuMessageText, type FeishuEventEnvelope } from "./payload";

const log = createLogger("event-dispatcher");

function actorId(tenantKey: string, openId: string): string {
  return `feishu:${tenantKey}:${openId}`;
}

/**
 * Feishu retries a request with the same event ID, while the reply endpoint
 * deduplicates a UUID for one hour. Derive one valid UUID per logical delivery
 * so duplicate event deliveries and transient 429/5xx retries share identity.
 */
async function deliveryIdempotencyKey(messageId: string, kind: string): Promise<string> {
  // Feishu validates this field as a UUID. A SHA-256-derived UUID keeps the
  // value stable across duplicate event deliveries while remaining opaque.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`feishu:${messageId}:${kind}`)
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // UUID version 5 (name-derived)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function messageCoordinates(
  event: FeishuEventEnvelope,
  env: Pick<Env, "FEISHU_THREAD_REPLIES_ENABLED">
): FeishuConversationCoordinates | null {
  const message = event.event?.message;
  const tenantKey = event.header?.tenant_key;
  if (!message?.chat_id || !message.message_id || !message.chat_type || !tenantKey) return null;
  const chatType = message.chat_type === "p2p" ? "p2p" : "group";
  const replyMode =
    message.thread_id || (chatType === "group" && env.FEISHU_THREAD_REPLIES_ENABLED === "true")
      ? "thread"
      : "flat";
  return {
    tenantKey,
    chatId: message.chat_id,
    chatType,
    // Reply events normally include both IDs. Some quote/reply clients only
    // send parent_id, which still identifies the bound root for a direct
    // reply; never fall back to the new message until both are absent.
    rootMessageId: message.root_id || message.parent_id || message.message_id,
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
    normalized.includes("截图") ||
    normalized.includes("截个图") ||
    normalized.includes("截一张图") ||
    normalized.includes("截屏") ||
    normalized.includes("预览") ||
    normalized.includes("screenshot") ||
    normalized.includes("screen shot") ||
    normalized.includes("preview") ||
    normalized.includes("capture") ||
    /(?:验证|verify)\s*ui\b/i.test(normalized)
    ? {}
    : undefined;
}

/**
 * Feishu is not a Slack slash-command endpoint: a message beginning with `/`
 * arrives through the normal message event. Keep command parsing deliberately
 * narrow so ordinary prose containing a slash still reaches the harness.
 */
export function parseRuntimeCommand(content: string): string | undefined {
  const match = /^\/([a-z0-9-]+)$/i.exec(content.trim());
  return match?.[1]?.toLowerCase();
}

export { parseSessionReference } from "../conversation/session-short-id";

function runtimeCommandHelp(
  commands: readonly { slashName: string; available: boolean }[]
): string {
  const available = commands
    .filter((command) => command.available)
    .map((command) => `/${command.slashName}`);
  return available.length > 0
    ? `当前可用命令：${available.join("、")}`
    : "当前没有可用的运行时命令。";
}

function runtimeCommandResultText(input: {
  slashName: string;
  response: Awaited<ReturnType<typeof invokeRuntimeCommand>>;
  sessionId: string;
  webAppUrl: string;
}): string {
  if (!input.response.ok) {
    if (input.response.reason === "stale") {
      return "这个话题绑定的会话已经失效，请发送新的顶层任务创建新会话。";
    }
    if (input.response.error === "Unavailable in the current session state") {
      return "当前会话没有可执行此命令的运行中任务。";
    }
    return input.response.error || `命令 /${input.slashName} 暂时不可用，请稍后重试。`;
  }
  const data = input.response.data;
  if (input.slashName === "help") {
    return runtimeCommandHelp(data.commands ?? []);
  }
  if (input.slashName === "stop") return "已请求停止当前任务。";
  if (input.slashName === "review") return "代码审查任务已排队。";
  if (input.slashName === "new") {
    return "已记录。请发送新的顶层消息创建独立会话；当前话题仍绑定原仓库。";
  }
  if (input.slashName === "model" || input.slashName === "effort") {
    return `/${input.slashName} 需要在 Web 会话中操作：${input.webAppUrl.replace(/\/$/, "")}/session/${encodeURIComponent(input.sessionId)}`;
  }
  const runtime = data.runtime;
  if (input.slashName === "status" && runtime) {
    const repositories = runtime.target?.repositories ?? [];
    const target = repositories.length
      ? repositories.map((repo) => `${repo.owner}/${repo.name}@${repo.branch}`).join(", ")
      : "无仓库";
    return [
      `目标：${target}`,
      `Harness：${runtime.harness ?? "未知"}`,
      `Route：${runtime.routeId ?? "未知"}`,
      `模型：${runtime.model ?? "未知"}`,
      `Effort：${runtime.effort ?? "默认"}`,
      `会话：${runtime.sessionStatus ?? "未知"}；沙盒：${runtime.sandboxStatus ?? "未知"}`,
    ].join("\n");
  }
  return `命令 /${input.slashName} 已完成。`;
}

async function handleRuntimeCommand(input: {
  env: Env;
  coordinates: FeishuConversationCoordinates;
  existing: FeishuThreadSession | null;
  actor: string;
  messageId: string;
  slashName: string;
  traceId: string;
}): Promise<boolean> {
  const definition = RUNTIME_COMMANDS.find((command) => command.slashName === input.slashName);
  if (!definition) return false;
  if (!input.existing) {
    await replySessionText(
      input.env,
      input.coordinates,
      input.slashName === "help"
        ? "可用命令需在已绑定的话题中使用：/help、/status、/stop、/review。"
        : `当前话题还没有绑定会话，无法执行 /${input.slashName}。`
    );
    return true;
  }
  if (input.existing.actorId !== input.actor) {
    await replySessionText(
      input.env,
      input.coordinates,
      "只有发起该会话的用户可以执行运行时命令。"
    );
    return true;
  }
  const receiptIdempotencyKey = await deliveryIdempotencyKey(input.messageId, "command-receipt");
  await replySessionText(
    input.env,
    input.coordinates,
    `已收到命令 /${input.slashName}，正在处理。`,
    receiptIdempotencyKey
  );
  const response = await invokeRuntimeCommand({
    env: input.env,
    sessionId: input.existing.sessionId,
    commandId: definition.id,
    clientInvocationId: `feishu:${input.messageId}`.slice(0, 128),
    actorId: input.actor,
    traceId: input.traceId,
  });
  const resultIdempotencyKey = await deliveryIdempotencyKey(input.messageId, "command-result");
  await replySessionText(
    input.env,
    input.coordinates,
    runtimeCommandResultText({
      slashName: input.slashName,
      response,
      sessionId: input.existing.sessionId,
      webAppUrl: input.env.WEB_APP_URL,
    }),
    resultIdempotencyKey
  );
  return true;
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

function receiptTextForConversation(existing: FeishuThreadSession | null, actor: string): string {
  if (!existing) {
    return "已收到，正在工作中。需要选择仓库时，我会继续发送选择卡片。";
  }
  if (existing.actorId === actor && canReuseThreadSession(existing)) {
    return `已收到，正在继续处理 ${existing.targetLabel}。本话题沿用已绑定仓库，无需重新选择。`;
  }
  // Do not reveal the bound repository before the actor/runtime checks in
  // deliverFollowUp have accepted this request.
  return "已收到，正在检查这个话题的会话状态。";
}

async function stageRuntimeSelection(input: {
  env: Env;
  coordinates: FeishuConversationCoordinates;
  actor: string;
  content: string;
  target: Awaited<ReturnType<typeof listRepositoryTargets>>[number];
  traceId: string;
}): Promise<boolean> {
  const runtimeCatalog = await getRuntimeCatalog(input.env, input.traceId);
  if (!runtimeCatalog) return false;
  const pendingId = await storePendingRequest(input.env, {
    ...input.coordinates,
    actorId: input.actor,
    content: input.content,
    selectedRepositoryKey: input.target.repositoryKey,
    selectedConnectionId: input.target.connectionId,
  });
  await replySessionCard(
    input.env,
    input.coordinates,
    buildRuntimeHarnessPickerCard({
      pendingId,
      target: input.target,
      harnesses: runtimeCatalog.harnesses,
      commands: runtimeCatalog.commands,
    })
  );
  return true;
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
  log.info("message.received", {
    trace_id: traceId,
    message_id: messageId,
    chat_id: coordinates.chatId,
    chat_type: coordinates.chatType,
    message_type: message?.message_type || "unknown",
    root_message_id: coordinates.rootMessageId,
    ...(coordinates.threadId ? { thread_id: coordinates.threadId } : {}),
  });
  const actor = actorId(coordinates.tenantKey, openId);
  let mentioned = false;
  if (coordinates.chatType === "group") {
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
  } else if (coordinates.chatType !== "p2p") {
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
    if (coordinates.chatType === "group" && !mentioned) return;
    await replySessionText(
      env,
      coordinates,
      "消息已收到，但暂时无法读取会话状态。为避免创建重复沙盒，请稍后重试。"
    ).catch(() => undefined);
    return;
  }
  if (!existing && (message.parent_id || message.root_id)) {
    // A quoted reply can point at an outbound bot card rather than the root
    // message. Resolve that message ID back to the canonical root before
    // deciding whether this is a follow-up or a new task.
    const aliasCandidates = [message.parent_id, message.root_id].filter(
      (candidate, index, candidates): candidate is string =>
        Boolean(candidate) && candidates.indexOf(candidate) === index
    );
    for (const messageIdCandidate of aliasCandidates) {
      const alias: Awaited<ReturnType<typeof lookupThreadMessageAlias>> =
        await lookupThreadMessageAlias(
          env,
          { tenantKey: coordinates.tenantKey, chatId: coordinates.chatId },
          messageIdCandidate
        ).catch(() => null);
      if (!alias) continue;
      coordinates = {
        ...coordinates,
        rootMessageId: alias.rootMessageId,
        ...((coordinates.threadId ?? alias.threadId)
          ? { threadId: coordinates.threadId ?? alias.threadId }
          : {}),
        replyMode: alias.replyMode,
      };
      existing = await lookupThreadSession(env, coordinates);
      if (existing) break;
    }
  }
  if (existing) {
    if (coordinates.threadId && existing.replyMode !== "thread") {
      existing =
        (await updateThreadSession(env, coordinates, {
          threadId: coordinates.threadId,
          replyMode: "thread",
        })) ?? existing;
    } else if (existing.replyMode === "thread" && coordinates.replyMode !== "thread") {
      // Some Feishu clients omit thread_id on quote/reply events. Once the
      // root is known to be a native topic, preserve the stored delivery mode
      // instead of accidentally sending the follow-up to the main timeline.
      coordinates = {
        ...coordinates,
        ...(existing.threadId ? { threadId: existing.threadId } : {}),
        replyMode: "thread",
      };
    }
  }
  if (coordinates.chatType === "group") {
    const boundFollowUp =
      env.FEISHU_BOUND_THREAD_FOLLOWUPS_ENABLED === "true" && existing?.actorId === actor;
    if (!mentioned && !boundFollowUp) return;
  }
  if (message?.message_type !== "text" && message?.message_type !== "post") {
    log.warn("message.unsupported_type", {
      trace_id: traceId,
      message_id: messageId,
      chat_type: coordinates.chatType,
      message_type: message?.message_type || "unknown",
    });
    await replySessionText(
      env,
      coordinates,
      "目前请先发送文字请求；图片和文件支持将在后续版本开放。"
    );
    return;
  }
  let content = parseFeishuMessageText(message.message_type, message.content);
  if (!content) {
    log.warn("message.text_parse_failed", {
      trace_id: traceId,
      message_id: messageId,
      chat_type: coordinates.chatType,
      message_type: message.message_type,
    });
    await replySessionText(env, coordinates, "请在消息中写下要完成的开发任务。");
    return;
  }

  // Feishu private chats have no native thread picker. Allow an explicit
  // short id to route a top-level message to one of the actor's existing
  // sessions without changing the default "new top-level task" behavior.
  const explicitReference =
    !message.root_id && !message.parent_id && !message.thread_id
      ? parseSessionReference(content)
      : undefined;
  if (explicitReference && !existing) {
    const referenced = await findConversationSessionByShortId(
      env,
      { tenantKey: coordinates.tenantKey, chatId: coordinates.chatId, actorId: actor },
      explicitReference.shortId
    );
    if (!referenced?.rootMessageId) {
      await replySessionText(
        env,
        coordinates,
        `未找到会话 #${explicitReference.shortId}。请发送 /sessions 查看当前聊天的会话。`
      );
      return;
    }
    coordinates = {
      ...coordinates,
      rootMessageId: referenced.rootMessageId,
      ...(referenced.threadId ? { threadId: referenced.threadId } : {}),
      replyMode: referenced.replyMode ?? (coordinates.chatType === "group" ? "thread" : "flat"),
    };
    existing = await lookupThreadSession(env, coordinates);
    if (!existing) {
      await replySessionText(
        env,
        coordinates,
        `会话 #${explicitReference.shortId} 已不存在，请发送新的顶层任务创建会话。`
      );
      return;
    }
    content = explicitReference.prompt;
    // Keep quote replies to this explicit top-level message on the selected
    // session as well; Feishu may provide only this message as parent_id.
    await storeThreadMessageAlias(env, coordinates, messageId).catch(() => undefined);
  }

  const slashName = parseRuntimeCommand(content);
  if (
    slashName &&
    (await handleRuntimeCommand({
      env,
      coordinates,
      existing,
      actor,
      messageId,
      slashName,
      traceId,
    }))
  ) {
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
    const receiptIdempotencyKey = await deliveryIdempotencyKey(messageId, "receipt");
    const receipt = await replySessionText(
      env,
      coordinates,
      receiptTextForConversation(existing, actor),
      receiptIdempotencyKey
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
        const refreshing = catalog.connections.some(
          (connection) => connection.catalogStatus === "refreshing"
        );
        await replySessionText(
          env,
          coordinates,
          refreshing
            ? "仓库目录正在刷新，请稍后在这个话题中重新发送请求。"
            : "当前没有可用仓库。请在 Open-Inspect 设置中检查 GitHub/Gitea connection。"
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
    if (
      await stageRuntimeSelection({
        env,
        coordinates,
        actor,
        content,
        target: inferred,
        traceId,
      })
    ) {
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
  runtime?: RuntimeConfigFragment;
}): Promise<void> {
  const existing = await lookupThreadSession(input.env, input.coordinates);
  if (existing) {
    await replySessionText(
      input.env,
      input.coordinates,
      `本话题已绑定 ${existing.targetLabel}，无需重新选择仓库。请直接继续发送消息。`
    );
    return;
  }
  const targets = input.targets ?? (await listRepositoryTargets(input.env, input.traceId));
  const target = findRepositoryTarget(targets, input.targetKey);
  if (!target) {
    await replySessionText(input.env, input.coordinates, "该仓库已不可用，请重新发起请求。");
    return;
  }
  const model =
    input.runtime?.model && input.runtime.model !== "inherit"
      ? input.runtime.model
      : input.env.DEFAULT_MODEL;
  const harness = input.runtime?.harness ?? defaultHarnessForModel(model);
  const reasoningEffort =
    input.runtime?.effort && input.runtime.effort !== "inherit" ? input.runtime.effort : undefined;
  const branch = inferRepositoryBranch(target, input.content);
  const session = await createSession({
    env: input.env,
    target,
    branch,
    model,
    ...(input.runtime ? { runtime: input.runtime } : {}),
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
    harness,
    ...(reasoningEffort ? { reasoningEffort } : {}),
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
      harness,
      ...(reasoningEffort ? { reasoningEffort } : {}),
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
    harness,
    ...(workingMessage?.messageId ? { workingMessageId: workingMessage.messageId } : {}),
    targetLabel: target.fullName,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
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
