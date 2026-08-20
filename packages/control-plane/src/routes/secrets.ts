/**
 * Repository and global secrets routes and handlers.
 */

import { RepoSecretsStore } from "../db/repo-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { SecretsValidationError, normalizeKey, validateKey } from "../db/secrets-validation";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { ScmRepositoryStore } from "../db/scm-repositories";
import { SourceControlConnectionRegistry } from "../source-control/connection-registry";
import {
  type Route,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  defineRoutes,
  type RequestContext,
  parsePattern,
  json,
  error,
  parseJsonBody,
  extractRepoParams,
  resolveRepoOrError,
} from "./shared";

const logger = createLogger("router:secrets");

async function resolveStableRepository(env: Env, repositoryKey: string, ctx: RequestContext) {
  const repository = await new ScmRepositoryStore(ctx.db).get(repositoryKey);
  if (!repository || repository.resolutionStatus !== "resolved" || repository.removedAt != null) {
    return error("SCM repository was not found or is unresolved", 404);
  }
  const { provider } = await new SourceControlConnectionRegistry(env, { db: ctx.db }).getConnection(
    repository.connectionId
  );
  const access = await provider.checkRepositoryAccess({
    owner: repository.owner,
    name: repository.name,
  });
  if (!access || String(access.repoId) !== repository.externalId) {
    return error("SCM repository is not accessible", 403);
  }
  return repository;
}

function stableRepositoryKey(match: RegExpMatchArray): string | Response {
  const value = match.groups?.repositoryKey;
  return value ? decodeURIComponent(value) : error("Repository key is required", 400);
}

async function handleSetStableRepoSecrets(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) return error("Encryption key not configured", 503);
  const repositoryKey = stableRepositoryKey(match);
  if (repositoryKey instanceof Response) return repositoryKey;
  const repository = await resolveStableRepository(env, repositoryKey, ctx);
  if (repository instanceof Response) return repository;
  const body = await parseJsonBody<{ secrets?: Record<string, string> }>(request);
  if (body instanceof Response) return body;
  if (!body.secrets || typeof body.secrets !== "object") {
    return error("Request body must include secrets object", 400);
  }
  try {
    const result = await new RepoSecretsStore(
      ctx.db,
      env.REPO_SECRETS_ENCRYPTION_KEY
    ).setSecretsByRepositoryId(repository.id, body.secrets);
    return json({
      status: "updated",
      repositoryKey: repository.id,
      repo: `${repository.owner}/${repository.name}`,
      ...result,
    });
  } catch (cause) {
    return cause instanceof SecretsValidationError
      ? error(cause.message, 400)
      : error("Secrets storage unavailable", 503);
  }
}

async function handleListStableRepoSecrets(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) return error("Encryption key not configured", 503);
  const repositoryKey = stableRepositoryKey(match);
  if (repositoryKey instanceof Response) return repositoryKey;
  const repository = await resolveStableRepository(env, repositoryKey, ctx);
  if (repository instanceof Response) return repository;
  const store = new RepoSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);
  const globalStore = new GlobalSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);
  const [secrets, globalSecrets] = await Promise.all([
    store.listSecretKeysByRepositoryId(repository.id),
    globalStore.listSecretKeys(),
  ]);
  return json({ repositoryKey: repository.id, secrets, globalSecrets });
}

async function handleDeleteStableRepoSecret(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) return error("Encryption key not configured", 503);
  const repositoryKey = stableRepositoryKey(match);
  if (repositoryKey instanceof Response) return repositoryKey;
  const repository = await resolveStableRepository(env, repositoryKey, ctx);
  if (repository instanceof Response) return repository;
  const key = match.groups?.key;
  if (!key) return error("Secret key is required", 400);
  try {
    validateKey(normalizeKey(key));
    const deleted = await new RepoSecretsStore(
      ctx.db,
      env.REPO_SECRETS_ENCRYPTION_KEY
    ).deleteSecretByRepositoryId(repository.id, key);
    return deleted
      ? json({ status: "deleted", repositoryKey: repository.id, key: normalizeKey(key) })
      : error("Secret not found", 404);
  } catch (cause) {
    return cause instanceof SecretsValidationError
      ? error(cause.message, 400)
      : error("Secrets storage unavailable", 503);
  }
}

/**
 * Upsert secrets for a repository.
 */
