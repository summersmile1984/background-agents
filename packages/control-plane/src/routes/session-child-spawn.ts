import { spawnChildSessionRequestSchema } from "@open-inspect/shared/types/session-api";
import {
  DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
  DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";
import {
  getReasoningConfig,
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
  resolveEnabledModel,
  type ValidModel,
  VALID_MODELS,
} from "@open-inspect/shared/models";
import type { SessionLaunchSpecV1 } from "@open-inspect/shared/types/runtime-launch";
import { generateId } from "../auth/crypto";
import { createSessionLaunchSpec } from "../agent-runtime/launch-spec";
import { resolveRuntimeLaunchDraft, RuntimeLaunchResolutionError } from "../agent-runtime/resolver";
import {
  AgentRuntimeSelectionError,
  assertAgentRuntimeSelection,
} from "../agent-runtime/selection";
import { DEFAULT_AGENT_HARNESS } from "@open-inspect/shared/types/agent-harness";
import { getEffectiveEnabledModels } from "../db/model-preferences";
import { SessionIndexStore } from "../db/session-index";
import { SessionLaunchSpecStore } from "../db/session-launch-specs";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import type { EnqueuePromptRequest } from "../session/enqueue-prompt-contract";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import {
  resolveCodeServerEnabled,
  resolveSandboxSettings,
  resolveVncEnabled,
} from "../session/integration-settings-resolution";
import { spawnContextSchema } from "../session/spawn-context";
import type { Env } from "../types";
import {
  defineRoutes,
  error,
  SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE,
  json,
  parsePattern,
  type Route,
} from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const logger = createLogger("router:session-child-spawn");
const MAX_SPAWN_DEPTH = 2;

async function handleSpawnChild(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = match.groups?.id;
  if (!parentId) return error("Parent session ID required");

  const parsedBody = spawnChildSessionRequestSchema.safeParse(await request.json());
  if (!parsedBody.success) {
    return error("title and prompt are required");
  }
  const body = parsedBody.data;

  if (!body.title || !body.prompt) {
    return error("title and prompt are required");
  }

  const sessionStore = new SessionIndexStore(ctx.db);

  const parentSession = await sessionStore.get(parentId);
  const parentEnvironmentId = parentSession?.environmentId ?? null;
  // Children inherit the parent's settings scope: its primary repo plus, for
  // environment-launched parents, that environment's overrides (design §13.5).
  const resolvedChildSandboxSettings = parentSession
    ? parentSession.repositoryId
      ? await resolveSandboxSettings(
          ctx.db,
          parentSession.repoOwner,
          parentSession.repoName,
          parentEnvironmentId,
          parentSession.repositoryId
        )
      : await resolveSandboxSettings(
          ctx.db,
          parentSession.repoOwner,
          parentSession.repoName,
          parentEnvironmentId
        )
    : {};
  const maxConcurrentChildren =
    resolvedChildSandboxSettings.maxConcurrentChildSessions ??
    DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS;
  const maxTotalChildren =
    resolvedChildSandboxSettings.maxTotalChildSessions ?? DEFAULT_MAX_TOTAL_CHILD_SESSIONS;

  const parentDepth = await sessionStore.getSpawnDepth(parentId);
  if (parentDepth >= MAX_SPAWN_DEPTH) {
    return error(`Maximum spawn depth (${MAX_SPAWN_DEPTH}) exceeded`, 403);
  }

  const totalCount = await sessionStore.countTotalChildren(parentId);
  if (totalCount >= maxTotalChildren) {
    return error(`Maximum total children (${maxTotalChildren}) reached`, 429);
  }

  const spawnContextRes = await ctx.sessionRuntime.fetch(
    parentId,
    SessionInternalPaths.spawnContext
  );

  if (!spawnContextRes.ok) {
    let message = "Failed to get parent session context";
    try {
      const body = (await spawnContextRes.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // Keep the generic fallback when the session runtime did not return JSON.
    }
    return error(message, spawnContextRes.status);
  }

  const parsedSpawnContext = spawnContextSchema.safeParse(await spawnContextRes.json());
  if (!parsedSpawnContext.success) {
    return error("Failed to get parent session context", 500);
  }
  const spawnContext = parsedSpawnContext.data;
  const { sandboxTimeoutMs: _currentTimeoutMs, ...resolvedChildSettingsWithoutTimeout } =
    resolvedChildSandboxSettings;
  const childSandboxSettings: SandboxSettings = resolvedChildSettingsWithoutTimeout;
  if (spawnContext.sandboxTimeoutMs !== undefined) {
    childSandboxSettings.sandboxTimeoutMs = spawnContext.sandboxTimeoutMs;
  }

  const requestedRepoOwner = body.repoOwner?.trim().toLowerCase() || null;
  const requestedRepoName = body.repoName?.trim().toLowerCase() || null;
  if ((requestedRepoOwner === null) !== (requestedRepoName === null)) {
    return error("repoOwner and repoName must be provided together", 400);
  }

  // Children pin to the parent's scalar repository, which for a multi-repo
  // parent is its primary member — child sessions are single-repo by design.
  const parentRepoOwner = spawnContext.repoOwner?.toLowerCase() ?? null;
  const parentRepoName = spawnContext.repoName?.toLowerCase() ?? null;
  if (requestedRepoOwner || requestedRepoName) {
    if (!parentRepoOwner || !parentRepoName) {
      return error("Cannot add repository context to a repo-less child session", 403);
    }
    if (requestedRepoOwner !== parentRepoOwner || requestedRepoName !== parentRepoName) {
      return error("Child sessions must use the same repository as the parent", 403);
    }
  }

  const parentLaunchSpec = await new SessionLaunchSpecStore(ctx.db).get(parentId);
  let model: ValidModel;
  let agentHarness = spawnContext.agentHarness ?? DEFAULT_AGENT_HARNESS;
  let reasoningEffort: string | null;
  let launchSpec: SessionLaunchSpecV1 | undefined;

  if (parentLaunchSpec) {
    const target = spawnContext.repositoryId
      ? {
          kind: "repository" as const,
          repositoryKey: spawnContext.repositoryId,
          branch: spawnContext.baseBranch ?? "main",
          ...(parentEnvironmentId ? { environmentId: parentEnvironmentId } : {}),
        }
      : ({ kind: "none" } as const);
    try {
      const resolved = await resolveRuntimeLaunchDraft({
        db: ctx.db,
        env,
        request: {
          target,
          runtime: {
            harness: parentLaunchSpec.runtime.harness.value,
            routeId: parentLaunchSpec.runtime.routeId.value,
            model: body.model ?? parentLaunchSpec.runtime.model.value,
            effort: body.reasoningEffort ?? parentLaunchSpec.runtime.effort.value ?? "inherit",
            settings: Object.fromEntries(
              Object.entries(parentLaunchSpec.runtime.settings).map(([key, value]) => [
                key,
                value.value,
              ])
            ),
          },
        },
        relayReady: false,
      });
      if (!resolved.launchable || !resolved.effective.model || !resolved.effective.harness) {
        return json(
          {
            error: resolved.issues[0]?.message ?? "Child runtime is not launchable",
            code: resolved.issues[0]?.code ?? "RUNTIME_UNAVAILABLE",
            issues: resolved.issues,
          },
          409
        );
      }
      model = resolved.effective.model.value as ValidModel;
      agentHarness = resolved.effective.harness.value;
      reasoningEffort = resolved.effective.effort?.value ?? null;
      launchSpec = createSessionLaunchSpec({
        resolved,
        skillsManifestId: parentLaunchSpec.skillsManifestId,
        caller: {
          channel: "child",
          canonicalUserId: spawnContext.promptAuthor.canonicalUserId ?? null,
          integrationId: parentId,
        },
      });
    } catch (cause) {
      if (cause instanceof RuntimeLaunchResolutionError) {
        return json({ error: cause.message, code: cause.code }, cause.status);
      }
      throw cause;
    }
  } else {
    let enabledModels: ValidModel[];
    try {
      enabledModels = await getEffectiveEnabledModels(ctx.db);
    } catch (e) {
      logger.error("Failed to resolve enabled models for child session", {
        event: "session.spawn_child_model_preferences_failed",
        parent_id: parentId,
        error: e instanceof Error ? e.message : String(e),
        trace_id: ctx.trace_id,
        request_id: ctx.request_id,
      });
      return error("Model preferences unavailable", 503);
    }
    if (body.model !== undefined && !isValidModel(body.model)) {
      return error(`Invalid model "${body.model}". Valid models: ${VALID_MODELS.join(", ")}`, 400);
    }
    const requestedModel = getValidModelOrDefault(body.model ?? spawnContext.model);
    if (body.model !== undefined && !enabledModels.includes(requestedModel)) {
      return error(`Model "${body.model}" is not enabled`, 400);
    }
    model = resolveEnabledModel({ model: requestedModel, enabledModels });
    try {
      await assertAgentRuntimeSelection({
        db: ctx.db,
        env,
        harness: agentHarness,
        model,
        target: {
          environmentId: parentEnvironmentId,
          repoId: spawnContext.repoId,
        },
      });
    } catch (cause) {
      if (cause instanceof AgentRuntimeSelectionError) {
        return json({ error: cause.message, code: cause.code }, 409);
      }
      throw cause;
    }
    if (
      body.reasoningEffort !== undefined &&
      !isValidReasoningEffort(model, body.reasoningEffort)
    ) {
      const validEfforts = getReasoningConfig(model)?.efforts;
      const suffix = validEfforts?.length
        ? ` Valid efforts: ${validEfforts.join(", ")}`
        : " This model does not support reasoning effort overrides.";
      return error(
        `Invalid reasoning effort "${body.reasoningEffort}" for model "${model}".${suffix}`,
        400
      );
    }
    const requestedReasoningEffort = body.reasoningEffort ?? spawnContext.reasoningEffort;
    reasoningEffort =
      requestedReasoningEffort && isValidReasoningEffort(model, requestedReasoningEffort)
        ? requestedReasoningEffort
        : null;
  }

  const childDepth = parentDepth + 1;
  const childId = generateId();

  logger.info("Spawning child session", {
    event: "session.spawn_child",
    parent_id: parentId,
    child_id: childId,
    child_depth: childDepth,
    model,
  });

  const childCodeServerEnabled = spawnContext.repositoryId
    ? await resolveCodeServerEnabled(
        ctx.db,
        spawnContext.repoOwner,
        spawnContext.repoName,
        parentEnvironmentId,
        spawnContext.repositoryId
      )
    : await resolveCodeServerEnabled(
        ctx.db,
        spawnContext.repoOwner,
        spawnContext.repoName,
        parentEnvironmentId
      );
  const childVncEnabled = spawnContext.repositoryId
    ? await resolveVncEnabled(
        ctx.db,
        spawnContext.repoOwner,
        spawnContext.repoName,
        parentEnvironmentId,
        spawnContext.repositoryId
      )
    : await resolveVncEnabled(
        ctx.db,
        spawnContext.repoOwner,
        spawnContext.repoName,
        parentEnvironmentId
      );

  const input: SessionInitInput = {
    sessionId: childId,
    repoOwner: spawnContext.repoOwner,
    repoName: spawnContext.repoName,
    repoId: spawnContext.repoId,
    repositoryId: spawnContext.repositoryId ?? null,
    scmConnectionId: spawnContext.scmConnectionId ?? null,
    environmentId: parentEnvironmentId,
    branch:
      spawnContext.repoOwner && spawnContext.repoName ? (spawnContext.baseBranch ?? "main") : null,
    title: body.title,
    model,
    reasoningEffort,
    agentHarness,
    participantUserId: spawnContext.promptAuthor.userId,
    platformUserId: spawnContext.promptAuthor.canonicalUserId ?? null,
    scmLogin: spawnContext.promptAuthor.scmLogin,
    scmName: spawnContext.promptAuthor.scmName,
    scmEmail: spawnContext.promptAuthor.scmEmail,
    scmUserId: spawnContext.promptAuthor.scmUserId,
    scmTokenEncrypted: spawnContext.promptAuthor.scmAccessTokenEncrypted,
    scmRefreshTokenEncrypted: spawnContext.promptAuthor.scmRefreshTokenEncrypted,
    scmTokenExpiresAt: spawnContext.promptAuthor.scmTokenExpiresAt,
    codeServerEnabled: childCodeServerEnabled,
    vncEnabled: childVncEnabled,
    sandboxSettings: childSandboxSettings,
    parentSessionId: parentId,
    spawnSource: "agent",
    spawnDepth: childDepth,
    automationId: parentSession?.automationId ?? null,
    automationRunId: parentSession?.automationRunId ?? null,
    managedSkillsSourceSessionId: parentId,
    launchSpec,
  };

  const admissionLease = await sessionStore.acquireChildAdmissionLease(
    parentId,
    childId,
    maxConcurrentChildren
  );
  if (!admissionLease) {
    return error(`Maximum concurrent children (${maxConcurrentChildren}) reached`, 429);
  }

  try {
    await initializeSession(env, input, ctx);
  } catch (e) {
    await sessionStore.releaseChildAdmissionLease(admissionLease);
    logger.error("Failed to initialize child session", {
      error: e instanceof Error ? e.message : String(e),
      parent_id: parentId,
      child_id: childId,
      trace_id: ctx.trace_id,
    });
    return error("Failed to create child session", 500);
  }
  await sessionStore.releaseChildAdmissionLease(admissionLease);

  let promptResponse: Response;
  try {
    const promptRequest = {
      content: body.prompt,
      authorId: spawnContext.promptAuthor.userId,
      canonicalUserId: spawnContext.promptAuthor.canonicalUserId ?? undefined,
      source: "agent",
    } satisfies EnqueuePromptRequest;

    promptResponse = await ctx.sessionRuntime.fetch(childId, SessionInternalPaths.prompt, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(promptRequest),
    });
  } catch (enqueueError) {
    logger.error("Failed to enqueue initial prompt for child session", {
      event: "session.spawn_child_prompt_enqueue_failed",
      parent_id: parentId,
      child_id: childId,
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
      error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
    });
    await sessionStore.updateStatus(childId, "failed");
    return error("Failed to enqueue child session prompt", 500);
  }

  if (!promptResponse.ok) {
    logger.error("Failed to enqueue initial prompt for child session", {
      event: "session.spawn_child_prompt_enqueue_failed",
      parent_id: parentId,
      child_id: childId,
      prompt_status: promptResponse.status,
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
    });
    await sessionStore.updateStatus(childId, "failed");
    return error("Failed to enqueue child session prompt", 500);
  }

  ctx.executionCtx.submit(
    ctx.sessionRuntime
      .fetch(parentId, SessionInternalPaths.childSessionUpdate, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          childSessionId: childId,
          status: "created",
          title: body.title,
        }),
      })
      .catch((err: unknown) => {
        logger.error("session.notify_parent_spawn.failed", { error: err });
      })
  );

  return json({ sessionId: childId, status: "created" }, 201);
}

export const sessionChildSpawnRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE, [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/children"),
    handler: handleSpawnChild,
  }),
]);
