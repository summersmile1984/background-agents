import { SessionIndexStore } from "../db/session-index";
import { SessionLaunchSpecStore } from "../db/session-launch-specs";
import { buildRuntimeCommandOptions } from "../agent-runtime/commands";
import type { Env } from "../types";
import {
  defineRoutes,
  defineRoute,
  error,
  json,
  parsePattern,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  type Route,
} from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";
import { SessionInternalPaths } from "../session/contracts";
import { resolveRuntimeLaunchDraft } from "../agent-runtime/resolver";
import type {
  RuntimeLaunchTarget,
  SessionLaunchSpecV1,
} from "@open-inspect/shared/types/runtime-launch";

function launchTarget(spec: SessionLaunchSpecV1): RuntimeLaunchTarget {
  if (spec.target.kind === "none") return { kind: "none" };
  if (spec.target.kind === "environment" && spec.target.environmentId) {
    return { kind: "environment", environmentId: spec.target.environmentId };
  }
  if (spec.target.kind === "repository-set") {
    return {
      kind: "repository-set",
      repositoryKeys: spec.target.repositories.map((repository) => repository.repositoryKey),
    };
  }
  const repository = spec.target.repositories[0];
  if (!repository) return { kind: "none" };
  return {
    kind: "repository",
    repositoryKey: repository.repositoryKey,
    branch: repository.branch,
  };
}

async function handleGetSessionRuntime(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");
  const sessions = new SessionIndexStore(ctx.db);
  const session =
    ctx.principal?.kind === "user"
      ? await sessions.getVisibleForUser(sessionId, ctx.principal.userId)
      : await sessions.get(sessionId);
  if (!session) return error("Session not found", 404);
  const launchSpec = await new SessionLaunchSpecStore(ctx.db).get(sessionId);
  let liveOptions: { models: unknown[]; efforts: unknown[] } = { models: [], efforts: [] };
  if (launchSpec) {
    try {
      const draft = await resolveRuntimeLaunchDraft({
        db: ctx.db,
        env,
        relayReady: false,
        request: {
          target: launchTarget(launchSpec),
          runtime: {
            harness: launchSpec.runtime.harness.value,
            routeId: launchSpec.runtime.routeId.value,
            model: launchSpec.runtime.model.value,
            effort: launchSpec.runtime.effort.value ?? "inherit",
            settings: Object.fromEntries(
              Object.entries(launchSpec.runtime.settings).map(([key, value]) => [key, value.value])
            ),
          },
        },
      });
      if (draft.launchable) {
        liveOptions = { models: draft.options.models, efforts: draft.options.efforts };
      }
    } catch {
      // A removed target or expired route must not make the stored session
      // uninspectable. It disables live mutation until the operator remediates
      // readiness; the immutable LaunchSpec remains visible below.
    }
  }
  const liveMutation = launchSpec
    ? {
        model: launchSpec.runtime.harness.value === "opencode" && liveOptions.models.length > 0,
        effort: launchSpec.runtime.harness.value === "opencode" && liveOptions.efforts.length > 0,
        settings: [],
      }
    : { model: false, effort: false, settings: [] };
  const response = json({
    sessionId,
    launchSpec,
    legacy: launchSpec === null,
    liveMutation,
    liveOptions,
    commands: launchSpec
      ? buildRuntimeCommandOptions({
          context: "idle-session",
          harness: launchSpec.runtime.harness.value,
          liveMutation,
        })
      : [],
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function handleExpireDraft(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");
  const sessions = new SessionIndexStore(ctx.db);
  const session =
    ctx.principal?.kind === "user"
      ? await sessions.getVisibleForUser(sessionId, ctx.principal.userId)
      : await sessions.get(sessionId);
  if (!session) return error("Session not found", 404);
  return ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.expireDraft, { method: "POST" });
}

export const sessionRuntimeRoutes: Route[] = [
  ...defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
    {
      method: "GET",
      pattern: parsePattern("/sessions/:id/runtime"),
      handler: handleGetSessionRuntime,
    },
  ]),
  defineRoute(
    SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    sessionRoute({
      method: "POST",
      pattern: parsePattern("/sessions/:id/expire-draft"),
      handler: handleExpireDraft,
    })
  ),
];
