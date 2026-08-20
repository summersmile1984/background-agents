import type { SqlDatabase, SqlStatement } from "./sql-database";

const JOB_NAME = "legacy-repositories-v1";
const LEASE_DURATION_MS = 60_000;
export const DEFAULT_SCM_BACKFILL_BATCH_SIZE = 25;
export const MAX_SCM_BACKFILL_BATCH_SIZE = 100;

const LEGACY_LOCATIONS_CTE = `WITH legacy_locations(path_key, owner, name) AS (
  SELECT lower(repo_owner) || '/' || lower(repo_name), repo_owner, repo_name
  FROM sessions
  WHERE repo_owner IS NOT NULL
    AND (scm_connection_id IS NULL OR primary_repository_id IS NULL)
  UNION ALL
  SELECT lower(repo_owner) || '/' || lower(repo_name), repo_owner, repo_name
  FROM session_repositories
  WHERE scm_connection_id IS NULL OR repository_id IS NULL
  UNION ALL
  SELECT lower(repo_owner) || '/' || lower(repo_name), repo_owner, repo_name
  FROM environment_repositories
  WHERE scm_connection_id IS NULL OR repository_id IS NULL
  UNION ALL
  SELECT lower(repo_owner) || '/' || lower(repo_name), repo_owner, repo_name
  FROM automation_repositories
  WHERE scm_connection_id IS NULL OR repository_id IS NULL
  UNION ALL
  SELECT lower(repo_owner) || '/' || lower(repo_name), repo_owner, repo_name
  FROM automation_runs
  WHERE repo_owner IS NOT NULL
    AND (scm_connection_id IS NULL OR repository_id IS NULL)
  UNION ALL
  SELECT lower(repo_owner) || '/' || lower(repo_name), repo_owner, repo_name
  FROM repo_metadata WHERE repository_id IS NULL
  UNION ALL
  SELECT lower(repo_owner) || '/' || lower(repo_name), repo_owner, repo_name
  FROM repo_secrets WHERE repository_id IS NULL
  UNION ALL
  SELECT lower(repo_owner) || '/' || lower(repo_name), repo_owner, repo_name
  FROM session_pull_requests WHERE repository_id IS NULL
  UNION ALL
  SELECT lower(repo_owner) || '/' || lower(repo_name), repo_owner, repo_name
  FROM skill_assignments
  WHERE scope_type = 'repository' AND repository_id IS NULL
  UNION ALL
  SELECT lower(repo), NULL, NULL
  FROM integration_repo_settings WHERE repository_id IS NULL
  UNION ALL
  SELECT lower(scope_id), NULL, NULL
  FROM image_builds
  WHERE scope_kind = 'repo' AND repository_id IS NULL AND scope_id NOT LIKE 'repo:%'
  UNION ALL
  SELECT lower(CAST(j.value AS TEXT)), NULL, NULL
  FROM mcp_servers m,
       json_each(CASE WHEN json_valid(m.repo_scope) THEN m.repo_scope ELSE json_array(m.repo_scope) END) j
  WHERE m.repo_scope IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM mcp_server_repository_scopes s
      JOIN scm_repositories r ON r.id = s.repository_id
      WHERE s.mcp_server_id = m.id
        AND r.connection_id = ?
        AND r.path_key = lower(CAST(j.value AS TEXT))
    )
)`;

export interface LegacyRepositoryLocation {
  pathKey: string;
  owner: string;
  name: string;
}

export interface ScmBackfillJobState {
  status: "pending" | "running" | "complete" | "failed";
  cursor: string | null;
  processedRows: number;
  unresolvedRows: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  lastErrorCode: string | null;
  updatedAt: number;
}

interface JobRow {
  status: ScmBackfillJobState["status"];
  cursor: string | null;
  processed_rows: number;
  unresolved_rows: number;
  lease_owner: string | null;
  lease_until: number | null;
  last_error_code: string | null;
  updated_at: number;
}

export interface ScmMigrationPreflight {
  legacyRepositoryLocations: number;
  unresolvedActiveRepositories: number;
  mixedSessionAggregates: number;
  mixedEnvironmentAggregates: number;
  mixedAutomationAggregates: number;
  orphanRepositoryReferences: number;
  readyForSecondConnection: boolean;
  job: ScmBackfillJobState | null;
}

