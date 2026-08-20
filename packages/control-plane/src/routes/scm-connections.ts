import { z } from "zod";
import type {
  SourceControlConnectionDetails,
  SourceControlConnectionPreflight,
  SourceControlConnectionProbe,
} from "@open-inspect/shared/types/source-control";
import { generateId } from "../auth/crypto";
import { isDeploymentAdmin } from "../auth/deployment-admin";
import {
  DEFAULT_SCM_BACKFILL_BATCH_SIZE,
  MAX_SCM_BACKFILL_BATCH_SIZE,
  ScmRepositoryBackfillStore,
} from "../db/scm-backfill";
import {
  ScmConnectionConflictError,
  ScmConnectionCredentialStore,
  ScmConnectionStore,
  ScmConnectionValidationError,
  type ReplaceScmConnectionConfigInput,
  type ScmConnectionRecord,
} from "../db/scm-connections";
import { ScmRepositoryStore } from "../db/scm-repositories";
import { createLogger } from "../logger";
import {
  assertAllowedSourceControlUrl,
  deriveGiteaConnectionUrls,
  SourceControlUrlValidationError,
} from "../source-control/connection-config";
import {
  GITEA_CAPABILITIES,
  SourceControlConnectionRegistry,
} from "../source-control/connection-registry";
import { SourceControlProviderError } from "../source-control/errors";
import { GiteaSourceControlProvider } from "../source-control/providers/gitea-provider";
import { supportsServerSideApiAuth } from "../source-control/types";
import type { Env } from "../types";
import {
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  defineRoutes,
  error,
  json,
  parseJsonBody,
  parsePattern,
  type Route,
  type UserRouteContext,
} from "./shared";

const logger = createLogger("router:scm-connections");
const GITEA_PREFLIGHT_TIMEOUT_MS = 10_000;

const createConnectionSchema = z
  .object({
    provider: z.literal("gitea"),
    displayName: z.string().trim().min(1).max(100),
    baseUrl: z.string().trim().min(1).max(2_048),
    username: z.string().trim().min(1).max(255).optional(),
    accessToken: z.string().min(1).max(8_192),
    isDefault: z.boolean().optional(),
  })
  .strict();

const patchConnectionSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    displayName: z.string().trim().min(1).max(100).optional(),
    baseUrl: z.string().trim().min(1).max(2_048).optional(),
    username: z.string().trim().min(1).max(255).optional(),
    accessToken: z.string().min(1).max(8_192).optional(),
    enabled: z.boolean().optional(),
    isDefault: z.literal(true).optional(),
  })
  .strict();

const backfillSchema = z
  .object({
    batchSize: z.number().int().min(1).max(MAX_SCM_BACKFILL_BATCH_SIZE).optional(),
  })
  .strict();

const preflightConnectionSchema = z
  .object({
    provider: z.literal("gitea"),
    baseUrl: z.string().trim().min(1).max(2_048),
  })
  .strict();

const giteaVersionResponseSchema = z.object({ version: z.string().trim().min(1) });

function connectionId(match: RegExpMatchArray): string | Response {
  const id = match.groups?.id;
  return id ? decodeURIComponent(id) : error("Connection id is required", 400);
}

async function requireAdmin(env: Env, ctx: UserRouteContext): Promise<Response | null> {
  return (await isDeploymentAdmin(ctx.db, env, ctx.principal.userId))
    ? null
    : error("Deployment administrator access is required", 403);
}

function allowedGiteaUrls(env: Env, baseUrl: string) {
  const allowed = assertAllowedSourceControlUrl(baseUrl, env.SCM_ALLOWED_HOSTS, env.GITEA_BASE_URL);
  return deriveGiteaConnectionUrls(allowed);
}

async function runGiteaProbe(config: {
  baseUrl: string;
  apiBaseUrl: string;
  username?: string;
  accessToken: string;
}): Promise<SourceControlConnectionProbe> {
  const checkedAt = Date.now();
  // The REST probe discovers the login from the PAT. The constructor also
  // needs a Git-HTTP username, but it is not used by probe(); replace it with
  // the discovered login before persisting the connection.
  const provider = new GiteaSourceControlProvider({
    ...config,
    username: config.username ?? "token-owner",
  });
  const probe = await provider.probe();
  if (config.username && probe.login.toLowerCase() !== config.username.toLowerCase()) {
    throw new SourceControlProviderError(
      "Gitea service username does not match the authenticated token owner.",
      "permanent"
    );
  }
  return {
    status: "healthy",
    checkedAt,
    version: probe.version,
    serviceUser: probe.login,
    visibleRepositoryCount: probe.visibleRepositoryCount,
    errorCode: null,
  };
}

