import {
  EMPTY_SOURCE_CONTROL_CAPABILITIES,
  sourceControlCapabilitiesSchema,
  type ScmConnectionAuthMode,
  type ScmConnectionHealth,
  type ScmCredentialSource,
  type SourceControlCapabilities,
  type SourceControlConnectionSummary,
  type SourceControlProviderName,
} from "@open-inspect/shared/types/source-control";
import { decryptToken, encryptToken } from "../auth/crypto";
import type { SqlDatabase } from "./sql-database";

const CONNECTION_ID_PATTERN = /^scm_[a-z0-9][a-z0-9_-]{1,126}$/;
const CREDENTIAL_PURPOSES = [
  "service_token",
  "github_app_private_key",
  "oauth_client_secret",
  "webhook_secret",
] as const;

export type ScmConnectionCredentialPurpose = (typeof CREDENTIAL_PURPOSES)[number];

interface ScmConnectionRow {
  id: string;
  provider: SourceControlProviderName;
  display_name: string;
  base_url: string;
  api_base_url: string;
  clone_base_url: string;
  auth_mode: ScmConnectionAuthMode;
  credential_source: ScmCredentialSource;
  credential_ref: string | null;
  username: string | null;
  capabilities_json: string;
  version: string | null;
  revision: number;
  enabled: number;
  is_default: number;
  last_checked_at: number | null;
  last_error_code: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface ScmConnectionRecord extends SourceControlConnectionSummary {
  apiBaseUrl: string;
  cloneBaseUrl: string;
  credentialSource: ScmCredentialSource;
  credentialRef: string | null;
  username: string | null;
  revision: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateScmConnectionInput {
  id: string;
  provider: SourceControlProviderName;
  displayName: string;
  baseUrl: string;
  apiBaseUrl: string;
  cloneBaseUrl: string;
  authMode: ScmConnectionAuthMode;
  credentialSource: ScmCredentialSource;
  credentialRef?: string | null;
  username?: string | null;
  capabilities?: SourceControlCapabilities;
  enabled?: boolean;
  isDefault?: boolean;
  createdBy: string;
}

export interface ReplaceScmConnectionConfigInput extends Omit<
  CreateScmConnectionInput,
  "id" | "createdBy" | "isDefault"
> {
  expectedRevision: number;
}

export class ScmConnectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScmConnectionValidationError";
  }
}

export class ScmConnectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScmConnectionConflictError";
  }
}

function healthFor(row: ScmConnectionRow): ScmConnectionHealth {
  if (row.enabled !== 1) return "disabled";
  if (row.last_error_code) return "degraded";
  return row.last_checked_at == null ? "unknown" : "healthy";
}

function parseCapabilities(raw: string): SourceControlCapabilities {
  try {
    const parsed = sourceControlCapabilitiesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : EMPTY_SOURCE_CONTROL_CAPABILITIES;
  } catch {
    return EMPTY_SOURCE_CONTROL_CAPABILITIES;
  }
}

