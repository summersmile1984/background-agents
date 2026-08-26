import type { RepositoryRef, RepositoryPair } from "@open-inspect/shared/types/repositories";
import { getValidModelOrDefault, isValidReasoningEffort } from "@open-inspect/shared/models";
import type {
  CreateSessionInput,
  CreateSessionResponse,
} from "@open-inspect/shared/types/session-api";
import type {
  ResolveRuntimeLaunchDraftResponse,
  RuntimeLaunchTarget,
  SessionLaunchSpecV1,
} from "@open-inspect/shared/types/runtime-launch";
import type { AgentHarness } from "@open-inspect/shared/types/agent-harness";
import { generateId } from "../auth/crypto";
import { resolveGitHubCredentialAuthority } from "../source-control/github-credential-authority";
import { applyIdentityEnforcement, resolveCanonicalUserId } from "../auth/identity-enforcement";
import {
  resolveEnvironmentRepositorySet,
  resolveSessionRepositories,
  resolveSessionRepositoryKeys,
} from "../repos/resolve";
import { resolveScmProviderFromEnv } from "../source-control";
import { EnvironmentStore } from "../db/environments";
import { ScmConnectionStore } from "../db/scm-connections";
import { ScmRepositoryStore } from "../db/scm-repositories";
import { AgentRuntimePreferencesStore } from "../db/agent-runtime-preferences";
import { UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import { parseCreateSessionInput } from "../session/create-session-input";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import { resolveAgentHarness } from "../session/agent-harness";
import {
  AgentRuntimeSelectionError,
  assertAgentRuntimeSelection,
} from "../agent-runtime/selection";
import { resolveRuntimeLaunchDraft, RuntimeLaunchResolutionError } from "../agent-runtime/resolver";
import { createSessionLaunchSpec } from "../agent-runtime/launch-spec";
import { resolveGitHubEnrichmentForRequest } from "../session/identity";
import { resolveSessionScopedSettings } from "../session/integration-settings-resolution";
import { resolveManagedSkills, SkillResolutionError } from "../session/skill-resolution";
import type { Env } from "../types";
import {
  normalizeOptionalRepositoryPair,
  RepositoryPairValidationError,
} from "@open-inspect/shared/types/repositories";
import {
  error,
  json,
  parsePattern,
  resolveRepoOrError,
  type RequestContext,
  type Route,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  defineRoutes,
} from "./shared";

const logger = createLogger("router:session-create");
const INVALID_SESSION_REQUEST_BODY_ERROR = "Invalid session request body";

// Defense in depth on top of schema validation — matches git ref charsets.
const BRANCH_NAME_PATTERN = /^[\w.\-/]+$/;

function runtimeTargetFromBody(
  body: CreateSessionInput,
  resolvedRepositoryKey: string | null
): RuntimeLaunchTarget | null {
  if (body.repositoryKey) {
    return {
      kind: "repository",
      repositoryKey: body.repositoryKey,
      ...(body.branch ? { branch: body.branch } : {}),
    };
  }
  if (body.repositoryKeys) return { kind: "repository-set", repositoryKeys: body.repositoryKeys };
  if (body.environmentId) return { kind: "environment", environmentId: body.environmentId };
  if (resolvedRepositoryKey) {
    return {
      kind: "repository",
      repositoryKey: resolvedRepositoryKey,
      ...(body.branch ? { branch: body.branch } : {}),
    };
  }
  if (!body.repoOwner && !body.repoName && !body.repositories) return { kind: "none" };
  return null;
}

function callerChannel(
  ctx: RequestContext,
  provider: SessionLaunchSpecV1["target"]["provider"]
): SessionLaunchSpecV1["caller"]["channel"] {
  if (ctx.principal?.kind === "user" || ctx.principal?.kind !== "service") return "web";
  if (ctx.principal.service === "slack-bot") return "slack";
  if (ctx.principal.service === "feishu-bot") return "feishu";
  if (ctx.principal.service === "linear-bot") return "linear";
  if (ctx.principal.service === "github-bot") return provider === "gitea" ? "gitea" : "github";
  return "web";
}

async function handleCreateSession(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const parsed = await parseCreateSessionInput(request);
  if (!parsed.ok) return error(parsed.message, 400);
  const body = parsed.input;

  // Identity comes from the verified principal; caller-asserted identity/SCM
  // body fields are rejected. SCM credentials flow only through
  // server-side enrichment from the token store.
  const enforcement = applyIdentityEnforcement(ctx, "session-create", parsed.raw);
  if (enforcement.rejection) return enforcement.rejection;
  const enforced = enforcement.enforced;

  let repositoryContext: RepositoryPair | null;
  try {
    repositoryContext = normalizeOptionalRepositoryPair(body, INVALID_SESSION_REQUEST_BODY_ERROR);
  } catch (e) {
    if (e instanceof RepositoryPairValidationError) {
      return error(e.message, 400);
    }
    throw e;
  }

  // Validate branch names if provided (defense in depth)
  if (body.branch && !BRANCH_NAME_PATTERN.test(body.branch)) {
    return error("Invalid branch name");
  }
  for (const entry of body.repositories ?? []) {
    if (entry.baseBranch && !BRANCH_NAME_PATTERN.test(entry.baseBranch)) {
      return error(`Invalid branch name for ${entry.repoOwner}/${entry.repoName}`);
    }
  }

  let repoId: number | null = null;
  let defaultBranch: string | null = null;
  let repoOwner: string | null = null;
  let repoName: string | null = null;
  let repositories: RepositoryRef[] | undefined;
  let environmentId: string | null = null;
  let scmConnectionId: string | null = null;
  let repositoryKey: string | null = null;
  // Environment and ad-hoc list modes both produce a resolved member list;
  // scalar mode stays a single lookup. The three are mutually exclusive by
  // schema (hasExclusiveSessionTarget).
  if (body.repositoryKey || body.repositoryKeys) {
    const repositoryKeys = body.repositoryKeys ?? [body.repositoryKey!];
    const resolvedSet = await resolveSessionRepositoryKeys(
      env,
      repositoryKeys,
      ctx,
      logger,
      body.branch
    );
    repositories = resolvedSet.repositories;
    scmConnectionId = resolvedSet.connectionId;
  } else if (body.environmentId) {
    // Snapshot the environment's members and resolve them like any other list
    // (design §7.6); environment_id records provenance on the session.
    const environmentSet = await resolveEnvironmentRepositorySet(
      env,
      new EnvironmentStore(ctx.db),
      body.environmentId,
      ctx,
      logger
    );
    repositories = environmentSet.repositories;
    scmConnectionId = environmentSet.connectionId;
    environmentId = body.environmentId;
  } else if (body.repositories) {
    repositories = await resolveSessionRepositories(env, body.repositories, ctx, logger);
  }

  if (repositories) {
    // The primary entry is mirrored into the scalar columns so filters,
    // settings resolution, and pre-list consumers keep working unchanged.
    const primary = repositories[0];
    repoOwner = primary.repoOwner;
    repoName = primary.repoName;
    repoId = primary.repoId;
    defaultBranch = primary.baseBranch;
    repositoryKey = primary.repositoryKey ?? null;
    scmConnectionId = primary.connectionId ?? scmConnectionId;
  } else if (repositoryContext) {
    repoOwner = repositoryContext.repoOwner;
    repoName = repositoryContext.repoName;
    const resolved = await resolveRepoOrError(env, repoOwner, repoName, ctx, logger);

    repoId = resolved.repoId;
    defaultBranch = resolved.defaultBranch;

    // Upgrade legacy owner/name producers (GitHub bot, Linear, old Slack
    // messages) to the stable repository identity whenever the deployment
    // catalog identifies exactly one matching connection. Ambiguity fails
    // back to the explicitly-marked legacy path instead of guessing between
    // GitHub and Gitea repositories with the same path.
    const expectedProvider =
      ctx.principal?.kind === "service" && ctx.principal.service === "github-bot"
        ? "github"
        : resolveScmProviderFromEnv(env.SCM_PROVIDER);
    const connectionStore = new ScmConnectionStore(ctx.db);
    const catalog = new ScmRepositoryStore(ctx.db);
    const candidates = (
      await Promise.all(
        (await connectionStore.list())
          .filter((connection) => connection.provider === expectedProvider)
          .map((connection) => catalog.getByPath(connection.id, repoOwner!, repoName!))
      )
    ).filter(
      (candidate) =>
        candidate?.resolutionStatus === "resolved" &&
        candidate.removedAt == null &&
        candidate.externalId === String(repoId)
    );
    if (candidates.length === 1) {
      const stable = candidates[0]!;
      repositoryKey = stable.id;
      scmConnectionId = stable.connectionId;
      repositories = [
        {
          repositoryKey: stable.id,
          connectionId: stable.connectionId,
          repoOwner,
          repoName,
          repoId,
          baseBranch: body.branch || defaultBranch || "main",
        },
      ];
    }
  }

  const participantUserId = enforced.participantUserId;
  const spawnSource = enforced.spawnSource ?? undefined;

  // Resolve canonical user model ID (for D1 session index) from the verified
  // principal, failing closed; body display fields stay cosmetic.
  const userStore = new UserStore(ctx.db);
  const resolution = await resolveCanonicalUserId(userStore, ctx, enforced, {
    displayName: body.actorDisplayName,
    email: body.actorEmail,
    avatarUrl: body.actorAvatarUrl,
  });
  if (resolution instanceof Response) return resolution;
  const resolvedUserId = resolution.userId;

  const selectedConnection = scmConnectionId
    ? await new ScmConnectionStore(ctx.db).get(scmConnectionId)
    : null;
  const githubDeployment = selectedConnection
    ? selectedConnection.provider === "github"
    : resolveScmProviderFromEnv(env.SCM_PROVIDER) === "github";
  let scmLogin = body.scmLogin;
  let scmName = body.scmName;
  let scmEmail = body.scmEmail;
  // SCM credentials never arrive in the body; enrichment below fills them
  // from the token store via the canonical user.
  let scmTokenExpiresAt: number | undefined;
  let scmUserId: string | undefined;
  let scmTokenEncrypted: string | null = null;
  let scmRefreshTokenEncrypted: string | null = null;

  // Browser sessions resolve a linked GitHub identity/token through Better
  // Auth only when SCM enrichment is needed. Transitional callers retain the
  // legacy D1 lookup. A user without a linked GitHub account uses the GitHub
  // App bot fallback; account linking is intentionally deferred.
  if (githubDeployment) {
    try {
      const enrichment = await resolveGitHubEnrichmentForRequest(
        env,
        ctx.db,
        userStore,
        resolvedUserId,
        await resolveGitHubCredentialAuthority(ctx, request.headers)
      );
      if (enrichment) {
        scmUserId = enrichment.scmUserId;
        scmLogin ??= enrichment.scmLogin;
        scmName ??= enrichment.displayName;
        scmEmail ??= enrichment.email;
        scmTokenEncrypted = enrichment.accessTokenEncrypted ?? null;
        scmRefreshTokenEncrypted = enrichment.refreshTokenEncrypted ?? null;
        scmTokenExpiresAt = enrichment.tokenExpiresAt;
      }
    } catch (e) {
      logger.warn("Failed to enrich session with GitHub identity", {
        error: e instanceof Error ? e : String(e),
      });
    }
  }

  // Stable targets use the same target-aware resolver as the UI. Creation is
  // authoritative: it rechecks readiness and rejects a stale draft digest
  // rather than silently changing model, route, effort, or harness.
  const runtimeTarget = runtimeTargetFromBody(body, repositoryKey);
  let resolvedRuntimeDraft: ResolveRuntimeLaunchDraftResponse | null = null;
  let model: string;
  let reasoningEffort: string | null;
  let agentHarness: AgentHarness;
  if (runtimeTarget) {
    try {
      resolvedRuntimeDraft = await resolveRuntimeLaunchDraft({
        db: ctx.db,
        env,
        relayReady: false,
        configurationOwners: [
          ...(callerChannel(ctx, selectedConnection?.provider ?? null) === "web"
            ? []
            : [
                {
                  scope: "integration" as const,
                  id: callerChannel(ctx, selectedConnection?.provider ?? null),
                },
              ]),
          ...(participantUserId
            ? [{ scope: "user" as const, id: participantUserId }]
            : resolvedUserId
              ? [{ scope: "user" as const, id: resolvedUserId }]
              : []),
        ],
        request: {
          target: runtimeTarget,
          runtime: body.runtime ?? {
            ...(body.agentHarness ? { harness: body.agentHarness } : {}),
            ...(body.model ? { model: body.model } : {}),
            ...(body.reasoningEffort ? { effort: body.reasoningEffort } : {}),
          },
        },
      });
    } catch (cause) {
      if (cause instanceof RuntimeLaunchResolutionError) {
        return json({ error: cause.message, code: cause.code }, cause.status);
      }
      throw cause;
    }
    if (!resolvedRuntimeDraft.launchable) {
      const issue = resolvedRuntimeDraft.issues.find((candidate) => candidate.severity === "error");
      return json(
        {
          error: issue?.message ?? "Runtime configuration is not launchable",
          code: issue?.code ?? "ROUTE_NOT_READY",
        },
        409
      );
    }
    if (body.runtimeDraftDigest && body.runtimeDraftDigest !== resolvedRuntimeDraft.draftDigest) {
      return json(
        {
          error:
            "Runtime capabilities changed after this draft was resolved; review the updated selection",
          code: "CAPABILITY_CHANGED",
          draft: resolvedRuntimeDraft,
        },
        409
      );
    }
    model = resolvedRuntimeDraft.effective.model!.value;
    reasoningEffort = resolvedRuntimeDraft.effective.effort!.value;
    agentHarness = resolvedRuntimeDraft.effective.harness!.value;
  } else {
    // Compatibility path for legacy owner/name callers. Bot and automation
    // producers are migrated to stable repository keys in the following phase.
    model = getValidModelOrDefault(body.model);
    reasoningEffort =
      body.reasoningEffort && isValidReasoningEffort(model, body.reasoningEffort)
        ? body.reasoningEffort
        : null;
    agentHarness = await resolveAgentHarness({
      requested: body.agentHarness,
      environmentId,
      environmentStore: new EnvironmentStore(ctx.db),
      runtimePreferencesStore: new AgentRuntimePreferencesStore(ctx.db),
      deploymentDefault: env.DEFAULT_AGENT_HARNESS,
    });
    try {
      await assertAgentRuntimeSelection({
        db: ctx.db,
        env,
        harness: agentHarness,
        model,
        target: {
          environmentId,
          repositories,
          repoId,
        },
      });
    } catch (cause) {
      if (cause instanceof AgentRuntimeSelectionError) {
        return json({ error: cause.message, code: cause.code }, 409);
      }
      throw cause;
    }
  }

  // Session-scoped integration settings resolve from the primary member (design
  // §6.2). In list mode that is repositories[0]; otherwise the scalar pair — the
  // two are the same repo by the row-0-mirrors-scalars invariant. Launching
  // from a saved environment layers its overrides on top (design §13.5).
  const scopeMembers =
    repositories ??
    (repoOwner && repoName
      ? [{ repoOwner, repoName, repositoryKey, connectionId: scmConnectionId }]
      : []);
  const { codeServerEnabled, vncEnabled, sandboxSettings } = await resolveSessionScopedSettings(
    ctx.db,
    scopeMembers,
    environmentId
  );

  const sessionId = generateId();

  let managedSkillsManifest;
  try {
    managedSkillsManifest = await resolveManagedSkills(
      ctx.db,
      {
        repositories: scopeMembers,
        environmentId,
      },
      body.skillSelection ?? { mode: "all" },
      resolvedUserId
    );
  } catch (e) {
    if (e instanceof SkillResolutionError) return error(e.message, e.status);
    throw e;
  }

  const launchSpec = resolvedRuntimeDraft
    ? createSessionLaunchSpec({
        resolved: resolvedRuntimeDraft,
        skillsManifestId: managedSkillsManifest.manifestSha256,
        caller: (() => {
          const channel = callerChannel(ctx, resolvedRuntimeDraft.effective.target.provider);
          return {
            channel,
            canonicalUserId: resolvedUserId,
            integrationId: channel === "web" ? null : channel,
          };
        })(),
      })
    : undefined;

  const input: SessionInitInput = {
    sessionId,
    repoOwner,
    repoName,
    repoId,
    repositoryId: repositoryKey,
    scmConnectionId,
    defaultBranch,
    branch: body.branch,
    repositories,
    environmentId,
    title: body.title,
    model,
    reasoningEffort,
    agentHarness,
    participantUserId,
    platformUserId: resolvedUserId,
    scmLogin,
    scmName,
    scmEmail,
    scmUserId,
    scmTokenEncrypted,
    scmRefreshTokenEncrypted,
    scmTokenExpiresAt,
    codeServerEnabled,
    vncEnabled,
    sandboxSettings,
    spawnSource,
    managedSkillsManifest,
    launchSpec,
  };

  try {
    await initializeSession(env, input, ctx);
  } catch (e) {
    logger.error("Failed to initialize session", {
      error: e instanceof Error ? e.message : String(e),
      session_id: sessionId,
      trace_id: ctx.trace_id,
    });
    return error("Failed to create session", 500);
  }

  const result: CreateSessionResponse = {
    sessionId,
    status: "created",
    visualVerificationEnabled: sandboxSettings.visualVerification?.enabled === true,
  };

  return json(result, 201);
}

export const sessionCreateRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
  {
    method: "POST",
    pattern: parsePattern("/sessions"),
    handler: handleCreateSession,
  },
]);