async function preflightGiteaConnection(
  request: Request,
  env: Env,
  ctx: UserRouteContext
): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  const raw = await parseJsonBody<unknown>(request);
  if (raw instanceof Response) return raw;
  const parsed = preflightConnectionSchema.safeParse(raw);
  if (!parsed.success) {
    return error(parsed.error.issues[0]?.message ?? "Invalid connection preflight", 400);
  }

  try {
    const urls = allowedGiteaUrls(env, parsed.data.baseUrl);
    const response = await fetch(`${urls.apiBaseUrl}/version`, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(GITEA_PREFLIGHT_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new SourceControlProviderError("Gitea version endpoint redirected.", "permanent");
    }
    if (!response.ok) {
      throw SourceControlProviderError.fromFetchError(
        `Gitea version preflight failed (${response.status}).`,
        new Error("Gitea version preflight failed"),
        response.status
      );
    }
    const version = giteaVersionResponseSchema.parse(await response.json()).version;
    const result: SourceControlConnectionPreflight = {
      status: "ready",
      ...urls,
      host: new URL(urls.baseUrl).host,
      version,
    };
    return json({ preflight: result });
  } catch (cause) {
    return mapConnectionError(cause);
  }
}

function publicConnection(
  connection: ScmConnectionRecord,
  credentialConfigured: boolean
): SourceControlConnectionDetails {
  return {
    id: connection.id,
    provider: connection.provider,
    displayName: connection.displayName,
    baseUrl: connection.baseUrl,
    apiBaseUrl: connection.apiBaseUrl,
    cloneBaseUrl: connection.cloneBaseUrl,
    authMode: connection.authMode,
    username: connection.username,
    enabled: connection.enabled,
    isDefault: connection.isDefault,
    health: connection.health,
    version: connection.version,
    revision: connection.revision,
    lastCheckedAt: connection.lastCheckedAt,
    lastErrorCode: connection.lastErrorCode,
    capabilities: connection.capabilities,
    credentialConfigured,
  };
}

async function credentialConfigured(
  store: ScmConnectionCredentialStore,
  connection: ScmConnectionRecord
): Promise<boolean> {
  return connection.credentialSource === "worker_binding"
    ? Boolean(connection.credentialRef)
    : store.has(connection.id, "service_token");
}

function mapConnectionError(cause: unknown): Response {
  if (
    cause instanceof SourceControlUrlValidationError ||
    cause instanceof ScmConnectionValidationError
  ) {
    return error(cause.message, 400);
  }
  if (cause instanceof ScmConnectionConflictError) return error(cause.message, 409);
  if (cause instanceof SourceControlProviderError) {
    if (cause.httpStatus === 401 || cause.httpStatus === 403) {
      return error("Gitea rejected the supplied service credential", 422);
    }
    if (cause.httpStatus === 429) return error("Gitea rate limited the connection test", 503);
    if (cause.errorType === "permanent") return error(cause.message, 422);
    return error("Gitea connection test is temporarily unavailable", 503);
  }
  return error("Source-control connection operation failed", 503);
}

async function listConnections(env: Env, ctx: UserRouteContext): Promise<Response> {
  const canManage = await isDeploymentAdmin(ctx.db, env, ctx.principal.userId);
  const connections = await new ScmConnectionStore(ctx.db).list({ includeDisabled: true });
  const credentials = new ScmConnectionCredentialStore(ctx.db, env.TOKEN_ENCRYPTION_KEY);
  return json({
    connections: await Promise.all(
      connections.map(async (connection) =>
        publicConnection(connection, await credentialConfigured(credentials, connection))
      )
    ),
    canManage,
  });
}

async function getConnection(
  env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const id = connectionId(match);
  if (id instanceof Response) return id;
  const store = new ScmConnectionStore(ctx.db);
  const connection = await store.get(id);
  if (!connection) return error("SCM connection was not found", 404);
  const credentials = new ScmConnectionCredentialStore(ctx.db, env.TOKEN_ENCRYPTION_KEY);
  return json({
    connection: publicConnection(connection, await credentialConfigured(credentials, connection)),
    canManage: await isDeploymentAdmin(ctx.db, env, ctx.principal.userId),
  });
}

