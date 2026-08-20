/**
 * Repository listing and metadata routes and handlers.
 */

import { RepoMetadataStore } from "../db/repo-metadata";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import {
  repoMetadataSchema,
  type EnrichedRepository,
  type InstallationRepository,
} from "@open-inspect/shared/types/repository-catalog";
import type { ScmConnectionRecord } from "../db/scm-connections";
import { ScmConnectionCredentialStore, ScmConnectionStore } from "../db/scm-connections";
import { ScmRepositoryStore } from "../db/scm-repositories";
import { SourceControlProviderError } from "../source-control";
import { SourceControlConnectionRegistry } from "../source-control/connection-registry";
import { createLogger } from "../logger";
import {
  type Route,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  defineRoutes,
  type RequestContext,
  parsePattern,
  json,
  error,
  extractRepoParams,
} from "./shared";

const logger = createLogger("router:repos");

const REPOS_CACHE_KEY = "repos:list:v2";
const CONNECTION_REPOS_CACHE_PREFIX = "repos:list:v3";
const REPOS_CACHE_FRESH_MS = 5 * 60 * 1000; // Serve without revalidation for 5 minutes
const REPOS_CACHE_KV_TTL_SECONDS = 3600; // Keep stale data in KV for 1 hour

/**
 * Cached repos list structure stored in KV.
 */
interface CachedReposList {
  repos: EnrichedRepository[];
  cachedAt: string;
  /** Epoch ms — cache is considered fresh until this time. Missing in entries cached before this field was added. */
  freshUntil?: number;
}

function connectionSummary(connection: ScmConnectionRecord) {
  return {
    id: connection.id,
    provider: connection.provider,
    displayName: connection.displayName,
    baseUrl: connection.baseUrl,
  } as const;
}

function repositoryUrls(
  connection: ScmConnectionRecord,
  repository: InstallationRepository
): { webUrl: string; cloneUrl: string } {
  if (repository.webUrl && repository.cloneUrl) {
    return { webUrl: repository.webUrl, cloneUrl: repository.cloneUrl };
  }
  if (connection.provider === "gitea") {
    throw new SourceControlProviderError(
      "Gitea repository catalog omitted provider-owned URLs.",
      "permanent"
    );
  }
  const owner = repository.owner.split("/").map(encodeURIComponent).join("/");
  const name = encodeURIComponent(repository.name);
  return {
    webUrl: `${connection.baseUrl}/${owner}/${name}`,
    cloneUrl: `${connection.cloneBaseUrl}/${owner}/${name}.git`,
  };
}

function registry(env: Env, db: SqlDatabase): SourceControlConnectionRegistry {
  return new SourceControlConnectionRegistry(env, {
    connections: new ScmConnectionStore(db),
    credentials: new ScmConnectionCredentialStore(db, env.TOKEN_ENCRYPTION_KEY),
  });
}

async function applyCatalogMetadata(
  db: SqlDatabase,
  connection: ScmConnectionRecord,
  catalog: EnrichedRepository[]
): Promise<void> {
  const metadataStore = new RepoMetadataStore(db);
  const stableMetadata = await metadataStore.getBatchByRepositoryIds(
    catalog.flatMap((repository) => (repository.repositoryKey ? [repository.repositoryKey] : []))
  );
  const legacyMetadata =
    connection.provider === "github" && connection.isDefault
      ? await metadataStore.getBatch(catalog)
      : new Map();
  for (const repository of catalog) {
    const value =
      (repository.repositoryKey ? stableMetadata.get(repository.repositoryKey) : undefined) ??
      legacyMetadata.get(`${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`);
    if (value) repository.metadata = value;
    else delete repository.metadata;
  }
}

async function loadConnectionCatalog(
  env: Env,
  db: SqlDatabase,
  connection: ScmConnectionRecord,
  actor: string,
  timeScmApi: <T>(fn: () => Promise<T>) => Promise<T>
): Promise<{ repos: EnrichedRepository[]; cached: boolean; cachedAt: string }> {
  const cacheStore = createKvCacheStore(env.REPOS_CACHE);
  const cacheKey = `${CONNECTION_REPOS_CACHE_PREFIX}:${connection.id}:${connection.revision}:${actor}`;
  const cached = await cacheStore.get<CachedReposList>(cacheKey, "json").catch(() => null);
  if (cached?.freshUntil && cached.freshUntil > Date.now()) {
    const repos = structuredClone(cached.repos);
    await applyCatalogMetadata(db, connection, repos);
    return { repos, cached: true, cachedAt: cached.cachedAt };
  }

  const resolved = await registry(env, db).getConnection(connection.id);
  const upstream = await timeScmApi(() => resolved.provider.listRepositories());
  const repositoryStore = new ScmRepositoryStore(db);
  const catalog: EnrichedRepository[] = [];
  for (const repository of upstream) {
    const urls = repositoryUrls(connection, repository);
    const stored = await repositoryStore.upsertResolved({
      connectionId: connection.id,
      externalId: String(repository.id),
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
      webUrl: urls.webUrl,
      cloneUrl: urls.cloneUrl,
      private: repository.private,
      archived: repository.archived,
    });
    catalog.push({
      ...repository,
      ...urls,
      repositoryKey: stored.id,
      connectionId: connection.id,
      provider: connection.provider,
      connection: connectionSummary(connection),
    });
  }

  await applyCatalogMetadata(db, connection, catalog);

  const cachedAt = new Date().toISOString();
  await cacheStore
    .put(
      cacheKey,
      JSON.stringify({ repos: catalog, cachedAt, freshUntil: Date.now() + REPOS_CACHE_FRESH_MS }),
      {
        expirationTtl: REPOS_CACHE_KV_TTL_SECONDS,
      }
    )
    .catch((cause) =>
      logger.warn("Failed to cache connection repository catalog", {
        connection_id: connection.id,
        error: cause instanceof Error ? cause : String(cause),
      })
    );
  return { repos: catalog, cached: false, cachedAt };
}

