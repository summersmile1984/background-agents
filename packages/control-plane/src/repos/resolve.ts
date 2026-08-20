import type { CreateSessionRequest } from "@open-inspect/shared/types/session-api";
import type { RepositoryRef } from "@open-inspect/shared/types/repositories";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { SourceControlProvider } from "../source-control";
import type { EnvironmentStore } from "../db/environments";
import { ScmConnectionCredentialStore, ScmConnectionStore } from "../db/scm-connections";
import { ScmRepositoryStore, type ScmRepositoryRecord } from "../db/scm-repositories";
import { SourceControlConnectionRegistry } from "../source-control/connection-registry";
import { createRouteSourceControlProvider, HttpError, type RequestContext } from "../routes/shared";

/**
 * One requested member of a session's repository list, exactly as normalized
 * by sessionRepositoriesInputSchema (derived, so it cannot drift from it).
 */
export type SessionRepositoryResolutionInput = NonNullable<
  CreateSessionRequest["repositories"]
>[number];

export interface ResolvedSessionRepositorySet {
  connectionId: string;
  repositories: RepositoryRef[];
}

function numericProviderRepositoryId(repository: ScmRepositoryRecord): number {
  const value = Number(repository.externalId);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(
      `SCM repository has an unsupported external identity: ${repository.id}`,
      409
    );
  }
  return value;
}

