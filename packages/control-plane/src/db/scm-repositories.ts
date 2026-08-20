import type { RepositoryResolutionStatus } from "@open-inspect/shared/types/source-control";
import { generateId } from "../auth/crypto";
import type { SqlDatabase } from "./sql-database";

interface ScmRepositoryRow {
  id: string;
  connection_id: string;
  external_id: string | null;
  owner: string;
  name: string;
  path_key: string;
  default_branch: string | null;
  web_url: string | null;
  clone_url: string | null;
  is_private: number | null;
  archived: number;
  resolution_status: RepositoryResolutionStatus;
  last_seen_at: number | null;
  removed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ScmRepositoryRecord {
  id: string;
  connectionId: string;
  externalId: string | null;
  owner: string;
  name: string;
  pathKey: string;
  defaultBranch: string | null;
  webUrl: string | null;
  cloneUrl: string | null;
  private: boolean | null;
  archived: boolean;
  resolutionStatus: RepositoryResolutionStatus;
  lastSeenAt: number | null;
  removedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedScmRepositoryInput {
  connectionId: string;
  externalId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  webUrl: string;
  cloneUrl: string;
  private: boolean;
  archived: boolean;
  seenAt?: number;
}

export class ScmRepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScmRepositoryConflictError";
  }
}

function pathKey(owner: string, name: string): string {
  return `${owner.trim().toLowerCase()}/${name.trim().toLowerCase()}`;
}

function rowToRecord(row: ScmRepositoryRow): ScmRepositoryRecord {
  return {
    id: row.id,
    connectionId: row.connection_id,
    externalId: row.external_id,
    owner: row.owner,
    name: row.name,
    pathKey: row.path_key,
    defaultBranch: row.default_branch,
    webUrl: row.web_url,
    cloneUrl: row.clone_url,
    private: row.is_private == null ? null : row.is_private === 1,
    archived: row.archived === 1,
    resolutionStatus: row.resolution_status,
    lastSeenAt: row.last_seen_at,
    removedAt: row.removed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertCredentialFreeHttpsUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ScmRepositoryConflictError(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new ScmRepositoryConflictError(`${label} must be credential-free HTTPS`);
  }
}

export class ScmRepositoryStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(id: string): Promise<ScmRepositoryRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM scm_repositories WHERE id = ?")
      .bind(id)
      .first<ScmRepositoryRow>();
    return row ? rowToRecord(row) : null;
  }

  async getByExternalId(
    connectionId: string,
    externalId: string
  ): Promise<ScmRepositoryRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM scm_repositories WHERE connection_id = ? AND external_id = ?")
      .bind(connectionId, externalId)
      .first<ScmRepositoryRow>();
    return row ? rowToRecord(row) : null;
  }

  async getByPath(
    connectionId: string,
    owner: string,
    name: string
  ): Promise<ScmRepositoryRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM scm_repositories
         WHERE connection_id = ? AND path_key = ? AND removed_at IS NULL`
      )
      .bind(connectionId, pathKey(owner, name))
      .first<ScmRepositoryRow>();
    return row ? rowToRecord(row) : null;
  }

  async listResolved(connectionId: string): Promise<ScmRepositoryRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM scm_repositories
         WHERE connection_id = ? AND resolution_status = 'resolved' AND removed_at IS NULL
         ORDER BY lower(owner), lower(name), id`
      )
      .bind(connectionId)
      .all<ScmRepositoryRow>();
    return (result.results || []).map(rowToRecord);
  }

  async upsertResolved(input: ResolvedScmRepositoryInput): Promise<ScmRepositoryRecord> {
    if (!input.externalId.trim() || !input.owner.trim() || !input.name.trim()) {
      throw new ScmRepositoryConflictError("Resolved repository identity is incomplete");
    }
    assertCredentialFreeHttpsUrl(input.webUrl, "Repository web URL");
    assertCredentialFreeHttpsUrl(input.cloneUrl, "Repository clone URL");

    const normalizedPath = pathKey(input.owner, input.name);
    const [byExternal, byPath] = await Promise.all([
      this.getByExternalId(input.connectionId, input.externalId),
      this.getByPath(input.connectionId, input.owner, input.name),
    ]);
    if (byExternal && byPath && byExternal.id !== byPath.id) {
      throw new ScmRepositoryConflictError(
        "Repository external identity and current path resolve to different records"
      );
    }
    if (byPath?.externalId && byPath.externalId !== input.externalId) {
      throw new ScmRepositoryConflictError(
        "Repository path is already owned by another external id"
      );
    }

    const existing = byExternal ?? byPath;
    const id = existing?.id ?? `repo_${generateId(16)}`;
    const now = Date.now();
    const seenAt = input.seenAt ?? now;

    await this.db
      .prepare(
        `INSERT INTO scm_repositories (
           id, connection_id, external_id, owner, name, path_key, default_branch,
           web_url, clone_url, is_private, archived, resolution_status,
           last_seen_at, removed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'resolved', ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           external_id = excluded.external_id,
           owner = excluded.owner,
           name = excluded.name,
           path_key = excluded.path_key,
           default_branch = excluded.default_branch,
           web_url = excluded.web_url,
           clone_url = excluded.clone_url,
           is_private = excluded.is_private,
           archived = excluded.archived,
           resolution_status = 'resolved',
           last_seen_at = excluded.last_seen_at,
           removed_at = NULL,
           updated_at = excluded.updated_at`
      )
      .bind(
        id,
        input.connectionId,
        input.externalId,
        input.owner,
        input.name,
        normalizedPath,
        input.defaultBranch,
        input.webUrl,
        input.cloneUrl,
        input.private ? 1 : 0,
        input.archived ? 1 : 0,
        seenAt,
        existing?.createdAt ?? now,
        now
      )
      .run();

    return (await this.get(id))!;
  }

  async createUnresolvedLegacy(input: {
    connectionId: string;
    owner: string;
    name: string;
  }): Promise<ScmRepositoryRecord> {
    const existing = await this.getByPath(input.connectionId, input.owner, input.name);
    if (existing) return existing;
    const id = `repo_${generateId(16)}`;
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO scm_repositories (
           id, connection_id, owner, name, path_key, resolution_status,
           archived, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'unresolved', 0, ?, ?)`
      )
      .bind(
        id,
        input.connectionId,
        input.owner,
        input.name,
        pathKey(input.owner, input.name),
        now,
        now
      )
      .run();
    return (await this.get(id))!;
  }

  async markRemoved(id: string, removedAt: number = Date.now()): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE scm_repositories
         SET resolution_status = 'removed', removed_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(removedAt, removedAt, id)
      .run();
    return result.meta.changes === 1;
  }
}
