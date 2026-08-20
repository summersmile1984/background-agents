import { generateId, hashToken } from "../auth/crypto";
import type { SqlDatabase } from "./sql-database";

export type ScmGitCapabilityAudience = "session_git" | "image_build_git";

interface ScmGitCapabilityRow {
  token_hash: string;
  audience: ScmGitCapabilityAudience;
  subject_id: string;
  connection_id: string;
  repository_ids: string;
  allowed_operation: "read" | "write";
  expires_at: number;
  revoked_at: number | null;
}

export interface ScmGitCapability {
  audience: ScmGitCapabilityAudience;
  subjectId: string;
  connectionId: string;
  repositoryIds: string[];
  allowedOperation: "read" | "write";
  expiresAt: number;
}

export class ScmGitCapabilityStore {
  constructor(private readonly db: SqlDatabase) {}

  async issue(input: ScmGitCapability): Promise<string> {
    const token = `oig_${generateId(32)}`;
    const tokenHash = await hashToken(token);
    await this.db
      .prepare(
        `INSERT INTO scm_git_capabilities
         (token_hash, audience, subject_id, connection_id, repository_ids,
          allowed_operation, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .bind(
        tokenHash,
        input.audience,
        input.subjectId,
        input.connectionId,
        JSON.stringify(input.repositoryIds),
        input.allowedOperation,
        input.expiresAt,
        Date.now()
      )
      .run();
    return token;
  }

  async verify(
    token: string,
    expected: {
      audience: ScmGitCapabilityAudience;
      subjectId: string;
      repositoryId: string;
      operation: "read" | "write";
    }
  ): Promise<ScmGitCapability | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM scm_git_capabilities
         WHERE token_hash = ? AND audience = ? AND subject_id = ?
           AND revoked_at IS NULL AND expires_at > ?`
      )
      .bind(await hashToken(token), expected.audience, expected.subjectId, Date.now())
      .first<ScmGitCapabilityRow>();
    if (!row || (expected.operation === "write" && row.allowed_operation !== "write")) return null;
    let repositoryIds: string[];
    try {
      repositoryIds = JSON.parse(row.repository_ids) as string[];
    } catch {
      return null;
    }
    if (!repositoryIds.includes(expected.repositoryId)) return null;
    return {
      audience: row.audience,
      subjectId: row.subject_id,
      connectionId: row.connection_id,
      repositoryIds,
      allowedOperation: row.allowed_operation,
      expiresAt: row.expires_at,
    };
  }

  async revoke(audience: ScmGitCapabilityAudience, subjectId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE scm_git_capabilities SET revoked_at = ?
         WHERE audience = ? AND subject_id = ? AND revoked_at IS NULL`
      )
      .bind(Date.now(), audience, subjectId)
      .run();
  }
}