function parsePathKey(pathKey: string): { owner: string; name: string } | null {
  const split = pathKey.lastIndexOf("/");
  if (split <= 0 || split === pathKey.length - 1) return null;
  return { owner: pathKey.slice(0, split), name: pathKey.slice(split + 1) };
}

function toJobState(row: JobRow | null): ScmBackfillJobState | null {
  return row
    ? {
        status: row.status,
        cursor: row.cursor,
        processedRows: row.processed_rows,
        unresolvedRows: row.unresolved_rows,
        leaseOwner: row.lease_owner,
        leaseUntil: row.lease_until,
        lastErrorCode: row.last_error_code,
        updatedAt: row.updated_at,
      }
    : null;
}

/** Online expand-phase migration. Every mapping operation is idempotent. */
export class ScmRepositoryBackfillStore {
  constructor(private readonly db: SqlDatabase) {}

  async acquireLease(leaseOwner: string, now: number = Date.now()): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO scm_repository_backfill_state
           (job_name, cursor, status, lease_owner, lease_until, processed_rows,
            unresolved_rows, last_error_code, created_at, updated_at)
         VALUES (?, NULL, 'running', ?, ?, 0, 0, NULL, ?, ?)
         ON CONFLICT(job_name) DO UPDATE SET
           status = 'running', lease_owner = excluded.lease_owner,
           lease_until = excluded.lease_until, last_error_code = NULL,
           updated_at = excluded.updated_at
         WHERE scm_repository_backfill_state.lease_owner = excluded.lease_owner
            OR scm_repository_backfill_state.lease_until IS NULL
            OR scm_repository_backfill_state.lease_until < ?`
      )
      .bind(JOB_NAME, leaseOwner, now + LEASE_DURATION_MS, now, now, now)
      .run();
    return result.meta.changes === 1;
  }

  async getJobState(): Promise<ScmBackfillJobState | null> {
    const row = await this.db
      .prepare(
        `SELECT status, cursor, processed_rows, unresolved_rows, lease_owner,
                lease_until, last_error_code, updated_at
         FROM scm_repository_backfill_state WHERE job_name = ?`
      )
      .bind(JOB_NAME)
      .first<JobRow>();
    return toJobState(row);
  }

  async listLegacyLocations(
    connectionId: string,
    cursor: string | null,
    limit: number
  ): Promise<LegacyRepositoryLocation[]> {
    const normalizedLimit = Math.max(1, Math.min(MAX_SCM_BACKFILL_BATCH_SIZE, limit));
    const { results } = await this.db
      .prepare(
        `${LEGACY_LOCATIONS_CTE}
         SELECT path_key, min(owner) AS owner, min(name) AS name
         FROM legacy_locations
         WHERE path_key > ?
         GROUP BY path_key
         ORDER BY path_key
         LIMIT ?`
      )
      .bind(connectionId, cursor ?? "", normalizedLimit)
      .all<{ path_key: string; owner: string | null; name: string | null }>();
    return results.flatMap((row) => {
      const parsed =
        row.owner && row.name ? { owner: row.owner, name: row.name } : parsePathKey(row.path_key);
      return parsed ? [{ pathKey: row.path_key, ...parsed }] : [];
    });
  }

  async applyRepositoryMapping(input: {
    connectionId: string;
    repositoryId: string;
    owner: string;
    name: string;
    now?: number;
  }): Promise<void> {
    const now = input.now ?? Date.now();
    const owner = input.owner.toLowerCase();
    const name = input.name.toLowerCase();
    const path = `${owner}/${name}`;
    const args = [input.connectionId, input.repositoryId, owner, name] as const;
    const statements: SqlStatement[] = [
      this.db
        .prepare(
          `UPDATE sessions SET scm_connection_id = ?, primary_repository_id = ?
           WHERE lower(repo_owner) = ? AND lower(repo_name) = ?
             AND (scm_connection_id IS NULL OR scm_connection_id = ?)
             AND (primary_repository_id IS NULL OR primary_repository_id = ?)`
        )
        .bind(...args, input.connectionId, input.repositoryId),
      this.db
        .prepare(
          `UPDATE session_repositories SET scm_connection_id = ?, repository_id = ?
           WHERE lower(repo_owner) = ? AND lower(repo_name) = ?
             AND (scm_connection_id IS NULL OR scm_connection_id = ?)
             AND (repository_id IS NULL OR repository_id = ?)`
        )
        .bind(...args, input.connectionId, input.repositoryId),
      this.db
        .prepare(
          `UPDATE environments SET scm_connection_id = ?
           WHERE id IN (
             SELECT environment_id FROM environment_repositories
             WHERE lower(repo_owner) = ? AND lower(repo_name) = ?
           ) AND (scm_connection_id IS NULL OR scm_connection_id = ?)`
        )
        .bind(input.connectionId, owner, name, input.connectionId),
      this.db
        .prepare(
          `UPDATE environment_repositories SET scm_connection_id = ?, repository_id = ?
           WHERE lower(repo_owner) = ? AND lower(repo_name) = ?
             AND (scm_connection_id IS NULL OR scm_connection_id = ?)
             AND (repository_id IS NULL OR repository_id = ?)`
        )
        .bind(...args, input.connectionId, input.repositoryId),
      this.db
        .prepare(
          `UPDATE automations SET scm_connection_id = ?
           WHERE id IN (
             SELECT automation_id FROM automation_repositories
             WHERE lower(repo_owner) = ? AND lower(repo_name) = ?
           ) AND (scm_connection_id IS NULL OR scm_connection_id = ?)`
        )
        .bind(input.connectionId, owner, name, input.connectionId),
      this.db
        .prepare(
          `UPDATE automation_repositories SET scm_connection_id = ?, repository_id = ?
           WHERE lower(repo_owner) = ? AND lower(repo_name) = ?
             AND (scm_connection_id IS NULL OR scm_connection_id = ?)
             AND (repository_id IS NULL OR repository_id = ?)`
        )
        .bind(...args, input.connectionId, input.repositoryId),
      this.db
        .prepare(
          `UPDATE automation_runs SET scm_connection_id = ?, repository_id = ?
           WHERE lower(repo_owner) = ? AND lower(repo_name) = ?
             AND (scm_connection_id IS NULL OR scm_connection_id = ?)
             AND (repository_id IS NULL OR repository_id = ?)`
        )
        .bind(...args, input.connectionId, input.repositoryId),
      this.db
        .prepare(
          `INSERT INTO scm_repository_metadata
           (repository_id, description, aliases, channel_associations, keywords,
            default_environment_id, image_build_enabled, created_at, updated_at)
           SELECT ?, description, aliases, channel_associations, keywords,
                  default_environment_id, image_build_enabled, created_at, updated_at
           FROM repo_metadata
           WHERE lower(repo_owner) = ? AND lower(repo_name) = ?
           ON CONFLICT(repository_id) DO NOTHING`
        )
        .bind(input.repositoryId, owner, name),
      this.db
        .prepare(
          `UPDATE repo_metadata SET repository_id = ?
           WHERE lower(repo_owner) = ? AND lower(repo_name) = ?`
        )
        .bind(input.repositoryId, owner, name),
      this.db
        .prepare(
          `INSERT INTO scm_repository_secrets
           (repository_id, key, encrypted_value, created_at, updated_at)
           SELECT ?, key, encrypted_value, created_at, updated_at
           FROM repo_secrets
           WHERE lower(repo_owner) = ? AND lower(repo_name) = ?
           ON CONFLICT(repository_id, key) DO NOTHING`
        )
        .bind(input.repositoryId, owner, name),
      this.db
        .prepare(
          `UPDATE repo_secrets SET repository_id = ?
           WHERE lower(repo_owner) = ? AND lower(repo_name) = ?`
        )
        .bind(input.repositoryId, owner, name),
      this.db
        .prepare(
          `UPDATE image_builds
           SET scm_connection_id = ?, repository_id = ?,
               scope_id = 'repo:' || ?, status = 'superseded'
           WHERE scope_kind = 'repo' AND lower(scope_id) = ?`
        )
        .bind(input.connectionId, input.repositoryId, input.repositoryId, path),
      this.db
        .prepare(
          `INSERT INTO scm_session_pull_requests (
             artifact_id, session_id, scm_connection_id, repository_id,
             repository_external_id, repo_owner, repo_name, pr_number, url,
             lifecycle_state, is_draft, head_branch, base_branch, head_sha,
             provider_created_at, provider_updated_at, merged_at, closed_at,
             created_at, updated_at
           )
           SELECT artifact_id, session_id, ?, ?, repository_external_id,
                  repo_owner, repo_name, pr_number, url, lifecycle_state,
                  is_draft, head_branch, base_branch, head_sha,
                  provider_created_at, provider_updated_at, merged_at, closed_at,
                  created_at, updated_at
           FROM session_pull_requests
           WHERE lower(repo_owner) = ? AND lower(repo_name) = ?
           ON CONFLICT(artifact_id) DO NOTHING`
        )
        .bind(input.connectionId, input.repositoryId, owner, name),
      this.db
        .prepare(
          `UPDATE session_pull_requests SET scm_connection_id = ?, repository_id = ?
           WHERE lower(repo_owner) = ? AND lower(repo_name) = ?`
        )
        .bind(...args),
      this.db
        .prepare(
          `INSERT INTO scm_skill_assignments
           (id, skill_id, repository_id, created_by, created_at)
           SELECT 'scm_' || id, skill_id, ?, created_by, created_at
           FROM skill_assignments
           WHERE scope_type = 'repository'
             AND lower(repo_owner) = ? AND lower(repo_name) = ?
           ON CONFLICT(skill_id, repository_id) DO NOTHING`
        )
        .bind(input.repositoryId, owner, name),
      this.db
        .prepare(
          `UPDATE skill_assignments SET repository_id = ?
           WHERE scope_type = 'repository'
             AND lower(repo_owner) = ? AND lower(repo_name) = ?`
        )
        .bind(input.repositoryId, owner, name),
      this.db
        .prepare(
          `INSERT INTO scm_integration_repo_settings
           (integration_id, repository_id, settings, created_at, updated_at)
           SELECT integration_id, ?, settings, created_at, updated_at
           FROM integration_repo_settings WHERE lower(repo) = ?
           ON CONFLICT(integration_id, repository_id) DO NOTHING`
        )
        .bind(input.repositoryId, path),
      this.db
        .prepare(`UPDATE integration_repo_settings SET repository_id = ? WHERE lower(repo) = ?`)
        .bind(input.repositoryId, path),
      this.db
        .prepare(
          `INSERT INTO mcp_server_repository_scopes
           (mcp_server_id, repository_id, created_at)
           SELECT m.id, ?, ?
           FROM mcp_servers m,
                json_each(CASE WHEN json_valid(m.repo_scope) THEN m.repo_scope ELSE json_array(m.repo_scope) END) j
           WHERE m.repo_scope IS NOT NULL AND lower(CAST(j.value AS TEXT)) = ?
           ON CONFLICT(mcp_server_id, repository_id) DO NOTHING`
        )
        .bind(input.repositoryId, now, path),
    ];
    await this.db.batch(statements);
  }

  async checkpoint(input: {
    leaseOwner: string;
    cursor: string | null;
    processed: number;
    unresolved: number;
    complete: boolean;
    now?: number;
  }): Promise<void> {
    const now = input.now ?? Date.now();
    const result = await this.db
      .prepare(
        `UPDATE scm_repository_backfill_state SET
           cursor = ?, status = ?, processed_rows = processed_rows + ?,
           unresolved_rows = unresolved_rows + ?,
           lease_owner = NULL, lease_until = NULL, updated_at = ?
         WHERE job_name = ? AND lease_owner = ?`
      )
      .bind(
        input.complete ? null : input.cursor,
        input.complete ? "complete" : "pending",
        input.processed,
        input.unresolved,
        now,
        JOB_NAME,
        input.leaseOwner
      )
      .run();
    if (result.meta.changes !== 1) throw new Error("SCM backfill lease was lost");
  }

  async fail(leaseOwner: string, errorCode: string, now: number = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE scm_repository_backfill_state SET
           status = 'failed', lease_owner = NULL, lease_until = NULL,
           last_error_code = ?, updated_at = ?
         WHERE job_name = ? AND lease_owner = ?`
      )
      .bind(errorCode, now, JOB_NAME, leaseOwner)
      .run();
  }

  async preflight(connectionId: string): Promise<ScmMigrationPreflight> {
    const count = async (sql: string, ...bindings: unknown[]) => {
      const row = await this.db
        .prepare(sql)
        .bind(...bindings)
        .first<{ count: number }>();
      return row?.count ?? 0;
    };
    const [
      legacyRepositoryLocations,
      unresolvedActiveRepositories,
      mixedSessionAggregates,
      mixedEnvironmentAggregates,
      mixedAutomationAggregates,
      orphanRepositoryReferences,
      job,
    ] = await Promise.all([
      count(
        `${LEGACY_LOCATIONS_CTE}
         SELECT count(DISTINCT path_key) AS count FROM legacy_locations`,
        connectionId
      ),
      count(
        `SELECT count(DISTINCT r.id) AS count
         FROM scm_repositories r
         WHERE r.resolution_status != 'resolved' AND (
           EXISTS (SELECT 1 FROM sessions s WHERE s.primary_repository_id = r.id AND s.status NOT IN ('completed', 'failed', 'archived', 'cancelled'))
           OR EXISTS (SELECT 1 FROM environment_repositories e WHERE e.repository_id = r.id)
           OR EXISTS (
             SELECT 1 FROM automation_repositories ar
             JOIN automations a ON a.id = ar.automation_id
             WHERE ar.repository_id = r.id AND a.deleted_at IS NULL
           )
         )`
      ),
      count(
        `SELECT count(*) AS count FROM (
           SELECT s.id FROM sessions s
           JOIN session_repositories r ON r.session_id = s.id
           WHERE r.repository_id IS NOT NULL
           GROUP BY s.id
           HAVING count(DISTINCT r.scm_connection_id) != 1
              OR min(r.scm_connection_id) != s.scm_connection_id
         )`
      ),
      count(
        `SELECT count(*) AS count FROM (
           SELECT e.id FROM environments e
           JOIN environment_repositories r ON r.environment_id = e.id
           WHERE r.repository_id IS NOT NULL
           GROUP BY e.id
           HAVING count(DISTINCT r.scm_connection_id) != 1
              OR min(r.scm_connection_id) != e.scm_connection_id
         )`
      ),
      count(
        `SELECT count(*) AS count FROM (
           SELECT a.id FROM automations a
           JOIN automation_repositories r ON r.automation_id = a.id
           WHERE r.repository_id IS NOT NULL
           GROUP BY a.id
           HAVING count(DISTINCT r.scm_connection_id) != 1
              OR min(r.scm_connection_id) != a.scm_connection_id
         )`
      ),
      count(
        `SELECT count(*) AS count FROM (
           SELECT primary_repository_id AS repository_id FROM sessions WHERE primary_repository_id IS NOT NULL
           UNION ALL SELECT repository_id FROM session_repositories WHERE repository_id IS NOT NULL
           UNION ALL SELECT repository_id FROM environment_repositories WHERE repository_id IS NOT NULL
           UNION ALL SELECT repository_id FROM automation_repositories WHERE repository_id IS NOT NULL
         ) refs
         LEFT JOIN scm_repositories r ON r.id = refs.repository_id
         WHERE r.id IS NULL`
      ),
      this.getJobState(),
    ]);
    const readyForSecondConnection =
      legacyRepositoryLocations === 0 &&
      unresolvedActiveRepositories === 0 &&
      mixedSessionAggregates === 0 &&
      mixedEnvironmentAggregates === 0 &&
      mixedAutomationAggregates === 0 &&
      orphanRepositoryReferences === 0;
    return {
      legacyRepositoryLocations,
      unresolvedActiveRepositories,
      mixedSessionAggregates,
      mixedEnvironmentAggregates,
      mixedAutomationAggregates,
      orphanRepositoryReferences,
      readyForSecondConnection,
      job,
    };
  }
}
