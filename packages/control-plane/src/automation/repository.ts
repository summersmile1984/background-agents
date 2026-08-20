import type { AutomationRepositoryInsert } from "../db/automation-store";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { createSourceControlProviderFromEnv, type SourceControlProvider } from "../source-control";
import { SourceControlConnectionRegistry } from "../source-control/connection-registry";

/** A repository resolved for one firing: access checked, branch defaulted. */
interface ResolvedAutomationRepository {
  repositoryId?: string;
  scmConnectionId?: string;
  repoOwner: string;
  repoName: string;
  // Access-checked at resolution, so always present (unlike the stored
  // AutomationRepositoryInsert.repo_id, which can be null).
  repoId: number;
  baseBranch: string;
}

/**
 * Per-repository resolution outcome. `repository` is null when the SCM
 * provider rejected (or errored on) the repo; `error` then carries the child
 * run's failure_reason. `requested` preserves the selection row so a failed
 * child still gets a repository snapshot.
 */
export interface AutomationRepositoryResolution {
  requested: AutomationRepositoryInsert;
  repository: ResolvedAutomationRepository | null;
  error: string | null;
}

/**
 * Resolve an automation's selected repositories concurrently at firing time.
 * One inaccessible repository never blocks its siblings — it resolves to an
 * error entry and the caller pre-fails that child run.
 */
export async function resolveAutomationRepositories(
  env: Env,
  repositories: AutomationRepositoryInsert[],
  sourceControlProvider?: SourceControlProvider,
  db?: SqlDatabase
): Promise<AutomationRepositoryResolution[]> {
  if (repositories.length === 0) return [];

  let legacyProvider = sourceControlProvider ?? null;
  const registry = db ? new SourceControlConnectionRegistry(env, { db }) : null;
  const providers = new Map<string, SourceControlProvider>();

  return Promise.all(
    repositories.map(async (requested): Promise<AutomationRepositoryResolution> => {
      try {
        let provider: SourceControlProvider;
        if (requested.scm_connection_id) {
          if (!registry) {
            throw new Error("Stable SCM automation resolution requires an injected database");
          }
          provider =
            providers.get(requested.scm_connection_id) ??
            (await registry.getConnection(requested.scm_connection_id)).provider;
          providers.set(requested.scm_connection_id, provider);
        } else {
          legacyProvider ??= createSourceControlProviderFromEnv(env);
          provider = legacyProvider;
        }
        const access = await provider.checkRepositoryAccess({
          owner: requested.repo_owner,
          name: requested.repo_name,
        });
        if (!access) {
          return {
            requested,
            repository: null,
            error: "Repository is not accessible for the configured SCM provider",
          };
        }
        return {
          requested,
          repository: {
            ...(requested.repository_id ? { repositoryId: requested.repository_id } : {}),
            ...(requested.scm_connection_id
              ? { scmConnectionId: requested.scm_connection_id }
              : {}),
            repoOwner: access.repoOwner,
            repoName: access.repoName,
            repoId: access.repoId,
            baseBranch: requested.base_branch?.trim() || access.defaultBranch || "main",
          },
          error: null,
        };
      } catch (e) {
        return {
          requested,
          repository: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    })
  );
}