/**
 * List all repositories accessible via the SCM provider's app-level credentials.
 *
 * Uses stale-while-revalidate caching:
 * - Fresh cache (< 5 min old): return immediately
 * - Stale cache (5 min – 1 hr): return immediately, revalidate in background
 * - No cache: fetch synchronously (first load or after 1 hr KV expiry)
 *
 * This prevents slow API pagination from blocking the Worker
 * isolate and causing head-of-line blocking for other requests.
 */
async function handleListRepos(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const requestedConnectionId = new URL(request.url).searchParams.get("connectionId");
  const store = new ScmConnectionStore(ctx.db);
  const enabled = await store.list();
  const connections = requestedConnectionId
    ? enabled.filter((connection) => connection.id === requestedConnectionId)
    : enabled;
  if (requestedConnectionId && connections.length === 0) {
    return error("SCM connection was not found or is disabled", 404);
  }

  const actor =
    ctx.principal?.kind === "user"
      ? `user:${ctx.principal.userId}`
      : ctx.principal?.kind === "service"
        ? `service:${ctx.principal.service}`
        : "unknown";
  const repos: EnrichedRepository[] = [];
  const connectionErrors: Array<{ connectionId: string; code: string }> = [];
  let allCached = true;
  let cachedAt = new Date(0).toISOString();

  for (const connection of connections) {
    try {
      const refresh = loadConnectionCatalog(env, ctx.db, connection, actor, (fn) =>
        ctx.metrics.time("scm_api", fn)
      );
      // Keep a cold provider refresh alive if the requesting browser aborts.
      ctx.executionCtx.submit(refresh);
      const result = await refresh;
      repos.push(...result.repos);
      allCached &&= result.cached;
      if (result.cachedAt > cachedAt) cachedAt = result.cachedAt;
    } catch (cause) {
      logger.warn("Failed to load connection repository catalog", {
        connection_id: connection.id,
        error_type: cause instanceof Error ? cause.name : "unknown",
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      connectionErrors.push({ connectionId: connection.id, code: "SCM_CATALOG_UNAVAILABLE" });
    }
  }

  if (requestedConnectionId && connectionErrors.length > 0) {
    return error("Failed to fetch repositories for the selected connection", 503);
  }
  return json({ repos, cached: allCached, cachedAt, connectionErrors });
}

/**
 * Update metadata for a specific repository.
 * This allows storing custom descriptions, aliases, and channel associations.
 */
async function handleUpdateRepoMetadata(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

  // Parse and validate at the trust boundary: malformed JSON and structurally
  // invalid metadata both take the same 400 path, before any persistence.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return error("Invalid repository metadata", 400);
  }
  const parsedBody = repoMetadataSchema.safeParse(rawBody);
  if (!parsedBody.success) return error("Invalid repository metadata", 400);
  // Zod has already validated every field and stripped unknown keys.
  const metadata = parsedBody.data;

  const metadataStore = new RepoMetadataStore(ctx.db);

  try {
    await metadataStore.upsert(owner, name, metadata);
  } catch (e) {
    logger.error("Failed to update repo metadata", {
      error: e instanceof Error ? e : String(e),
    });
    return error("Failed to update metadata", 500);
  }

  try {
    await createKvCacheStore(env.REPOS_CACHE).delete(REPOS_CACHE_KEY);
  } catch (e) {
    logger.warn("Failed to invalidate repos cache", {
      trace_id: ctx.trace_id,
      error: e instanceof Error ? e : String(e),
      repo_owner: owner,
      repo_name: name,
    });
  }

  // Return normalized repo identifier
  const normalizedRepo = `${owner.toLowerCase()}/${name.toLowerCase()}`;
  return json({
    status: "updated",
    repo: normalizedRepo,
    metadata,
  });
}

/**
 * Get metadata for a specific repository.
 */
async function handleGetRepoMetadata(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

  const normalizedRepo = `${owner.toLowerCase()}/${name.toLowerCase()}`;
  const metadataStore = new RepoMetadataStore(ctx.db);

  try {
    const metadata = await metadataStore.get(owner, name);

    return json({
      repo: normalizedRepo,
      metadata: metadata ?? null,
    });
  } catch (e) {
    logger.error("Failed to get repo metadata", { error: e instanceof Error ? e : String(e) });
    return error("Failed to get metadata", 500);
  }
}

/**
 * List branches for a specific repository.
 */
async function handleListBranches(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

  try {
    const { provider } = await registry(env, ctx.db).getDefaultConnection();
    const branches = await provider.listBranches({ owner, name });
    return json({ branches });
  } catch (e) {
    if (e instanceof SourceControlProviderError && e.errorType === "permanent" && !e.httpStatus) {
      return error("SCM provider not configured", 500);
    }
    logger.error("Failed to list branches", {
      error: e instanceof Error ? e : String(e),
      repo_owner: owner,
      repo_name: name,
    });
    return error("Failed to list branches", 500);
  }
}

async function handleListBranchesByRepositoryKey(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const repositoryKey = match.groups?.repositoryKey
    ? decodeURIComponent(match.groups.repositoryKey)
    : null;
  if (!repositoryKey) return error("Repository key is required", 400);
  const repository = await new ScmRepositoryStore(ctx.db).get(repositoryKey);
  if (!repository || repository.resolutionStatus !== "resolved" || repository.removedAt != null) {
    return error("SCM repository was not found or is unresolved", 404);
  }
  try {
    const { provider } = await registry(env, ctx.db).getConnection(repository.connectionId);
    const branches = await provider.listBranches({
      owner: repository.owner,
      name: repository.name,
    });
    return json({ repositoryKey, connectionId: repository.connectionId, branches });
  } catch (cause) {
    logger.warn("Failed to list repository branches", {
      repository_id: repositoryKey,
      connection_id: repository.connectionId,
      error_type: cause instanceof Error ? cause.name : "unknown",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to list branches", 503);
  }
}

async function resolveCatalogRepository(env: Env, repositoryKey: string, ctx: RequestContext) {
  const repository = await new ScmRepositoryStore(ctx.db).get(repositoryKey);
  if (!repository || repository.resolutionStatus !== "resolved" || repository.removedAt != null) {
    return null;
  }
  const { provider } = await registry(env, ctx.db).getConnection(repository.connectionId);
  const access = await provider.checkRepositoryAccess({
    owner: repository.owner,
    name: repository.name,
  });
  return access && String(access.repoId) === repository.externalId ? repository : null;
}

async function handleGetRepoMetadataByRepositoryKey(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const repositoryKey = match.groups?.repositoryKey
    ? decodeURIComponent(match.groups.repositoryKey)
    : null;
  if (!repositoryKey) return error("Repository key is required", 400);
  const repository = await resolveCatalogRepository(env, repositoryKey, ctx);
  if (!repository) return error("SCM repository was not found or is inaccessible", 404);
  const metadata = await new RepoMetadataStore(ctx.db).getByRepositoryId(repository.id);
  return json({ repositoryKey: repository.id, metadata });
}

async function handleUpdateRepoMetadataByRepositoryKey(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const repositoryKey = match.groups?.repositoryKey
    ? decodeURIComponent(match.groups.repositoryKey)
    : null;
  if (!repositoryKey) return error("Repository key is required", 400);
  const repository = await resolveCatalogRepository(env, repositoryKey, ctx);
  if (!repository) return error("SCM repository was not found or is inaccessible", 404);
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return error("Invalid repository metadata", 400);
  }
  const parsed = repoMetadataSchema.safeParse(rawBody);
  if (!parsed.success) return error("Invalid repository metadata", 400);
  await new RepoMetadataStore(ctx.db).upsertByRepositoryId(repository.id, parsed.data);
  return json({ status: "updated", repositoryKey: repository.id, metadata: parsed.data });
}

export const reposRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
  {
    method: "GET",
    pattern: parsePattern("/repos/:repositoryKey/branches"),
    handler: handleListBranchesByRepositoryKey,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos"),
    handler: handleListRepos,
  },
  {
    method: "PUT",
    pattern: parsePattern("/repos/:owner/:name/metadata"),
    handler: handleUpdateRepoMetadata,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/metadata"),
    handler: handleGetRepoMetadata,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/branches"),
    handler: handleListBranches,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:repositoryKey/metadata"),
    handler: handleGetRepoMetadataByRepositoryKey,
  },
  {
    method: "PUT",
    pattern: parsePattern("/repos/:repositoryKey/metadata"),
    handler: handleUpdateRepoMetadataByRepositoryKey,
  },
]);
