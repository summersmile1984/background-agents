import type { FeishuCallbackContext } from "@open-inspect/shared/types/session-api";
import type {
  ResolveRuntimeLaunchDraftResponse,
  RuntimeLaunchTarget,
} from "@open-inspect/shared/types/runtime-launch";
import { z } from "zod";
import {
  buildLaunchLifecycleCard,
  buildTurnCompletionCard,
  buildTurnWorkingCard,
  LAUNCH_CONNECTIONS_PER_PAGE,
  LAUNCH_ENVIRONMENTS_PER_PAGE,
  LAUNCH_REPOSITORIES_PER_PAGE,
  type LaunchCardCatalog,
} from "../launch-cards";
import { deliveryIdempotencyKey } from "../conversation/delivery-id";
import { replySessionCard, replySessionText, updateSessionCard } from "../conversation/delivery";
import {
  createLaunchPending,
  getLaunchPending,
  snapshotRuntimeDraft,
  updateLaunchPending,
  type FeishuLaunchIntent,
  type FeishuLaunchPending,
} from "../conversation/launch-store";
import {
  claimCardActionOnce,
  claimThreadSelection,
  listConversationSessions,
  lookupThreadSession,
  releaseThreadSelection,
  storeThreadSession,
  updateThreadSession,
  type FeishuConversationCoordinates,
  type FeishuThreadSession,
} from "../conversation/store";
import { createLogger } from "../logger";
import { createResolvedSession, sendPrompt } from "../sessions/control-plane-client";
import { resolveFeishuRuntimeDraft } from "../sessions/runtime-draft";
import {
  findRepositoryTarget,
  inferRepositoryBranch,
  inferRepositoryTarget,
  listEnvironmentTargets,
  listRepositoryCatalog,
  type FeishuRepositoryCatalog,
} from "../targets";
import type { Env } from "../types";
import { visualVerificationForPrompt } from "../events/visual-verification";

const log = createLogger("launch-card-actions");

const launchActionValueSchema = z.object({
  schemaVersion: z.literal(2),
  action: z.enum([
    "open_workspace",
    "select_connection",
    "connection_page",
    "set_target",
    "toggle_multi_mode",
    "toggle_repository",
    "repository_page",
    "environment_page",
    "open_runtime",
    "set_runtime_field",
    "set_runtime_setting",
    "apply_runtime_settings",
    "runtime_model_page",
    "reset_runtime",
    "apply_editor",
    "cancel_editor",
    "retry_resolve",
    "start_session",
  ]),
  pendingId: z.string().uuid(),
  selectionRevision: z.number().int().nonnegative(),
  argument: z.string().max(512).optional(),
  field: z.string().max(128).optional(),
});