/** Resolve stable repository keys and pin exactly one SCM connection. */
export async function resolveSessionRepositoryKeys(
  env: Env,
  repositoryKeys: readonly string[],
  ctx: RequestContext,
  logger: Logger,
  scalarBaseBranch?: string | null,
  baseBranches?: readonly (string | null | undefined)[]
): Promise<ResolvedSessionRepositorySet> {
  const repositoryStore = new ScmRepositoryStore(ctx.db);
  const records = await Promise.all(repositoryKeys.map((key) => repositoryStore.get(key)));
  const missing = repositoryKeys.filter((_, index) => {
    const record = records[index];
    return !record || record.resolutionStatus !== "resolved" || record.removedAt != null;
  });
  if (missing.length > 0) {
    throw new HttpError(
      `SCM repositories were not found or are unresolved: ${missing.join(", ")}`,
      404
    );
  }

  const resolvedRecords = records as ScmRepositoryRecord[];
  const connectionIds = new Set(resolvedRecords.map((record) => record.connectionId));
  if (connectionIds.size !== 1) {
    throw new HttpError(
      "SCM_CONNECTION_MISMATCH: all session repositories must use one connection",
      409
    );
  }
  const connectionId = resolvedRecords[0].connectionId;
  const registry = new SourceControlConnectionRegistry(env, {
    connections: new ScmConnectionStore(ctx.db),
    credentials: new ScmConnectionCredentialStore(ctx.db, env.TOKEN_ENCRYPTION_KEY),
  });
  const { provider } = await registry.getConnection(connectionId);
  const refs = await Promise.all(
    resolvedRecords.map(async (repository, index): Promise<RepositoryRef> => {
      try {
        const access = await provider.checkRepositoryAccess({
          owner: repository.owner,
          name: repository.name,
        });
        if (!access || String(access.repoId) !== repository.externalId) {
          throw new HttpError(`SCM_REPOSITORY_ACCESS_DENIED: ${repository.id}`, 403);
        }
        return {
          repositoryKey: repository.id,
          connectionId,
          repoOwner: access.repoOwner,
          repoName: access.repoName,
          repoId: numericProviderRepositoryId(repository),
          baseBranch:
            baseBranches?.[index]?.trim() ||
            (repositoryKeys.length === 1 ? scalarBaseBranch?.trim() : null) ||
            repository.defaultBranch ||
            access.defaultBranch ||
            "main",
        };
      } catch (cause) {
        if (cause instanceof HttpError) throw cause;
        logger.warn("Stable repository resolution failed", {
          repository_id: repository.id,
          connection_id: connectionId,
          position: index,
          error_type: cause instanceof Error ? cause.name : "unknown",
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
        throw new HttpError(`SCM_REPOSITORY_ACCESS_DENIED: ${repository.id}`, 403);
      }
    })
  );

  const seenNames = new Set<string>();
  for (const ref of refs) {
    const checkoutName = ref.repoName.toLowerCase();
    if (seenNames.has(checkoutName)) {
      throw new HttpError(`repositories resolve to the same checkout path: ${ref.repoName}`, 400);
    }
    seenNames.add(checkoutName);
  }
  return { connectionId, repositories: refs };
}

/**
 * Resolve a launch environment into the repository inputs its session should
 * clone, in position order (design §7.6). The caller feeds these into
 * resolveSessionRepositories, so an environment session gets the same
 * all-or-nothing SCM check as an ad-hoc list: access to a member repo can be
 * revoked after the environment was created, and a stale member must fail the
 * create cleanly rather than boot a partial workspace.
 *
 * Raises HttpError(404) when the environment does not exist.
 */
export async function resolveEnvironmentTarget(
  store: EnvironmentStore,
  environmentId: string
): Promise<SessionRepositoryResolutionInput[]> {
  const environment = await store.getById(environmentId);
  if (!environment) {
    throw new HttpError(`Environment not found: ${environmentId}`, 404);
  }
  const repositories = await store.getRepositoriesForEnvironment(environmentId);
  if (repositories.length === 0) {
    // Environments always carry >=1 member by construction (the create/update
    // schema requires it), so an empty set is a data-integrity fault, not a
    // user mistake.
    throw new HttpError(`Environment has no repositories: ${environmentId}`, 500);
  }
  return repositories.map((repo) => ({
    repoOwner: repo.repo_owner,
    repoName: repo.repo_name,
    baseBranch: repo.base_branch,
  }));
}

/** Resolve an environment through its pinned repository identities when the
 * additive migration has populated them, with an all-legacy compatibility
 * fallback during rollout. A partially backfilled environment fails closed. */
export async function resolveEnvironmentRepositorySet(
  env: Env,
  store: EnvironmentStore,
  environmentId: string,
  ctx: RequestContext,
  logger: Logger
): Promise<ResolvedSessionRepositorySet | { connectionId: null; repositories: RepositoryRef[] }> {
  const environment = await store.getById(environmentId);
  if (!environment) throw new HttpError(`Environment not found: ${environmentId}`, 404);
  const rows = await store.getRepositoriesForEnvironment(environmentId);
  if (rows.length === 0)
    throw new HttpError(`Environment has no repositories: ${environmentId}`, 500);

  const stableCount = rows.filter(
    (row) => Boolean(row.repository_id) && Boolean(row.scm_connection_id)
  ).length;
  if (stableCount > 0 && stableCount !== rows.length) {
    throw new HttpError(
      `Environment has incomplete source-control identity: ${environmentId}`,
      409
    );
  }
  if (stableCount === rows.length) {
    const connectionIds = new Set(rows.map((row) => row.scm_connection_id));
    if (
      connectionIds.size !== 1 ||
      (environment.scm_connection_id && !connectionIds.has(environment.scm_connection_id))
    ) {
      throw new HttpError(`SCM_CONNECTION_MISMATCH: environment ${environmentId}`, 409);
    }
    return resolveSessionRepositoryKeys(
      env,
      rows.map((row) => row.repository_id!),
      ctx,
      logger,
      null,
      rows.map((row) => row.base_branch)
    );
  }

  const repositories = await resolveSessionRepositories(
    env,
    rows.map((row) => ({
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      baseBranch: row.base_branch,
    })),
    ctx,
    logger
  );
  return { connectionId: null, repositories };
}

interface ResolutionOutcome {
  input: SessionRepositoryResolutionInput;
  ref: RepositoryRef | null;
  reason: string | null;
  /** True when the SCM provider threw (vs. cleanly reporting no access). */
  errored: boolean;
}

/**
 * Resolve a session's repository list against the SCM provider concurrently.
 *
 * All-or-nothing, unlike resolveAutomationRepositories: a session boots one
 * sandbox for the whole set, so a single unresolvable member fails the create.
 * Raises an HttpError naming every failing repository — 400 when the provider
 * cleanly reported no access (bad request content), 500 when any lookup threw.
 */
export async function resolveSessionRepositories(
  env: Env,
  inputs: SessionRepositoryResolutionInput[],
  ctx: RequestContext,
  logger: Logger,
  sourceControlProvider?: SourceControlProvider
): Promise<RepositoryRef[]> {
  const provider = sourceControlProvider ?? createRouteSourceControlProvider(env);

  const outcomes = await Promise.all(
    inputs.map(async (input): Promise<ResolutionOutcome> => {
      try {
        const access = await provider.checkRepositoryAccess({
          owner: input.repoOwner,
          name: input.repoName,
        });
        if (!access) {
          return {
            input,
            ref: null,
            reason: "not installed for the GitHub App",
            errored: false,
          };
        }
        return {
          input,
          ref: {
            repoOwner: access.repoOwner,
            repoName: access.repoName,
            repoId: access.repoId,
            baseBranch: input.baseBranch?.trim() || access.defaultBranch || "main",
          },
          reason: null,
          errored: false,
        };
      } catch (e) {
        logger.error("Failed to resolve session repository", {
          error: e instanceof Error ? e.message : String(e),
          repo_owner: input.repoOwner,
          repo_name: input.repoName,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
        return { input, ref: null, reason: "resolution failed", errored: true };
      }
    })
  );

  const failures = outcomes.filter((outcome) => outcome.ref === null);
  if (failures.length > 0) {
    const detail = failures
      .map((failure) => `${failure.input.repoOwner}/${failure.input.repoName} (${failure.reason})`)
      .join(", ");
    throw new HttpError(
      `Failed to resolve repositories: ${detail}`,
      failures.some((failure) => failure.errored) ? 500 : 400
    );
  }

  const refs = outcomes.map((outcome) => outcome.ref as RepositoryRef);

  // Providers may canonicalize identities (GitLab follows project redirects
  // after renames), so the input schema's uniqueness invariants must be
  // re-checked on the RESOLVED identities: distinct repositories (D1 keys
  // member rows by owner/name) and distinct repo names (checkout paths are
  // /workspace/{repoName}).
  const seenFullNames = new Set<string>();
  const seenNames = new Set<string>();
  for (const ref of refs) {
    const fullName = `${ref.repoOwner}/${ref.repoName}`;
    if (seenFullNames.has(fullName)) {
      throw new HttpError(`repositories resolve to the same repository: ${fullName}`, 400);
    }
    if (seenNames.has(ref.repoName)) {
      throw new HttpError(`repositories resolve to the same checkout path: ${ref.repoName}`, 400);
    }
    seenFullNames.add(fullName);
    seenNames.add(ref.repoName);
  }

  return refs;
}