async function handleSetRepoSecrets(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

  const resolved = await resolveRepoOrError(env, owner, name, ctx, logger);

  const body = await parseJsonBody<{ secrets?: Record<string, string> }>(request);
  if (body instanceof Response) return body;

  if (!body?.secrets || typeof body.secrets !== "object") {
    return error("Request body must include secrets object", 400);
  }

  const store = new RepoSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const result = await store.setSecrets(
      resolved.repoId,
      resolved.repoOwner,
      resolved.repoName,
      body.secrets
    );

    logger.info("repo.secrets_updated", {
      event: "repo.secrets_updated",
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      keys_count: result.keys.length,
      created: result.created,
      updated: result.updated,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      status: "updated",
      repo: `${resolved.repoOwner}/${resolved.repoName}`,
      keys: result.keys,
      created: result.created,
      updated: result.updated,
    });
  } catch (e) {
    if (e instanceof SecretsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update repo secrets", {
      error: e instanceof Error ? e.message : String(e),
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

/**
 * List secret keys for a repository.
 */
async function handleListRepoSecrets(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

  const resolved = await resolveRepoOrError(env, owner, name, ctx, logger);

  const store = new RepoSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);
  const globalStore = new GlobalSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const [secrets, globalSecrets] = await Promise.all([
      store.listSecretKeys(resolved.repoId),
      globalStore.listSecretKeys().catch((e) => {
        logger.warn("Failed to fetch global secrets for repo list", {
          error: e instanceof Error ? e.message : String(e),
        });
        return [];
      }),
    ]);

    logger.info("repo.secrets_listed", {
      event: "repo.secrets_listed",
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      keys_count: secrets.length,
      global_keys_count: globalSecrets.length,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      repo: `${resolved.repoOwner}/${resolved.repoName}`,
      secrets,
      globalSecrets,
    });
  } catch (e) {
    logger.error("Failed to list repo secrets", {
      error: e instanceof Error ? e.message : String(e),
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

/**
 * Delete a secret for a repository.
 */
async function handleDeleteRepoSecret(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

  const key = match.groups?.key;
  if (!key) {
    return error("Owner, name, and key are required");
  }

  const resolved = await resolveRepoOrError(env, owner, name, ctx, logger);

  const store = new RepoSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const normalizedKey = normalizeKey(key);
    validateKey(normalizedKey);

    const deleted = await store.deleteSecret(resolved.repoId, key);
    if (!deleted) {
      return error("Secret not found", 404);
    }

    logger.info("repo.secret_deleted", {
      event: "repo.secret_deleted",
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      status: "deleted",
      repo: `${resolved.repoOwner}/${resolved.repoName}`,
      key: normalizedKey,
    });
  } catch (e) {
    if (e instanceof SecretsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to delete repo secret", {
      error: e instanceof Error ? e.message : String(e),
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

async function handleSetGlobalSecrets(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const body = await parseJsonBody<{ secrets?: Record<string, string> }>(request);
  if (body instanceof Response) return body;

  if (!body?.secrets || typeof body.secrets !== "object") {
    return error("Request body must include secrets object", 400);
  }

  const store = new GlobalSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const result = await store.setSecrets(body.secrets);

    logger.info("global.secrets_updated", {
      event: "global.secrets_updated",
      keys_count: result.keys.length,
      created: result.created,
      updated: result.updated,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      status: "updated",
      keys: result.keys,
      created: result.created,
      updated: result.updated,
    });
  } catch (e) {
    if (e instanceof SecretsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update global secrets", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

async function handleListGlobalSecrets(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const store = new GlobalSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const secrets = await store.listSecretKeys();

    logger.info("global.secrets_listed", {
      event: "global.secrets_listed",
      keys_count: secrets.length,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ secrets });
  } catch (e) {
    logger.error("Failed to list global secrets", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

async function handleDeleteGlobalSecret(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const key = match.groups?.key;
  if (!key) {
    return error("Key is required");
  }

  const store = new GlobalSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const normalizedKey = normalizeKey(key);
    validateKey(normalizedKey);

    const deleted = await store.deleteSecret(key);
    if (!deleted) {
      return error("Secret not found", 404);
    }

    logger.info("global.secret_deleted", {
      event: "global.secret_deleted",
      key: normalizedKey,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      status: "deleted",
      key: normalizedKey,
    });
  } catch (e) {
    if (e instanceof SecretsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to delete global secret", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

export const secretsRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
  {
    method: "PUT",
    pattern: parsePattern("/repos/:repositoryKey/secrets"),
    handler: handleSetStableRepoSecrets,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:repositoryKey/secrets"),
    handler: handleListStableRepoSecrets,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/repos/:repositoryKey/secrets/:key"),
    handler: handleDeleteStableRepoSecret,
  },
  {
    method: "PUT",
    pattern: parsePattern("/repos/:owner/:name/secrets"),
    handler: handleSetRepoSecrets,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/secrets"),
    handler: handleListRepoSecrets,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/repos/:owner/:name/secrets/:key"),
    handler: handleDeleteRepoSecret,
  },
  {
    method: "PUT",
    pattern: parsePattern("/secrets"),
    handler: handleSetGlobalSecrets,
  },
  {
    method: "GET",
    pattern: parsePattern("/secrets"),
    handler: handleListGlobalSecrets,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/secrets/:key"),
    handler: handleDeleteGlobalSecret,
  },
]);