const actionFieldsSchema = z.object({
  context: z
    .object({
      open_chat_id: z.string().min(1).optional(),
      open_message_id: z.string().min(1).optional(),
    })
    .optional(),
  open_chat_id: z.string().min(1).optional(),
  operator: z
    .object({
      open_id: z.string().min(1).optional(),
      operator_id: z.object({ open_id: z.string().min(1).optional() }).optional(),
    })
    .optional(),
  action: z
    .object({
      value: launchActionValueSchema.optional(),
      form_value: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

const launchActionEnvelopeSchema = actionFieldsSchema.extend({
  header: z
    .object({
      event_id: z.string().min(1).optional(),
      tenant_key: z.string().min(1).optional(),
    })
    .optional(),
  event: actionFieldsSchema.optional(),
});

export interface ParsedFeishuLaunchCardAction {
  value: z.infer<typeof launchActionValueSchema>;
  formValue?: Record<string, unknown>;
  tenantKey: string;
  chatId: string;
  messageId: string;
  openId: string;
  actionId: string;
}

export function parseFeishuLaunchCardAction(payload: unknown): ParsedFeishuLaunchCardAction | null {
  const parsed = launchActionEnvelopeSchema.safeParse(payload);
  if (!parsed.success) return null;
  const fields = parsed.data.event ?? parsed.data;
  const value = fields.action?.value;
  const tenantKey = parsed.data.header?.tenant_key;
  const chatId = fields.context?.open_chat_id ?? fields.open_chat_id;
  const messageId = fields.context?.open_message_id;
  const openId = fields.operator?.open_id ?? fields.operator?.operator_id?.open_id;
  const actionId = parsed.data.header?.event_id;
  return value && tenantKey && chatId && messageId && openId && actionId
    ? {
        value,
        ...(fields.action?.form_value ? { formValue: fields.action.form_value } : {}),
        tenantKey,
        chatId,
        messageId,
        openId,
        actionId,
      }
    : null;
}

function actorId(tenantKey: string, openId: string): string {
  return `feishu:${tenantKey}:${openId}`;
}

function coordinates(pending: FeishuLaunchPending): FeishuConversationCoordinates {
  return {
    tenantKey: pending.tenantKey,
    chatId: pending.chatId,
    chatType: pending.chatType,
    rootMessageId: pending.rootMessageId,
    ...(pending.threadId ? { threadId: pending.threadId } : {}),
    replyMode: pending.replyMode,
  };
}

async function loadCatalog(
  env: Env,
  traceId: string,
  recentContext?: { tenantKey: string; chatId: string; actorId: string }
): Promise<LaunchCardCatalog> {
  const [repositories, environments, sessions] = await Promise.all([
    listRepositoryCatalog(env, traceId),
    listEnvironmentTargets(env, traceId),
    recentContext
      ? listConversationSessions(env, recentContext).catch(() => [])
      : Promise.resolve([]),
  ]);
  const availableKeys = new Set(repositories.targets.map((target) => target.repositoryKey));
  const recentRepositoryKeys = [
    ...new Set(
      sessions.flatMap((session) =>
        session.repositoryKey && availableKeys.has(session.repositoryKey)
          ? [session.repositoryKey]
          : []
      )
    ),
  ].slice(0, 3);
  return { repositories, environments, recentRepositoryKeys };
}

function recentContext(pending: FeishuLaunchPending) {
  return {
    tenantKey: pending.tenantKey,
    chatId: pending.chatId,
    actorId: pending.actorId,
  };
}

async function patchLaunchCard(
  env: Env,
  pending: FeishuLaunchPending,
  catalog?: LaunchCardCatalog
): Promise<void> {
  if (!pending.cardMessageId) throw new Error("Launch card message id is unavailable");
  await updateSessionCard(
    env,
    pending.cardMessageId,
    buildLaunchLifecycleCard({ pending, catalog, webAppUrl: env.WEB_APP_URL })
  );
  log.info("card.patch_succeeded", {
    pending_id: pending.pendingId,
    card_message_id: pending.cardMessageId,
    phase: pending.phase,
    view: pending.view,
    selection_revision: pending.selectionRevision,
  });
}

async function resolveAndPersist(input: {
  env: Env;
  pendingId: string;
  actorId: string;
  intent: FeishuLaunchIntent;
  traceId: string;
  commitIntent: boolean;
  clearEditor?: boolean;
  view?: "summary" | "workspace" | "runtime";
}): Promise<{
  pending: FeishuLaunchPending;
  resolved?: ResolveRuntimeLaunchDraftResponse;
}> {
  if (!input.intent.target) {
    const pending = await updateLaunchPending(input.env, input.pendingId, (current) => ({
      ...current,
      phase: "configuring",
      view: input.view ?? current.view,
      ...(input.commitIntent ? { intent: input.intent } : {}),
      ...(input.clearEditor
        ? { editor: undefined }
        : current.editor
          ? { editor: { ...current.editor, draft: input.intent } }
          : {}),
      draft: undefined,
      error: "请选择一个工作区。",
    }));
    if (!pending) throw new Error("Launch request expired");
    return { pending };
  }

  const result = await resolveFeishuRuntimeDraft({
    env: input.env,
    actorId: input.actorId,
    target: input.intent.target,
    runtime: input.intent.runtime,
    traceId: input.traceId,
  });
  if (!result.ok) {
    const pending = await updateLaunchPending(input.env, input.pendingId, (current) => ({
      ...current,
      phase: result.reason === "unavailable" ? "stale" : "configuring",
      view: input.view ?? current.view,
      ...(input.commitIntent ? { intent: input.intent } : {}),
      ...(current.editor ? { editor: { ...current.editor, draft: input.intent } } : {}),
      draft: undefined,
      error: result.error,
    }));
    if (!pending) throw new Error("Launch request expired");
    return { pending };
  }

  const pending = await updateLaunchPending(input.env, input.pendingId, (current) => ({
    ...current,
    phase: "configuring",
    view: input.view ?? current.view,
    ...(input.commitIntent ? { intent: input.intent } : {}),
    ...(input.clearEditor
      ? { editor: undefined }
      : current.editor
        ? { editor: { ...current.editor, draft: input.intent } }
        : {}),
    draft: snapshotRuntimeDraft(result.data),
    error: undefined,
  }));
  if (!pending) throw new Error("Launch request expired");
  return { pending, resolved: result.data };
}

function runtimeCatalog(
  catalog: LaunchCardCatalog,
  resolved?: ResolveRuntimeLaunchDraftResponse
): LaunchCardCatalog {
  return { ...catalog, ...(resolved ? { runtimeOptions: resolved.options } : {}) };
}

export async function initializeSingleCardLaunch(input: {
  env: Env;
  coordinates: FeishuConversationCoordinates;
  actorId: string;
  content: string;
  incomingMessageId: string;
  traceId: string;
}): Promise<void> {
  let pending = await createLaunchPending(input.env, {
    ...input.coordinates,
    incomingMessageId: input.incomingMessageId,
    actorId: input.actorId,
    content: input.content,
  });
  const replyId = await deliveryIdempotencyKey(input.incomingMessageId, "launch-card");
  const sent = await replySessionCard(
    input.env,
    input.coordinates,
    buildLaunchLifecycleCard({ pending, webAppUrl: input.env.WEB_APP_URL }),
    replyId
  );
  if (!sent?.messageId) throw new Error("Feishu did not return a launch card message id");
  pending =
    (await updateLaunchPending(
      input.env,
      pending.pendingId,
      (current) => ({
        ...current,
        cardMessageId: sent.messageId,
        ...(sent.threadId ? { threadId: sent.threadId, replyMode: "thread" as const } : {}),
      }),
      { incrementRevision: false }
    )) ?? pending;

  let catalog: LaunchCardCatalog;
  try {
    catalog = await loadCatalog(input.env, input.traceId, recentContext(pending));
  } catch {
    const failed = await updateLaunchPending(input.env, pending.pendingId, (current) => ({
      ...current,
      phase: "stale",
      error: "工作区目录暂时不可用，请重试。",
    }));
    if (failed) await patchLaunchCard(input.env, failed);
    return;
  }
  const inferred =
    inferRepositoryTarget(catalog.repositories.targets, input.content) ??
    (catalog.repositories.targets.length === 1 ? catalog.repositories.targets[0]! : null);
  if (!inferred) {
    await openEditor({
      env: input.env,
      pending,
      kind: "workspace",
      traceId: input.traceId,
      catalog,
    });
    return;
  }
  const target: RuntimeLaunchTarget = {
    kind: "repository",
    repositoryKey: inferred.repositoryKey,
    ...(inferRepositoryBranch(inferred, input.content)
      ? { branch: inferRepositoryBranch(inferred, input.content) }
      : {}),
  };
  const resolved = await resolveAndPersist({
    env: input.env,
    pendingId: pending.pendingId,
    actorId: input.actorId,
    intent: { target },
    traceId: input.traceId,
    commitIntent: true,
    clearEditor: true,
    view: "summary",
  });
  await patchLaunchCard(input.env, resolved.pending, runtimeCatalog(catalog, resolved.resolved));
}

function repositoryByKey(catalog: FeishuRepositoryCatalog, key: string) {
  return findRepositoryTarget(catalog.targets, key);
}

function targetFromArgument(
  argument: string | undefined,
  catalog: LaunchCardCatalog,
  content: string
): RuntimeLaunchTarget | null {
  if (argument === "none") return { kind: "none" };
  if (argument?.startsWith("repository:")) {
    const repository = repositoryByKey(catalog.repositories, argument.slice("repository:".length));
    if (!repository) return null;
    const branch = inferRepositoryBranch(repository, content);
    return {
      kind: "repository",
      repositoryKey: repository.repositoryKey,
      ...(branch ? { branch } : {}),
    };
  }
  if (argument?.startsWith("environment:")) {
    const environmentId = argument.slice("environment:".length);
    return catalog.environments.some((environment) => environment.environmentId === environmentId)
      ? { kind: "environment", environmentId }
      : null;
  }
  return null;
}

async function openEditor(input: {
  env: Env;
  pending: FeishuLaunchPending;
  kind: "workspace" | "runtime";
  traceId: string;
  catalog: LaunchCardCatalog;
}): Promise<FeishuLaunchPending> {
  let pending = await updateLaunchPending(input.env, input.pending.pendingId, (current) => {
    const target = current.intent.target;
    const selectedRepository = repositoryTargetKeys(current.intent)
      .map((key) =>
        input.catalog.repositories.targets.find((candidate) => candidate.repositoryKey === key)
      )
      .find(Boolean);
    const connectionId = selectedRepository?.connectionId;
    const connectionIndex = input.catalog.repositories.connections.findIndex(
      (connection) => connection.id === connectionId
    );
    const repositoryIndex = connectionId
      ? input.catalog.repositories.targets
          .filter((repository) => repository.connectionId === connectionId)
          .findIndex((repository) => repository.repositoryKey === selectedRepository?.repositoryKey)
      : -1;
    const environmentIndex =
      target?.kind === "environment"
        ? input.catalog.environments.findIndex(
            (environment) => environment.environmentId === target.environmentId
          )
        : -1;
    return {
      ...current,
      phase: "configuring",
      view: input.kind,
      editor: {
        kind: input.kind,
        base: current.intent,
        draft: current.intent,
        ...(connectionId ? { connectionId } : {}),
        connectionPage:
          connectionIndex < 0 ? 0 : Math.floor(connectionIndex / LAUNCH_CONNECTIONS_PER_PAGE),
        repositoryPage:
          repositoryIndex < 0 ? 0 : Math.floor(repositoryIndex / LAUNCH_REPOSITORIES_PER_PAGE),
        environmentPage:
          environmentIndex < 0 ? 0 : Math.floor(environmentIndex / LAUNCH_ENVIRONMENTS_PER_PAGE),
        runtimeModelPage: 0,
      },
      error: undefined,
    };
  });
  if (!pending) throw new Error("Launch request expired");
  if (input.kind === "runtime") {
    const resolved = await resolveAndPersist({
      env: input.env,
      pendingId: pending.pendingId,
      actorId: pending.actorId,
      intent: pending.intent,
      traceId: input.traceId,
      commitIntent: false,
      view: "runtime",
    });
    pending = resolved.pending;
    input.catalog.runtimeOptions = resolved.resolved?.options;
  }
  await patchLaunchCard(input.env, pending, input.catalog);
  return pending;
}

async function updateEditorAndResolve(input: {
  env: Env;
  pending: FeishuLaunchPending;
  intent: FeishuLaunchIntent;
  traceId: string;
  catalog: LaunchCardCatalog;
}): Promise<FeishuLaunchPending> {
  const resolved = await resolveAndPersist({
    env: input.env,
    pendingId: input.pending.pendingId,
    actorId: input.pending.actorId,
    intent: input.intent,
    traceId: input.traceId,
    commitIntent: false,
    view: input.pending.view,
  });
  await patchLaunchCard(
    input.env,
    resolved.pending,
    runtimeCatalog(input.catalog, resolved.resolved)
  );
  return resolved.pending;
}

function targetLabel(draft: ResolveRuntimeLaunchDraftResponse): string {
  const target = draft.effective.target;
  if (target.kind === "none") return "临时工作区（无仓库）";
  if (target.kind === "environment") {
    const primary = target.repositories[0];
    return primary
      ? `环境 · ${target.environmentId} · ${primary.owner}/${primary.name}${target.repositories.length > 1 ? ` 等 ${target.repositories.length} 个仓库` : ""}`
      : `环境 · ${target.environmentId}`;
  }
  const primary = target.repositories[0];
  if (!primary) return "工作区";
  return target.repositories.length === 1
    ? `${primary.owner}/${primary.name}`
    : `${primary.owner}/${primary.name} 等 ${target.repositories.length} 个仓库`;
}

async function startSession(
  env: Env,
  pending: FeishuLaunchPending,
  actionId: string,
  traceId: string
): Promise<{ ok: true; content: string } | { ok: false; content: string }> {
  const target = pending.intent.target;
  if (!target || !pending.draft?.launchable) {
    return { ok: false, content: "当前配置尚不能启动。" };
  }
  const resolved = await resolveFeishuRuntimeDraft({
    env,
    actorId: pending.actorId,
    target,
    runtime: pending.intent.runtime,
    traceId,
  });
  if (!resolved.ok) {
    const stale = await updateLaunchPending(env, pending.pendingId, (current) => ({
      ...current,
      phase: "stale",
      error: resolved.error,
    }));
    if (stale) await patchLaunchCard(env, stale);
    return { ok: false, content: resolved.error };
  }
  if (resolved.data.draftDigest !== pending.draft.draftDigest) {
    const changed = await updateLaunchPending(env, pending.pendingId, (current) => ({
      ...current,
      phase: "configuring",
      view: "summary",
      draft: snapshotRuntimeDraft(resolved.data),
      error: "运行时能力已经变化，请检查更新后的配置并再次点击开始。",
    }));
    if (changed) await patchLaunchCard(env, changed);
    return { ok: false, content: "运行时能力已变化，请重新确认。" };
  }
  const topic = coordinates(pending);
  if (!(await claimThreadSelection(env, topic, actionId))) {
    return { ok: false, content: "本话题正在创建会话。" };
  }
  try {
    const existing = await lookupThreadSession(env, topic);
    if (existing) {
      const expired = await updateLaunchPending(env, pending.pendingId, (current) => ({
        ...current,
        phase: "expired",
        error: `本话题已绑定 ${existing.targetLabel}。`,
      }));
      if (expired) await patchLaunchCard(env, expired).catch(() => undefined);
      return { ok: false, content: "本话题已经绑定会话。" };
    }
    const starting = await updateLaunchPending(env, pending.pendingId, (current) => ({
      ...current,
      phase: "starting",
      view: "summary",
      editor: undefined,
      draft: snapshotRuntimeDraft(resolved.data),
      error: undefined,
    }));
    if (!starting) return { ok: false, content: "任务配置已过期。" };
    // A visible, successfully updated starting state is required before the VM side effect.
    await patchLaunchCard(env, starting);
    const created = await createResolvedSession({
      env,
      target,
      runtime: starting.intent.runtime,
      runtimeDraftDigest: resolved.data.draftDigest,
      clientRequestId: `feishu-session:${pending.pendingId}`,
      actorId: pending.actorId,
      traceId,
    });
    if (!created.ok) {
      const changedDraft = created.reason === "capability_changed" ? created.draft : undefined;
      const failed = await updateLaunchPending(env, pending.pendingId, (current) => ({
        ...current,
        phase: changedDraft ? "configuring" : created.reason === "unavailable" ? "stale" : "failed",
        view: "summary",
        ...(changedDraft ? { draft: snapshotRuntimeDraft(changedDraft) } : {}),
        error: changedDraft
          ? "运行时能力已经变化，请检查更新后的配置并再次点击开始。"
          : created.error,
      }));
      if (failed) await patchLaunchCard(env, failed);
      return { ok: false, content: created.error };
    }
    const effective = resolved.data.effective;
    if (!effective.harness || !effective.routeId || !effective.model || !effective.effort) {
      throw new Error("Launchable runtime draft is missing effective fields");
    }
    const label = targetLabel(resolved.data);
    const branch = effective.target.repositories[0]?.branch;
    const now = Date.now();
    await storeThreadSession(env, topic, {
      version: 3,
      sessionId: created.data.sessionId,
      target,
      targetLabel: label,
      ...(target.kind === "repository" ? { repositoryKey: target.repositoryKey } : {}),
      ...(branch ? { branch } : {}),
      model: effective.model.value,
      harness: effective.harness.value,
      routeId: effective.routeId.value,
      draftDigest: resolved.data.draftDigest,
      ...(effective.effort.value ? { reasoningEffort: effective.effort.value } : {}),
      actorId: pending.actorId,
      chatType: topic.chatType,
      rootMessageId: topic.rootMessageId,
      ...(topic.threadId ? { threadId: topic.threadId } : {}),
      replyMode: topic.replyMode,
      state: "starting",
      createdAt: now,
      updatedAt: now,
      lastMessageId: pending.incomingMessageId,
    });
    await updateLaunchPending(env, pending.pendingId, (current) => ({
      ...current,
      sessionId: created.data.sessionId,
    }));
    const callbackContext: FeishuCallbackContext = {
      source: "feishu",
      tenantKey: topic.tenantKey,
      chatId: topic.chatId,
      rootMessageId: topic.rootMessageId,
      chatType: topic.chatType,
      ...(topic.threadId ? { threadId: topic.threadId } : {}),
      replyMode: topic.replyMode,
      ...(branch ? { branch } : {}),
      harness: effective.harness.value,
      ...(starting.cardMessageId ? { workingMessageId: starting.cardMessageId } : {}),
      cardLifecycle: "single-card-v2",
      targetLabel: label,
      routeId: effective.routeId.value,
      model: effective.model.value,
      ...(effective.effort.value ? { reasoningEffort: effective.effort.value } : {}),
    };
    const delivered = await sendPrompt({
      env,
      sessionId: created.data.sessionId,
      content: pending.content,
      actorId: pending.actorId,
      callbackContext,
      visualVerification: visualVerificationForPrompt(pending.content),
      clientRequestId: `feishu-prompt:${pending.pendingId}`,
      traceId,
    });
    if (!delivered.ok) {
      await updateThreadSession(env, topic, {
        state: delivered.reason === "stale" ? "stale" : "delivery_failed",
      });
      const failed = await updateLaunchPending(env, pending.pendingId, (current) => ({
        ...current,
        sessionId: created.data.sessionId,
        phase: delivered.reason === "stale" ? "stale" : "delivery_failed",
        error:
          delivered.reason === "stale"
            ? "会话已经失效，请重新发起任务。"
            : "会话已创建，但请求投递结果暂时未知。请打开 Web 会话确认，不要重复开始任务。",
      }));
      if (failed) await patchLaunchCard(env, failed);
      return {
        ok: false,
        content:
          delivered.reason === "stale" ? "会话已经失效。" : "会话已创建，但请求投递结果暂时未知。",
      };
    }
    await updateThreadSession(env, topic, {
      state: "active",
      lastMessageId: delivered.data.messageId,
    });
    const active = await updateLaunchPending(env, pending.pendingId, (current) => ({
      ...current,
      sessionId: created.data.sessionId,
      phase: "active",
      error: undefined,
    }));
    if (active) {
      try {
        await patchLaunchCard(env, active);
      } catch (error) {
        const fallbackId = await deliveryIdempotencyKey(
          `active-card:${pending.pendingId}`,
          "patch-fallback"
        );
        await replySessionText(
          env,
          topic,
          `会话已创建并开始运行：${env.WEB_APP_URL.replace(/\/$/, "")}/session/${encodeURIComponent(created.data.sessionId)}`,
          fallbackId
        ).catch((fallbackError) => {
          log.error("card.active_fallback_failed", {
            trace_id: traceId,
            pending_id: pending.pendingId,
            session_id: created.data.sessionId,
            patch_error: error instanceof Error ? error : new Error(String(error)),
            fallback_error:
              fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)),
          });
        });
      }
    }
    log.info("session.started", {
      trace_id: traceId,
      pending_id: pending.pendingId,
      session_id: created.data.sessionId,
      card_message_id: pending.cardMessageId,
      draft_digest: resolved.data.draftDigest,
      target_kind: target.kind,
    });
    return { ok: true, content: "任务已开始。" };
  } finally {
    await releaseThreadSelection(env, topic, actionId);
  }
}

function runtimeIntent(
  pending: FeishuLaunchPending,
  resolved: ResolveRuntimeLaunchDraftResponse,
  field: string | undefined,
  argument: string | undefined
): FeishuLaunchIntent | null {
  const editor = pending.editor;
  if (!editor || editor.kind !== "runtime" || !editor.draft.target || !field || !argument)
    return null;
  const current = editor.draft.runtime ?? {};
  if (field === "harness") {
    const harness = resolved.options.harnesses.find(
      (option) => option.harness === argument && option.ready
    );
    return harness ? { target: editor.draft.target, runtime: { harness: harness.harness } } : null;
  }
  if (field === "model") {
    let selection: [string, string];
    try {
      const parsed = z
        .tuple([z.string().min(1), z.string().min(1)])
        .safeParse(JSON.parse(argument));
      if (!parsed.success) return null;
      selection = parsed.data;
    } catch {
      return null;
    }
    const [routeId, modelName] = selection;
    const model = resolved.options.models.find(
      (option) => option.routeId === routeId && option.model === modelName && option.ready
    );
    return model
      ? {
          target: editor.draft.target,
          runtime: {
            ...current,
            routeId: model.routeId,
            model: model.model,
            effort: undefined,
          },
        }
      : null;
  }
  if (field === "effort") {
    const selectedModel = resolved.options.models.find(
      (option) =>
        option.routeId === resolved.effective.routeId?.value &&
        option.model === resolved.effective.model?.value &&
        option.ready
    );
    const effort = selectedModel?.efforts.find((option) => option.value === argument);
    return effort
      ? { target: editor.draft.target, runtime: { ...current, effort: effort.value } }
      : null;
  }
  return null;
}

function editableRuntimeSettings(draft: ResolveRuntimeLaunchDraftResponse) {
  const harness = draft.effective.harness?.value;
  return (
    draft.options.harnesses
      .find((option) => option.harness === harness)
      ?.settings.filter(
        (setting) =>
          !setting.sensitive &&
          setting.visibility === "user" &&
          setting.mutability === "session-start"
      ) ?? []
  );
}

function settingValueFromArgument(
  draft: ResolveRuntimeLaunchDraftResponse,
  key: string | undefined,
  argument: string | undefined
): unknown | undefined {
  if (!key || argument === undefined) return undefined;
  const setting = editableRuntimeSettings(draft).find((candidate) => candidate.key === key);
  if (!setting) return undefined;
  if (setting.type === "boolean") {
    if (argument === "true") return true;
    if (argument === "false") return false;
    return undefined;
  }
  if (setting.type === "enum") {
    return setting.enumOptions?.some((option) => option.value === argument) ? argument : undefined;
  }
  return undefined;
}

function parseFormSettingValue(type: string, value: unknown): unknown | undefined {
  if (typeof value !== "string") return undefined;
  if (type === "integer") {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if (type === "string-list") {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return type === "string" ? value : undefined;
}

function runtimeSettingsIntent(
  pending: FeishuLaunchPending,
  resolved: ResolveRuntimeLaunchDraftResponse,
  formValue: Record<string, unknown> | undefined
): FeishuLaunchIntent | null {
  const editor = pending.editor;
  if (!editor || editor.kind !== "runtime" || !editor.draft.target || !formValue) return null;
  if (
    pending.draft &&
    (resolved.capabilityCatalogVersion !== pending.draft.capabilityCatalogVersion ||
      resolved.draftDigest !== pending.draft.draftDigest)
  ) {
    return null;
  }
  const inputSettings = editableRuntimeSettings(resolved).filter((setting) =>
    ["string", "integer", "string-list"].includes(setting.type)
  );
  const nextSettings = { ...(editor.draft.runtime?.settings ?? {}) };
  for (const [index, setting] of inputSettings.entries()) {
    const name = `runtime_setting_${index}`;
    if (!(name in formValue)) continue;
    const value = parseFormSettingValue(setting.type, formValue[name]);
    if (value === undefined) return null;
    nextSettings[setting.key] = value;
  }
  return {
    target: editor.draft.target,
    runtime: { ...(editor.draft.runtime ?? {}), settings: nextSettings },
  };
}

function repositoryTargetKeys(intent: FeishuLaunchIntent): string[] {
  if (intent.target?.kind === "repository") return [intent.target.repositoryKey];
  if (intent.target?.kind === "repository-set") return intent.target.repositoryKeys;
  return [];
}

export async function handleFeishuLaunchCardAction(
  payload: unknown,
  env: Env,
  traceId: string
): Promise<{ ok: true; content?: string } | { ok: false; content: string }> {
  const action = parseFeishuLaunchCardAction(payload);
  if (!action) return { ok: false, content: "请求无效，请重新发起。" };
  const pending = await getLaunchPending(env, action.value.pendingId);
  const actor = actorId(action.tenantKey, action.openId);
  if (
    !pending ||
    pending.actorId !== actor ||
    pending.tenantKey !== action.tenantKey ||
    pending.chatId !== action.chatId ||
    pending.cardMessageId !== action.messageId
  ) {
    return { ok: false, content: "该卡片已过期或无权操作。" };
  }
  if (action.value.selectionRevision !== pending.selectionRevision) {
    return { ok: false, content: "该操作基于旧状态，请使用当前卡片重试。" };
  }
  if (!(await claimCardActionOnce(env, action.actionId))) {
    return { ok: true, content: "该操作已处理。" };
  }
  if (action.value.action === "start_session") {
    return startSession(env, pending, action.actionId, traceId);
  }
  const existing = await lookupThreadSession(env, coordinates(pending));
  if (existing) {
    const expired = await updateLaunchPending(env, pending.pendingId, (current) => ({
      ...current,
      phase: "expired",
      error: `本话题已绑定 ${existing.targetLabel}。`,
    }));
    if (expired) await patchLaunchCard(env, expired).catch(() => undefined);
    return { ok: false, content: "本话题已经绑定会话。" };
  }

  let catalog: LaunchCardCatalog;
  try {
    catalog = await loadCatalog(env, traceId, recentContext(pending));
  } catch {
    return { ok: false, content: "工作区目录暂时不可用。" };
  }
  const value = action.value;
  if (value.action === "open_workspace" || value.action === "open_runtime") {
    if (value.action === "open_runtime" && !pending.intent.target) {
      return { ok: false, content: "请先选择工作区。" };
    }
    await openEditor({
      env,
      pending,
      kind: value.action === "open_workspace" ? "workspace" : "runtime",
      traceId,
      catalog,
    });
    return { ok: true, content: "卡片已更新。" };
  }
  if (value.action === "retry_resolve") {
    const resolved = await resolveAndPersist({
      env,
      pendingId: pending.pendingId,
      actorId: pending.actorId,
      intent: pending.editor?.draft ?? pending.intent,
      traceId,
      commitIntent: !pending.editor,
      view: pending.view,
    });
    await patchLaunchCard(env, resolved.pending, runtimeCatalog(catalog, resolved.resolved));
    return { ok: true, content: "已重新解析。" };
  }
  if (value.action === "select_connection") {
    const connection = catalog.repositories.connections.find((item) => item.id === value.argument);
    if (!connection || pending.editor?.kind !== "workspace") {
      return { ok: false, content: "代码源已不可用。" };
    }
    const updated = await updateLaunchPending(env, pending.pendingId, (current) => ({
      ...current,
      editor: current.editor
        ? {
            ...current.editor,
            connectionId: connection.id,
            repositoryPage: 0,
            draft: {
              ...current.editor.draft,
              target: repositoryTargetKeys(current.editor.draft).every((key) =>
                catalog.repositories.targets.some(
                  (repository) =>
                    repository.repositoryKey === key && repository.connectionId === connection.id
                )
              )
                ? current.editor.draft.target
                : null,
            },
          }
        : undefined,
    }));
    if (updated) await patchLaunchCard(env, updated, catalog);
    return { ok: true, content: "代码源已更新。" };
  }
  if (
    value.action === "connection_page" ||
    value.action === "repository_page" ||
    value.action === "environment_page" ||
    value.action === "runtime_model_page"
  ) {
    const page = Number(value.argument);
    const workspacePage = value.action !== "runtime_model_page";
    if (
      !Number.isInteger(page) ||
      page < 0 ||
      !pending.editor ||
      (workspacePage && pending.editor.kind !== "workspace") ||
      (!workspacePage && pending.editor.kind !== "runtime")
    ) {
      return { ok: false, content: "分页请求无效。" };
    }
    const updated = await updateLaunchPending(env, pending.pendingId, (current) => ({
      ...current,
      editor: current.editor
        ? {
            ...current.editor,
            ...(value.action === "connection_page"
              ? { connectionPage: page }
              : value.action === "repository_page"
                ? { repositoryPage: page }
                : value.action === "environment_page"
                  ? { environmentPage: page }
                  : { runtimeModelPage: page }),
          }
        : undefined,
    }));
    if (updated) {
      if (value.action === "runtime_model_page" && updated.editor?.draft.target) {
        const result = await resolveFeishuRuntimeDraft({
          env,
          actorId: updated.actorId,
          target: updated.editor.draft.target,
          runtime: updated.editor.draft.runtime,
          traceId,
        });
        if (result.ok) catalog.runtimeOptions = result.data.options;
      }
      await patchLaunchCard(env, updated, catalog);
    }
    return { ok: true, content: "已翻页。" };
  }
  if (value.action === "toggle_multi_mode") {
    if (pending.editor?.kind !== "workspace") return { ok: false, content: "工作区编辑已结束。" };
    const target = pending.editor.draft.target;
    const keys =
      target?.kind === "repository"
        ? [target.repositoryKey]
        : target?.kind === "repository-set"
          ? target.repositoryKeys
          : [];
    const updated = await updateLaunchPending(env, pending.pendingId, (current) => ({
      ...current,
      editor: current.editor
        ? {
            ...current.editor,
            multiSelect: !current.editor.multiSelect,
            draft: {
              ...current.editor.draft,
              target: keys.length ? { kind: "repository-set", repositoryKeys: keys } : null,
            },
          }
        : undefined,
    }));
    if (updated) await patchLaunchCard(env, updated, catalog);
    return { ok: true, content: "多仓库选择模式已更新。" };
  }
  if (value.action === "set_target") {
    if (pending.editor?.kind !== "workspace") return { ok: false, content: "工作区编辑已结束。" };
    const target = targetFromArgument(value.argument, catalog, pending.content);
    if (!target) return { ok: false, content: "目标已不可用。" };
    const updated = await updateLaunchPending(env, pending.pendingId, (current) => ({
      ...current,
      editor: current.editor
        ? {
            ...current.editor,
            ...(target.kind === "repository"
              ? {
                  connectionId: repositoryByKey(catalog.repositories, target.repositoryKey)
                    ?.connectionId,
                  repositoryPage: 0,
                }
              : {}),
            draft: { ...current.editor.draft, target },
          }
        : undefined,
      error: undefined,
    }));
    if (updated) await patchLaunchCard(env, updated, catalog);
    return { ok: true, content: "目标已选择；点击应用后生效。" };
  }
  if (value.action === "toggle_repository") {
    const editor = pending.editor;
    const repository = value.argument
      ? repositoryByKey(catalog.repositories, value.argument)
      : null;
    if (!editor?.multiSelect || !repository) return { ok: false, content: "仓库已不可用。" };
    const connectionId = editor.connectionId ?? repository.connectionId;
    if (repository.connectionId !== connectionId) {
      return { ok: false, content: "多仓库目标必须使用同一个代码源。" };
    }
    const currentKeys = repositoryTargetKeys(editor.draft);
    const nextKeys = currentKeys.includes(repository.repositoryKey)
      ? currentKeys.filter((key) => key !== repository.repositoryKey)
      : [...currentKeys, repository.repositoryKey];
    if (nextKeys.length > 10) return { ok: false, content: "最多选择 10 个仓库。" };
    const updated = await updateLaunchPending(env, pending.pendingId, (current) => ({
      ...current,
      editor: current.editor
        ? {
            ...current.editor,
            connectionId,
            draft: {
              ...current.editor.draft,
              target: nextKeys.length ? { kind: "repository-set", repositoryKeys: nextKeys } : null,
            },
          }
        : undefined,
    }));
    if (updated) await patchLaunchCard(env, updated, catalog);
    return { ok: true, content: "仓库集合已更新。" };
  }
  if (value.action === "set_runtime_field") {
    if (pending.editor?.kind !== "runtime" || !pending.editor.draft.target) {
      return { ok: false, content: "Runtime 编辑已结束。" };
    }
    const currentDraft = await resolveFeishuRuntimeDraft({
      env,
      actorId: pending.actorId,
      target: pending.editor.draft.target,
      runtime: pending.editor.draft.runtime,
      traceId,
    });
    if (!currentDraft.ok) return { ok: false, content: currentDraft.error };
    const intent = runtimeIntent(pending, currentDraft.data, value.field, value.argument);
    if (!intent) return { ok: false, content: "该 Runtime 选项当前不可用。" };
    await updateEditorAndResolve({ env, pending, intent, traceId, catalog });
    return { ok: true, content: "Runtime 选择已更新。" };
  }
  if (value.action === "set_runtime_setting" || value.action === "apply_runtime_settings") {
    if (pending.editor?.kind !== "runtime" || !pending.editor.draft.target) {
      return { ok: false, content: "Runtime 编辑已结束。" };
    }
    const currentDraft = await resolveFeishuRuntimeDraft({
      env,
      actorId: pending.actorId,
      target: pending.editor.draft.target,
      runtime: pending.editor.draft.runtime,
      traceId,
    });
    if (!currentDraft.ok) return { ok: false, content: currentDraft.error };
    let intent: FeishuLaunchIntent | null;
    if (value.action === "set_runtime_setting") {
      const settingValue = settingValueFromArgument(currentDraft.data, value.field, value.argument);
      intent =
        settingValue === undefined
          ? null
          : {
              target: pending.editor.draft.target,
              runtime: {
                ...(pending.editor.draft.runtime ?? {}),
                settings: {
                  ...(pending.editor.draft.runtime?.settings ?? {}),
                  [value.field!]: settingValue,
                },
              },
            };
    } else {
      intent = runtimeSettingsIntent(pending, currentDraft.data, action.formValue);
    }
    if (!intent) {
      return { ok: false, content: "启动设置已变化或输入无效，请使用当前卡片重试。" };
    }
    await updateEditorAndResolve({ env, pending, intent, traceId, catalog });
    return { ok: true, content: "启动设置已更新。" };
  }
  if (value.action === "reset_runtime") {
    if (!pending.editor?.draft.target) return { ok: false, content: "Runtime 编辑已结束。" };
    await updateEditorAndResolve({
      env,
      pending,
      intent: { target: pending.editor.draft.target },
      traceId,
      catalog,
    });
    return { ok: true, content: "已恢复目标默认 Runtime。" };
  }
  if (value.action === "cancel_editor" || value.action === "apply_editor") {
    if (!pending.editor) return { ok: false, content: "编辑状态已结束。" };
    const intent = value.action === "cancel_editor" ? pending.editor.base : pending.editor.draft;
    if (!intent.target) return { ok: false, content: "请至少选择一个工作区。" };
    const resolved = await resolveAndPersist({
      env,
      pendingId: pending.pendingId,
      actorId: pending.actorId,
      intent,
      traceId,
      commitIntent: true,
      clearEditor: true,
      view: "summary",
    });
    await patchLaunchCard(env, resolved.pending, runtimeCatalog(catalog, resolved.resolved));
    return {
      ok: true,
      content: value.action === "cancel_editor" ? "已取消修改。" : "配置已应用。",
    };
  }
  return { ok: false, content: "请求无效。" };
}

export async function deliverSingleCardFollowUp(input: {
  env: Env;
  coordinates: FeishuConversationCoordinates;
  existing: FeishuThreadSession;
  actorId: string;
  incomingMessageId: string;
  content: string;
  traceId: string;
}): Promise<boolean> {
  const card = buildTurnWorkingCard({
    sessionId: input.existing.sessionId,
    targetLabel: input.existing.targetLabel,
    webAppUrl: input.env.WEB_APP_URL,
    ...(input.existing.branch ? { branch: input.existing.branch } : {}),
    ...(input.existing.harness ? { harness: input.existing.harness } : {}),
    ...(input.existing.routeId ? { routeId: input.existing.routeId } : {}),
    model: input.existing.model,
    ...(input.existing.reasoningEffort ? { reasoningEffort: input.existing.reasoningEffort } : {}),
    task: input.content,
  });
  const replyId = await deliveryIdempotencyKey(input.incomingMessageId, "turn-card");
  const sent = await replySessionCard(input.env, input.coordinates, card, replyId);
  if (!sent?.messageId) throw new Error("Feishu did not return a follow-up card message id");
  const callbackContext: FeishuCallbackContext = {
    source: "feishu",
    tenantKey: input.coordinates.tenantKey,
    chatId: input.coordinates.chatId,
    rootMessageId: input.coordinates.rootMessageId,
    chatType: input.coordinates.chatType,
    ...(input.coordinates.threadId ? { threadId: input.coordinates.threadId } : {}),
    replyMode: input.coordinates.replyMode,
    ...(input.existing.branch ? { branch: input.existing.branch } : {}),
    ...(input.existing.harness ? { harness: input.existing.harness } : {}),
    workingMessageId: sent.messageId,
    cardLifecycle: "single-card-v2",
    targetLabel: input.existing.targetLabel,
    ...(input.existing.routeId ? { routeId: input.existing.routeId } : {}),
    model: input.existing.model,
    ...(input.existing.reasoningEffort ? { reasoningEffort: input.existing.reasoningEffort } : {}),
  };
  const delivered = await sendPrompt({
    env: input.env,
    sessionId: input.existing.sessionId,
    content: input.content,
    actorId: input.actorId,
    callbackContext,
    visualVerification: visualVerificationForPrompt(input.content),
    clientRequestId: `feishu-followup:${input.incomingMessageId}`.slice(0, 128),
    traceId: input.traceId,
  });
  if (!delivered.ok) {
    await updateThreadSession(input.env, input.coordinates, {
      state: delivered.reason === "stale" ? "stale" : "delivery_failed",
    });
    await updateSessionCard(
      input.env,
      sent.messageId,
      buildTurnCompletionCard({
        sessionId: input.existing.sessionId,
        targetLabel: input.existing.targetLabel,
        textContent: "",
        success: false,
        error:
          delivered.reason === "stale"
            ? "会话已经失效，请重新发起任务。"
            : "请求投递结果暂时未知，请打开 Web 会话确认，不要重复发送。",
        webAppUrl: input.env.WEB_APP_URL,
        ...(input.existing.branch ? { branch: input.existing.branch } : {}),
        ...(input.existing.harness ? { harness: input.existing.harness } : {}),
        ...(input.existing.routeId ? { routeId: input.existing.routeId } : {}),
        model: input.existing.model,
        ...(input.existing.reasoningEffort
          ? { reasoningEffort: input.existing.reasoningEffort }
          : {}),
      })
    );
    return true;
  }
  await updateThreadSession(input.env, input.coordinates, {
    state: "active",
    lastMessageId: delivered.data.messageId,
  });
  return true;
}
