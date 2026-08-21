import {
  persistedRuntimeConfigurationScopeSchema,
  runtimeConfigFragmentSchema,
  type PersistedRuntimeConfigurationScope,
} from "@open-inspect/shared/types/runtime-launch";
import { isDeploymentAdmin } from "../auth/deployment-admin";
import { EnvironmentStore } from "../db/environments";
import {
  RuntimeConfigurationStore,
  RuntimeConfigurationValidationError,
} from "../db/runtime-configurations";
import { ScmRepositoryStore } from "../db/scm-repositories";
import type { Env } from "../types";
import { agentHarnessSchema } from "@open-inspect/shared/types/agent-harness";
import { validateRuntimeConfigurationSettings } from "../agent-runtime/capabilities";
import { resolveRuntimeLaunchDraft, RuntimeLaunchResolutionError } from "../agent-runtime/resolver";
import {
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  defineRoutes,
  error,
  json,
  parseJsonBody,
  parsePattern,
  type RequestContext,
  type Route,
} from "./shared";

const INSTALLATION_SCOPE_ID = "global";
const INTEGRATION_SCOPE_IDS = new Set(["slack", "github", "gitea", "linear"]);

function scopeParams(
  match: RegExpMatchArray
): { scope: PersistedRuntimeConfigurationScope; scopeId: string } | Response {
  const parsedScope = persistedRuntimeConfigurationScopeSchema.safeParse(match.groups?.scope);
  const encodedScopeId = match.groups?.scopeId;
  if (!parsedScope.success || !encodedScopeId) return error("Runtime configuration not found", 404);
  let scopeId: string;
  try {
    scopeId = decodeURIComponent(encodedScopeId).trim();
  } catch {
    return error("Invalid runtime configuration scope id", 400);
  }
  if (!scopeId || scopeId.length > 256) return error("Invalid runtime configuration scope id", 400);
  return { scope: parsedScope.data, scopeId };
}

async function authorized(
  env: Env,
  ctx: RequestContext,
  scope: PersistedRuntimeConfigurationScope,
  scopeId: string,
  write: boolean
): Promise<Response | null> {
  if (scope === "user") {
    const ownsScope =
      (ctx.principal?.kind === "user" && ctx.principal.userId === scopeId) ||
      (ctx.principal?.kind === "service" && ctx.principal.actor?.participantUserId === scopeId);
    if (ownsScope) return null;
    if (
      ctx.principal?.kind === "user" &&
      (await isDeploymentAdmin(ctx.db, env, ctx.principal.userId))
    ) {
      return null;
    }
    return error("Runtime preference access denied", 403);
  }
  if (ctx.principal?.kind !== "user") return error("Administrator access is required", 403);
  if (!(await isDeploymentAdmin(ctx.db, env, ctx.principal.userId))) {
    return error("Deployment administrator access is required", 403);
  }
  if (scope === "installation" && scopeId !== INSTALLATION_SCOPE_ID) {
    return error("Installation runtime configuration must use the global scope", 400);
  }
  if (scope === "integration" && !INTEGRATION_SCOPE_IDS.has(scopeId)) {
    return error("Unknown integration runtime configuration", 404);
  }
  void write;
  return null;
}

async function assertScopeExists(
  ctx: RequestContext,
  scope: PersistedRuntimeConfigurationScope,
  scopeId: string
): Promise<Response | null> {
  if (scope === "repository" && !(await new ScmRepositoryStore(ctx.db).get(scopeId))) {
    return error("Repository not found", 404);
  }
  if (scope === "environment" && !(await new EnvironmentStore(ctx.db).getById(scopeId))) {
    return error("Environment not found", 404);
  }
  return null;
}

async function getConfiguration(
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const params = scopeParams(match);
  if (params instanceof Response) return params;
  const rejection = await authorized(env, ctx, params.scope, params.scopeId, false);
  if (rejection) return rejection;
  const config = await new RuntimeConfigurationStore(ctx.db).get(params.scope, params.scopeId);
  return json({ configuration: config });
}

async function putConfiguration(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const params = scopeParams(match);
  if (params instanceof Response) return params;
  const rejection = await authorized(env, ctx, params.scope, params.scopeId, true);
  if (rejection) return rejection;
  const missing = await assertScopeExists(ctx, params.scope, params.scopeId);
  if (missing) return missing;
  const body = await parseJsonBody<{ config?: unknown }>(request);
  if (body instanceof Response) return body;
  const parsed = runtimeConfigFragmentSchema.safeParse(body.config);
  if (!parsed.success)
    return error(parsed.error.issues[0]?.message ?? "Invalid runtime configuration", 400);
  if (parsed.data.settings && Object.keys(parsed.data.settings).length > 0) {
    const harness = agentHarnessSchema.safeParse(parsed.data.harness);
    if (!harness.success) {
      return error("Choose a concrete harness before saving harness settings", 400);
    }
    const settingsError = validateRuntimeConfigurationSettings({
      harness: harness.data,
      scope: params.scope,
      settings: parsed.data.settings,
    });
    if (settingsError) return error(settingsError, 400);
  }
  if (params.scope === "repository" || params.scope === "environment") {
    try {
      const resolved = await resolveRuntimeLaunchDraft({
        db: ctx.db,
        env,
        relayReady: false,
        request: {
          target:
            params.scope === "repository"
              ? { kind: "repository", repositoryKey: params.scopeId }
              : { kind: "environment", environmentId: params.scopeId },
          runtime: parsed.data,
        },
      });
      if (!resolved.launchable) {
        const issue = resolved.issues.find((candidate) => candidate.severity === "error");
        return json(
          {
            error: issue?.message ?? "Runtime configuration is not launchable for this target",
            code: issue?.code ?? "ROUTE_NOT_READY",
            field: issue?.field ?? "harness",
          },
          409
        );
      }
    } catch (cause) {
      if (cause instanceof RuntimeLaunchResolutionError) {
        return json({ error: cause.message, code: cause.code }, cause.status);
      }
      throw cause;
    }
  }
  try {
    const configuration = await new RuntimeConfigurationStore(ctx.db).set({
      ...params,
      config: parsed.data,
      createdBy:
        ctx.principal?.kind === "user"
          ? ctx.principal.userId
          : ctx.principal?.kind === "service"
            ? (ctx.principal.actor?.participantUserId ?? null)
            : null,
    });
    return json({ status: "updated", configuration });
  } catch (cause) {
    if (cause instanceof RuntimeConfigurationValidationError) return error(cause.message, 400);
    throw cause;
  }
}

async function deleteConfiguration(
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const params = scopeParams(match);
  if (params instanceof Response) return params;
  const rejection = await authorized(env, ctx, params.scope, params.scopeId, true);
  if (rejection) return rejection;
  const deleted = await new RuntimeConfigurationStore(ctx.db).delete(params.scope, params.scopeId);
  return deleted ? json({ status: "deleted" }) : error("Runtime configuration not found", 404);
}

export const runtimeConfigurationRoutes: Route[] = defineRoutes(
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  [
    {
      method: "GET",
      pattern: parsePattern("/agent-runtime/configurations/:scope/:scopeId"),
      handler: async (_request, env, match, ctx) => getConfiguration(env, match, ctx),
    },
    {
      method: "PUT",
      pattern: parsePattern("/agent-runtime/configurations/:scope/:scopeId"),
      handler: putConfiguration,
    },
    {
      method: "DELETE",
      pattern: parsePattern("/agent-runtime/configurations/:scope/:scopeId"),
      handler: async (_request, env, match, ctx) => deleteConfiguration(env, match, ctx),
    },
  ]
);