function rowToRecord(row: ScmConnectionRow): ScmConnectionRecord {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    baseUrl: row.base_url,
    apiBaseUrl: row.api_base_url,
    cloneBaseUrl: row.clone_base_url,
    authMode: row.auth_mode,
    credentialSource: row.credential_source,
    credentialRef: row.credential_ref,
    username: row.username,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    health: healthFor(row),
    capabilities: parseCapabilities(row.capabilities_json),
    version: row.version,
    revision: row.revision,
    lastCheckedAt: row.last_checked_at,
    lastErrorCode: row.last_error_code,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateConnectionInput(input: CreateScmConnectionInput): void {
  if (!CONNECTION_ID_PATTERN.test(input.id)) {
    throw new ScmConnectionValidationError("Invalid SCM connection id");
  }
  if (!input.displayName.trim() || input.displayName.trim().length > 100) {
    throw new ScmConnectionValidationError("Connection display name must be 1-100 characters");
  }
  if (!input.createdBy.trim()) {
    throw new ScmConnectionValidationError("Connection creator is required");
  }
  if (input.credentialSource === "worker_binding" && !input.credentialRef?.trim()) {
    throw new ScmConnectionValidationError(
      "Worker-binding connections require a credential reference"
    );
  }
}

export class ScmConnectionStore {
  constructor(private readonly db: SqlDatabase) {}

  private createStatement(input: CreateScmConnectionInput, now: number) {
    const capabilities = input.capabilities ?? EMPTY_SOURCE_CONTROL_CAPABILITIES;
    return this.db
      .prepare(
        `INSERT INTO scm_connections (
           id, provider, display_name, base_url, api_base_url, clone_base_url,
           auth_mode, credential_source, credential_ref, username,
           capabilities_json, enabled, is_default, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        input.provider,
        input.displayName.trim(),
        input.baseUrl,
        input.apiBaseUrl,
        input.cloneBaseUrl,
        input.authMode,
        input.credentialSource,
        input.credentialRef?.trim() || null,
        input.username?.trim() || null,
        JSON.stringify(sourceControlCapabilitiesSchema.parse(capabilities)),
        input.enabled === false ? 0 : 1,
        input.isDefault === true ? 1 : 0,
        input.createdBy.trim(),
        now,
        now
      );
  }

  async create(input: CreateScmConnectionInput): Promise<ScmConnectionRecord> {
    validateConnectionInput(input);
    const now = Date.now();
    await this.createStatement(input, now).run();

    return (await this.get(input.id))!;
  }

  /**
   * Atomically creates a PAT-backed connection and its encrypted service
   * credential. This prevents a partially-created enabled connection when a
   * credential write fails after the metadata insert.
   */
  async createWithEncryptedServiceCredential(
    input: CreateScmConnectionInput,
    secret: string,
    encryptionKey: string
  ): Promise<ScmConnectionRecord> {
    validateConnectionInput(input);
    if (input.credentialSource !== "encrypted_d1" || input.authMode !== "pat" || !secret) {
      throw new ScmConnectionValidationError(
        "Encrypted PAT connection creation requires a non-empty service credential"
      );
    }
    const now = Date.now();
    const ciphertext = await encryptToken(secret, encryptionKey);
    await this.db.batch([
      this.createStatement(input, now),
      this.db
        .prepare(
          `INSERT INTO scm_connection_credentials (
             connection_id, purpose, ciphertext, encryption_format_version,
             expires_at, created_at, updated_at
           ) VALUES (?, 'service_token', ?, 1, NULL, ?, ?)`
        )
        .bind(input.id, ciphertext, now, now),
    ]);
    return (await this.get(input.id))!;
  }

  async get(id: string): Promise<ScmConnectionRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM scm_connections WHERE id = ?")
      .bind(id)
      .first<ScmConnectionRow>();
    return row ? rowToRecord(row) : null;
  }

  async getDefault(): Promise<ScmConnectionRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM scm_connections WHERE is_default = 1 AND enabled = 1")
      .first<ScmConnectionRow>();
    return row ? rowToRecord(row) : null;
  }

  async list(options: { includeDisabled?: boolean } = {}): Promise<ScmConnectionRecord[]> {
    const result = await this.db
      .prepare(
        options.includeDisabled
          ? "SELECT * FROM scm_connections ORDER BY is_default DESC, lower(display_name), id"
          : "SELECT * FROM scm_connections WHERE enabled = 1 ORDER BY is_default DESC, lower(display_name), id"
      )
      .all<ScmConnectionRow>();
    return (result.results || []).map(rowToRecord);
  }

  async replaceConfig(
    id: string,
    input: ReplaceScmConnectionConfigInput
  ): Promise<ScmConnectionRecord> {
    validateConnectionInput({ ...input, id, createdBy: "existing" });
    const now = Date.now();
    const capabilities = input.capabilities ?? EMPTY_SOURCE_CONTROL_CAPABILITIES;
    const result = await this.db
      .prepare(
        `UPDATE scm_connections SET
           provider = ?, display_name = ?, base_url = ?, api_base_url = ?, clone_base_url = ?,
           auth_mode = ?, credential_source = ?, credential_ref = ?, username = ?,
           capabilities_json = ?, enabled = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`
      )
      .bind(
        input.provider,
        input.displayName.trim(),
        input.baseUrl,
        input.apiBaseUrl,
        input.cloneBaseUrl,
        input.authMode,
        input.credentialSource,
        input.credentialRef?.trim() || null,
        input.username?.trim() || null,
        JSON.stringify(sourceControlCapabilitiesSchema.parse(capabilities)),
        input.enabled === false ? 0 : 1,
        now,
        id,
        input.expectedRevision
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new ScmConnectionConflictError("SCM connection changed or does not exist");
    }
    return (await this.get(id))!;
  }

  /** Atomically replaces connection metadata and its encrypted PAT. */
  async replaceConfigWithEncryptedServiceCredential(
    id: string,
    input: ReplaceScmConnectionConfigInput,
    secret: string,
    encryptionKey: string
  ): Promise<ScmConnectionRecord> {
    validateConnectionInput({ ...input, id, createdBy: "existing" });
    if (input.credentialSource !== "encrypted_d1" || input.authMode !== "pat" || !secret) {
      throw new ScmConnectionValidationError(
        "Encrypted PAT connection update requires a non-empty service credential"
      );
    }
    const now = Date.now();
    const capabilities = input.capabilities ?? EMPTY_SOURCE_CONTROL_CAPABILITIES;
    const ciphertext = await encryptToken(secret, encryptionKey);
    const [updateResult, credentialResult] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE scm_connections SET
             provider = ?, display_name = ?, base_url = ?, api_base_url = ?, clone_base_url = ?,
             auth_mode = ?, credential_source = ?, credential_ref = ?, username = ?,
             capabilities_json = ?, enabled = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`
        )
        .bind(
          input.provider,
          input.displayName.trim(),
          input.baseUrl,
          input.apiBaseUrl,
          input.cloneBaseUrl,
          input.authMode,
          input.credentialSource,
          input.credentialRef?.trim() || null,
          input.username?.trim() || null,
          JSON.stringify(sourceControlCapabilitiesSchema.parse(capabilities)),
          input.enabled === false ? 0 : 1,
          now,
          id,
          input.expectedRevision
        ),
      this.db
        .prepare(
          `INSERT INTO scm_connection_credentials (
             connection_id, purpose, ciphertext, encryption_format_version,
             expires_at, created_at, updated_at
           )
           SELECT id, 'service_token', ?, 1, NULL, ?, ?
           FROM scm_connections WHERE id = ? AND revision = ?
           ON CONFLICT(connection_id, purpose) DO UPDATE SET
             ciphertext = excluded.ciphertext,
             encryption_format_version = excluded.encryption_format_version,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`
        )
        .bind(ciphertext, now, now, id, input.expectedRevision + 1),
    ]);
    if (updateResult.meta.changes !== 1 || credentialResult.meta.changes !== 1) {
      throw new ScmConnectionConflictError("SCM connection changed or does not exist");
    }
    return (await this.get(id))!;
  }

  async setDefault(id: string): Promise<void> {
    const target = await this.get(id);
    if (!target?.enabled) {
      throw new ScmConnectionValidationError("Default SCM connection must exist and be enabled");
    }
    if (target.isDefault) return;
    const now = Date.now();
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE scm_connections SET is_default = 0, revision = revision + 1, updated_at = ? WHERE is_default = 1"
        )
        .bind(now),
      this.db
        .prepare(
          "UPDATE scm_connections SET is_default = 1, revision = revision + 1, updated_at = ? WHERE id = ? AND enabled = 1"
        )
        .bind(now, id),
    ]);
  }

  async disable(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE scm_connections
         SET enabled = 0, is_default = 0, revision = revision + 1, updated_at = ?
         WHERE id = ?`
      )
      .bind(Date.now(), id)
      .run();
    return result.meta.changes === 1;
  }

  async recordHealth(
    id: string,
    result: { version?: string | null; errorCode?: string | null; checkedAt?: number }
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE scm_connections
         SET version = ?, last_error_code = ?, last_checked_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        result.version ?? null,
        result.errorCode ?? null,
        result.checkedAt ?? Date.now(),
        Date.now(),
        id
      )
      .run();
  }
}

interface ScmCredentialRow {
  ciphertext: string;
  encryption_format_version: number;
  expires_at: number | null;
}

export interface ResolvedScmCredential {
  secret: string;
  encryptionFormatVersion: number;
  expiresAt: number | null;
}

export class ScmConnectionCredentialStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  async set(
    connectionId: string,
    purpose: ScmConnectionCredentialPurpose,
    secret: string,
    options: { expiresAt?: number | null } = {}
  ): Promise<void> {
    if (!CREDENTIAL_PURPOSES.includes(purpose) || !secret) {
      throw new ScmConnectionValidationError("A valid non-empty SCM credential is required");
    }
    const now = Date.now();
    const ciphertext = await encryptToken(secret, this.encryptionKey);
    await this.db
      .prepare(
        `INSERT INTO scm_connection_credentials (
           connection_id, purpose, ciphertext, encryption_format_version,
           expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(connection_id, purpose) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           encryption_format_version = excluded.encryption_format_version,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`
      )
      .bind(connectionId, purpose, ciphertext, options.expiresAt ?? null, now, now)
      .run();
  }

  async get(
    connectionId: string,
    purpose: ScmConnectionCredentialPurpose
  ): Promise<ResolvedScmCredential | null> {
    const row = await this.db
      .prepare(
        `SELECT ciphertext, encryption_format_version, expires_at
         FROM scm_connection_credentials WHERE connection_id = ? AND purpose = ?`
      )
      .bind(connectionId, purpose)
      .first<ScmCredentialRow>();
    if (!row) return null;
    return {
      secret: await decryptToken(row.ciphertext, this.encryptionKey),
      encryptionFormatVersion: row.encryption_format_version,
      expiresAt: row.expires_at,
    };
  }

  async has(connectionId: string, purpose: ScmConnectionCredentialPurpose): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 AS present FROM scm_connection_credentials WHERE connection_id = ? AND purpose = ?"
      )
      .bind(connectionId, purpose)
      .first<{ present: number }>();
    return row?.present === 1;
  }

  async delete(connectionId: string, purpose: ScmConnectionCredentialPurpose): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM scm_connection_credentials WHERE connection_id = ? AND purpose = ?")
      .bind(connectionId, purpose)
      .run();
    return result.meta.changes === 1;
  }
}