async function createConnection(
  request: Request,
  env: Env,
  ctx: UserRouteContext
): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  const raw = await parseJsonBody<unknown>(request);
  if (raw instanceof Response) return raw;
  const parsed = createConnectionSchema.safeParse(raw);
  if (!parsed.success) {
    return error(parsed.error.issues[0]?.message ?? "Invalid connection configuration", 400);
  }

  try {
    const urls = allowedGiteaUrls(env, parsed.data.baseUrl);
    const probe = await runGiteaProbe({
      ...urls,
      username: parsed.data.username,
      accessToken: parsed.data.accessToken,
    });
    const store = new ScmConnectionStore(ctx.db);
    let existing = await store.list({ includeDisabled: true });
    if (existing.length === 0) {
      // A pre-connection deployment may already contain GitHub sessions and
      // settings. Materialize that authority before accepting a second forge.
      await new SourceControlConnectionRegistry(env, { db: ctx.db }).getDefaultConnection();
      existing = await store.list({ includeDisabled: true });
    }
    if (existing.length > 0) {
      const defaultConnection = existing.find((connection) => connection.isDefault) ?? existing[0];
      const preflight = await new ScmRepositoryBackfillStore(ctx.db).preflight(
        defaultConnection.id
      );
      if (!preflight.readyForSecondConnection) {
        return json(
          {
            error:
              "Legacy source-control records must be backfilled before adding another connection.",
            code: "SCM_MIGRATION_REQUIRED",
            preflight,
          },
          409
        );
      }
    }
    const connection = await store.createWithEncryptedServiceCredential(
      {
        id: `scm_${generateId()}`,
        provider: "gitea",
        displayName: parsed.data.displayName,
        ...urls,
        authMode: "pat",
        credentialSource: "encrypted_d1",
        username: probe.serviceUser,
        capabilities: GITEA_CAPABILITIES,
        enabled: true,
        isDefault: parsed.data.isDefault === true || existing.length === 0,
        createdBy: ctx.principal.userId,
      },
      parsed.data.accessToken,
      env.TOKEN_ENCRYPTION_KEY
    );
    await store.recordHealth(connection.id, {
      version: probe.version,
      checkedAt: probe.checkedAt,
      errorCode: null,
    });
    const refreshed = (await store.get(connection.id))!;
    logger.info("scm_connection.created", {
      event: "scm_connection.created",
      connection_id: refreshed.id,
      provider: refreshed.provider,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ connection: publicConnection(refreshed, true), probe }, 201);
  } catch (cause) {
    logger.warn("SCM connection creation rejected", {
      event: "scm_connection.create_rejected",
      error_type: cause instanceof Error ? cause.name : "unknown",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return mapConnectionError(cause);
  }
}

function repositoryWebUrl(baseUrl: string, owner: string, name: string): string {
  const encodedPath = [...owner.split("/"), name].map(encodeURIComponent).join("/");
  return `${baseUrl.replace(/\/+$/, "")}/${encodedPath}`;
}

async function migrationPreflight(env: Env, ctx: UserRouteContext): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  try {
    const resolved = await new SourceControlConnectionRegistry(env, {
      db: ctx.db,
    }).getDefaultConnection();
    const preflight = await new ScmRepositoryBackfillStore(ctx.db).preflight(
      resolved.connection.id
    );
    return json({ defaultConnectionId: resolved.connection.id, preflight });
  } catch (cause) {
    logger.warn("SCM migration preflight failed", {
      event: "scm_migration.preflight_failed",
      error: cause instanceof Error ? cause.message : String(cause),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("SCM migration preflight is unavailable", 503);
  }
}

async function runBackfill(request: Request, env: Env, ctx: UserRouteContext): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  const raw = await parseJsonBody<unknown>(request);
  if (raw instanceof Response) return raw;
  const parsed = backfillSchema.safeParse(raw ?? {});
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid batch", 400);

  const batchSize = parsed.data.batchSize ?? DEFAULT_SCM_BACKFILL_BATCH_SIZE;
  const leaseOwner = `worker_${generateId()}`;
  const backfill = new ScmRepositoryBackfillStore(ctx.db);
  if (!(await backfill.acquireLease(leaseOwner))) {
    return json({ error: "SCM backfill is already running", code: "SCM_BACKFILL_BUSY" }, 409);
  }

  try {
    const resolved = await new SourceControlConnectionRegistry(env, {
      db: ctx.db,
    }).getDefaultConnection();
    const { connection, provider } = resolved;
    const state = await backfill.getJobState();
    const locations = await backfill.listLegacyLocations(
      connection.id,
      state?.cursor ?? null,
      batchSize
    );
    const repositories = new ScmRepositoryStore(ctx.db);
    let unresolved = 0;
    for (const location of locations) {
      let repository = await repositories.getByPath(connection.id, location.owner, location.name);
      if (!repository) {
        try {
          if (!supportsServerSideApiAuth(provider)) {
            throw new SourceControlProviderError(
              "The default source-control provider has no service API authority.",
              "permanent"
            );
          }
          const auth = await provider.getServiceApiAuthorization();
          const upstream = await provider.getRepository(auth, {
            owner: location.owner,
            name: location.name,
          });
          const webUrl = repositoryWebUrl(connection.baseUrl, upstream.owner, upstream.name);
          repository = await repositories.upsertResolved({
            connectionId: connection.id,
            externalId: String(upstream.providerRepoId),
            owner: upstream.owner,
            name: upstream.name,
            defaultBranch: upstream.defaultBranch,
            webUrl,
            cloneUrl: `${webUrl}.git`,
            private: upstream.isPrivate,
            archived: false,
          });
        } catch (cause) {
          if (!(cause instanceof SourceControlProviderError) || cause.httpStatus !== 404) {
            throw cause;
          }
          repository = await repositories.createUnresolvedLegacy({
            connectionId: connection.id,
            owner: location.owner,
            name: location.name,
          });
        }
      }
      if (repository.resolutionStatus !== "resolved") unresolved += 1;
      await backfill.applyRepositoryMapping({
        connectionId: connection.id,
        repositoryId: repository.id,
        owner: location.owner,
        name: location.name,
      });
    }

    const cursor = locations.at(-1)?.pathKey ?? state?.cursor ?? null;
    const hasMore = cursor
      ? (await backfill.listLegacyLocations(connection.id, cursor, 1)).length > 0
      : false;
    await backfill.checkpoint({
      leaseOwner,
      cursor,
      processed: locations.length,
      unresolved,
      complete: !hasMore,
    });
    const preflight = await backfill.preflight(connection.id);
    return json({
      processed: locations.length,
      unresolved,
      hasMore,
      preflight,
    });
  } catch (cause) {
    await backfill.fail(
      leaseOwner,
      cause instanceof SourceControlProviderError
        ? "SCM_UPSTREAM_BACKFILL_FAILED"
        : "SCM_BACKFILL_FAILED"
    );
    logger.error("SCM repository backfill failed", {
      event: "scm_migration.backfill_failed",
      error: cause instanceof Error ? cause.message : String(cause),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("SCM repository backfill failed", 503);
  }
}

async function patchConnection(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  const id = connectionId(match);
  if (id instanceof Response) return id;
  const raw = await parseJsonBody<unknown>(request);
  if (raw instanceof Response) return raw;
  const parsed = patchConnectionSchema.safeParse(raw);
  if (!parsed.success) {
    return error(parsed.error.issues[0]?.message ?? "Invalid connection configuration", 400);
  }

  const store = new ScmConnectionStore(ctx.db);
  const credentials = new ScmConnectionCredentialStore(ctx.db, env.TOKEN_ENCRYPTION_KEY);
  const current = await store.get(id);
  if (!current) return error("SCM connection was not found", 404);
  if (current.provider !== "gitea" || current.authMode !== "pat") {
    return error("Only Gitea PAT connections can be edited through this route", 422);
  }

  if ((parsed.data.enabled === true && !current.enabled) || parsed.data.isDefault === true) {
    const connections = await store.list({ includeDisabled: true });
    const authority =
      connections.find((connection) => connection.isDefault && connection.id !== current.id) ??
      connections.find((connection) => connection.id !== current.id);
    if (authority) {
      const preflight = await new ScmRepositoryBackfillStore(ctx.db).preflight(authority.id);
      if (!preflight.readyForSecondConnection) {
        return json(
          {
            error:
              "Legacy source-control records must be backfilled before enabling another connection.",
            code: "SCM_MIGRATION_REQUIRED",
            preflight,
          },
          409
        );
      }
    }
  }

  try {
    const secret = parsed.data.accessToken ?? (await credentials.get(id, "service_token"))?.secret;
    if (!secret) return error("SCM connection has no usable service credential", 422);
    const urls = allowedGiteaUrls(env, parsed.data.baseUrl ?? current.baseUrl);
    const probe = await runGiteaProbe({
      ...urls,
      username: parsed.data.username,
      accessToken: secret,
    });
    const replacement: ReplaceScmConnectionConfigInput = {
      expectedRevision: parsed.data.expectedRevision,
      provider: "gitea",
      displayName: parsed.data.displayName ?? current.displayName,
      ...urls,
      authMode: "pat",
      credentialSource: "encrypted_d1",
      username: probe.serviceUser,
      capabilities: GITEA_CAPABILITIES,
      enabled: parsed.data.enabled ?? current.enabled,
    };
    if (parsed.data.accessToken) {
      await store.replaceConfigWithEncryptedServiceCredential(
        id,
        replacement,
        parsed.data.accessToken,
        env.TOKEN_ENCRYPTION_KEY
      );
    } else {
      await store.replaceConfig(id, replacement);
    }
    if (parsed.data.isDefault) await store.setDefault(id);
    await store.recordHealth(id, {
      version: probe.version,
      checkedAt: probe.checkedAt,
      errorCode: null,
    });
    const refreshed = (await store.get(id))!;
    logger.info("scm_connection.updated", {
      event: "scm_connection.updated",
      connection_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ connection: publicConnection(refreshed, true), probe });
  } catch (cause) {
    return mapConnectionError(cause);
  }
}

async function testConnection(
  env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  const id = connectionId(match);
  if (id instanceof Response) return id;
  const store = new ScmConnectionStore(ctx.db);
  const connection = await store.get(id);
  if (!connection) return error("SCM connection was not found", 404);
  if (connection.provider !== "gitea" || !connection.username) {
    return error("Connection testing is not implemented for this provider", 422);
  }

  try {
    const credential = await new ScmConnectionCredentialStore(ctx.db, env.TOKEN_ENCRYPTION_KEY).get(
      id,
      "service_token"
    );
    if (!credential?.secret) return error("SCM connection has no usable service credential", 422);
    const probe = await runGiteaProbe({
      baseUrl: connection.baseUrl,
      apiBaseUrl: connection.apiBaseUrl,
      username: connection.username,
      accessToken: credential.secret,
    });
    await store.recordHealth(id, {
      version: probe.version,
      checkedAt: probe.checkedAt,
      errorCode: null,
    });
    return json({ probe });
  } catch (cause) {
    const checkedAt = Date.now();
    const errorCode =
      cause instanceof SourceControlProviderError &&
      (cause.httpStatus === 401 || cause.httpStatus === 403)
        ? "SCM_AUTH_FAILED"
        : "SCM_CONNECTION_UNHEALTHY";
    await store.recordHealth(id, { checkedAt, errorCode });
    return mapConnectionError(cause);
  }
}

async function disableConnection(
  env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  const id = connectionId(match);
  if (id instanceof Response) return id;
  const disabled = await new ScmConnectionStore(ctx.db).disable(id);
  return disabled ? json({ status: "disabled", id }) : error("SCM connection was not found", 404);
}

export const scmConnectionRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_HUMAN_USER_ROUTE, [
  {
    method: "GET",
    pattern: parsePattern("/scm/migration/preflight"),
    handler: async (_request, env, _match, ctx) => migrationPreflight(env, ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/scm/migration/backfill"),
    handler: async (request, env, _match, ctx) => runBackfill(request, env, ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/scm/connections/preflight"),
    handler: async (request, env, _match, ctx) => preflightGiteaConnection(request, env, ctx),
  },
  {
    method: "GET",
    pattern: parsePattern("/scm/connections"),
    handler: async (_request, env, _match, ctx) => listConnections(env, ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/scm/connections"),
    handler: async (request, env, _match, ctx) => createConnection(request, env, ctx),
  },
  {
    method: "GET",
    pattern: parsePattern("/scm/connections/:id"),
    handler: async (_request, env, match, ctx) => getConnection(env, match, ctx),
  },
  {
    method: "PATCH",
    pattern: parsePattern("/scm/connections/:id"),
    handler: async (request, env, match, ctx) => patchConnection(request, env, match, ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/scm/connections/:id/test"),
    handler: async (_request, env, match, ctx) => testConnection(env, match, ctx),
  },
  {
    method: "POST",
    pattern: parsePattern("/scm/connections/:id/disable"),
    handler: async (_request, env, match, ctx) => disableConnection(env, match, ctx),
  },
]);
