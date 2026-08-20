import type {
  McpServerConfig,
  McpServerMetadata,
  ValidatedCreateMcpServerInput,
  ValidatedUpdateMcpServerInput,
} from "@open-inspect/shared/types/integrations";
import { encryptToken, decryptToken } from "../auth/crypto";
import { createLogger } from "../logger";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase } from "./sql-database";

const log = createLogger("db:mcp-servers");

export class McpServerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerValidationError";
  }
}

export class McpServerConflictError extends Error {}

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

interface McpServerRow {
  id: string;
  revision: number;
  name: string;
  type: string;
  command: string | null;
  url: string | null;
  env: string;
  repo_scope: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface McpServerRepositoryScopeRow {
  mcp_server_id: string;
  repository_id: string;
}

function parseRepoScopes(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [raw];
  } catch {
    return [raw];
  }
}

function safeJsonParseCommand(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return [raw];
  }
}

function safeJsonParseEnv(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function rowToConfig(
  row: McpServerRow,
  payload: Record<string, string>,
  repositoryIds: string[] | null = null
): McpServerConfig {
  const envOrHeaders: Pick<McpServerConfig, "env" | "headers"> =
    row.type === "remote" ? { headers: payload } : { env: payload };
  return {
    id: row.id,
    name: row.name,
    type: row.type as "local" | "remote",
    command: row.type === "local" ? safeJsonParseCommand(row.command) : undefined,
    url: row.type === "remote" ? (row.url ?? undefined) : undefined,
    ...envOrHeaders,
    repositoryIds,
    repoScopes: parseRepoScopes(row.repo_scope),
    enabled: row.enabled === 1,
  };
}

function rowToMetadata(
  row: McpServerRow,
  repositoryIds: string[] | null = null
): McpServerMetadata {
  const hasCredentials = row.env !== "" && row.env !== "{}" && row.env !== "null";
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    type: row.type as "local" | "remote",
    command: row.type === "local" ? safeJsonParseCommand(row.command) : undefined,
    url: row.type === "remote" ? (row.url ?? undefined) : undefined,
    hasEnv: row.type === "local" && hasCredentials,
    hasHeaders: row.type === "remote" && hasCredentials,
    repositoryIds,
    repoScopes: parseRepoScopes(row.repo_scope),
    enabled: row.enabled === 1,
  };
}

export class McpServerStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey?: string
  ) {}

  /** Empty dicts are stored as plaintext "{}" so rowToMetadata() can detect "no credentials". */
  private async encryptEnv(env: Record<string, string>): Promise<string> {
    const plain = JSON.stringify(env);
    if (!this.encryptionKey || Object.keys(env).length === 0) return plain;
    return encryptToken(plain, this.encryptionKey);
  }

  private async decryptEnv(raw: string): Promise<Record<string, string>> {
    if (!this.encryptionKey) return safeJsonParseEnv(raw);
    try {
      const plain = await decryptToken(raw, this.encryptionKey);
      return safeJsonParseEnv(plain);
    } catch {
      // Decryption failed — try plaintext fallback (pre-encryption row)
      const plaintext = safeJsonParseEnv(raw);
      if (Object.keys(plaintext).length > 0) {
        log.warn("MCP server env decryption failed — treating as pre-encryption plaintext row", {
          event: "mcp_server.env_decrypt_fallback",
        });
        return plaintext;
      }
      log.error("MCP server env decryption failed and raw value is not plaintext JSON", {
        event: "mcp_server.env_decrypt_error",
      });
      return {};
    }
  }

  private async decryptRow(
    row: McpServerRow,
    repositoryIds: string[] | null = null
  ): Promise<McpServerConfig> {
    const env = await this.decryptEnv(row.env);
    return rowToConfig(row, env, repositoryIds);
  }

  private async repositoryScopesByServer(serverIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (serverIds.length === 0) return result;
    const placeholders = serverIds.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(
        `SELECT mcp_server_id, repository_id
         FROM mcp_server_repository_scopes
         WHERE mcp_server_id IN (${placeholders})
         ORDER BY mcp_server_id, repository_id`
      )
      .bind(...serverIds)
      .all<McpServerRepositoryScopeRow>();
    for (const row of results) {
      if (typeof row.mcp_server_id !== "string" || typeof row.repository_id !== "string") continue;
      const repositoryIds = result.get(row.mcp_server_id) ?? [];
      repositoryIds.push(row.repository_id);
      result.set(row.mcp_server_id, repositoryIds);
    }
    return result;
  }

  async list(repoScope?: string, repositoryId?: string): Promise<McpServerMetadata[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM mcp_servers ORDER BY name")
      .all<McpServerRow>();
    const stableScopes = await this.repositoryScopesByServer(results.map((row) => row.id));
    const metadata = results.map((row) => rowToMetadata(row, stableScopes.get(row.id) ?? null));
    if (repoScope === undefined && repositoryId === undefined) return metadata;
    const normalized = repoScope?.toLowerCase();
    return metadata.filter((c) => {
      const hasLegacyScope = Boolean(c.repoScopes?.length);
      const hasStableScope = Boolean(c.repositoryIds?.length);
      if (!hasLegacyScope && !hasStableScope) return true;
      if (repositoryId && c.repositoryIds?.includes(repositoryId)) return true;
      if (repositoryId) return false;
      return Boolean(normalized && c.repoScopes?.some((s) => s.toLowerCase() === normalized));
    });
  }

  async get(id: string): Promise<McpServerMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE id = ?")
      .bind(id)
      .first<McpServerRow>();
    if (!row) return null;
    const stableScopes = await this.repositoryScopesByServer([id]);
    return rowToMetadata(row, stableScopes.get(id) ?? null);
  }

  async create(config: ValidatedCreateMcpServerInput): Promise<McpServerMetadata> {
    const id = generateId();
    const now = Date.now();

    if (config.type === "local" && (!config.command || config.command.length === 0)) {
      throw new McpServerValidationError("Local MCP servers require a command");
    }
    if (config.type === "remote" && !config.url) {
      throw new McpServerValidationError("remote MCP servers require a URL");
    }
    if (config.repositoryIds?.length && config.repoScopes?.length) {
      throw new McpServerValidationError(
        "MCP repositoryIds and legacy repoScopes cannot both be configured"
      );
    }

    const encryptedEnv = await this.encryptEnv(
      config.type === "remote" ? (config.headers ?? {}) : (config.env ?? {})
    );

    try {
      const insert = this.db
        .prepare(
          `INSERT INTO mcp_servers (id, name, type, command, url, env, repo_scope, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          config.name,
          config.type,
          config.type === "local" ? JSON.stringify(config.command) : null,
          config.type === "remote" ? config.url : null,
          encryptedEnv,
          config.repoScopes?.length
            ? JSON.stringify(config.repoScopes.map((r) => r.toLowerCase()))
            : null,
          config.enabled ? 1 : 0,
          now,
          now
        );
      if (config.repositoryIds?.length) {
        await this.db.batch([
          insert,
          ...config.repositoryIds.map((repositoryId) =>
            this.db
              .prepare(
                `INSERT INTO mcp_server_repository_scopes
                   (mcp_server_id, repository_id, created_at)
                 VALUES (?, ?, ?)`
              )
              .bind(id, repositoryId, now)
          ),
        ]);
      } else {
        await insert.run();
      }
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new McpServerValidationError(`An MCP server named '${config.name}' already exists`);
      }
      throw err;
    }

    const created = await this.get(id);
    if (!created) {
      throw new Error(`MCP server '${id}' not found after insert — this should not happen`);
    }
    return created;
  }

  async update(
    id: string,
    patch: ValidatedUpdateMcpServerInput,
    expectedRevision?: number
  ): Promise<McpServerMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE id = ?")
      .bind(id)
      .first<McpServerRow>();
    if (!row) return null;
    if (expectedRevision !== undefined && row.revision !== expectedRevision) {
      throw new McpServerConflictError("MCP server changed; reload and try again");
    }
    if (patch.repositoryIds?.length && patch.repoScopes?.length) {
      throw new McpServerValidationError(
        "MCP repositoryIds and legacy repoScopes cannot both be configured"
      );
    }

    const mergedType = patch.type ?? (row.type as "local" | "remote");
    if (mergedType === "local" && (patch.url !== undefined || patch.headers !== undefined)) {
      throw new McpServerValidationError("Local MCP servers do not support url or headers");
    }
    if (mergedType === "remote" && (patch.command !== undefined || patch.env !== undefined)) {
      throw new McpServerValidationError("Remote MCP servers do not support command or env");
    }

    const credentialsChanged =
      patch.env !== undefined || patch.headers !== undefined || patch.type !== undefined;

    let encryptedEnv: string;
    if (credentialsChanged) {
      const existing = await this.decryptRow(row);
      const mergedType = patch.type ?? existing.type;
      const mergedEnv = patch.env !== undefined ? patch.env : existing.env;
      const mergedHeaders = patch.headers !== undefined ? patch.headers : existing.headers;
      encryptedEnv = await this.encryptEnv(
        mergedType === "remote" ? (mergedHeaders ?? {}) : (mergedEnv ?? {})
      );
    } else {
      encryptedEnv = row.env;
    }

    const mergedCommand =
      patch.command !== undefined ? patch.command : safeJsonParseCommand(row.command);
    const mergedUrl = patch.url !== undefined ? patch.url : (row.url ?? undefined);

    if (mergedType === "local" && (!mergedCommand || mergedCommand.length === 0)) {
      throw new McpServerValidationError("Local MCP servers require a command");
    }
    if (mergedType === "remote" && !mergedUrl) {
      throw new McpServerValidationError("remote MCP servers require a URL");
    }

    const now = Date.now();
    const scopeChanged = patch.repositoryIds !== undefined || patch.repoScopes !== undefined;
    const nextRepoScope =
      patch.repositoryIds !== undefined
        ? null
        : patch.repoScopes !== undefined
          ? patch.repoScopes?.length
            ? JSON.stringify(patch.repoScopes.map((r) => r.toLowerCase()))
            : null
          : row.repo_scope;

    try {
      const statement = this.db.prepare(
        `UPDATE mcp_servers SET name = ?, type = ?, command = ?, url = ?, env = ?, repo_scope = ?, enabled = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = COALESCE(?, revision)${scopeChanged ? "" : " RETURNING *"}`
      );
      const boundStatement = statement.bind(
        patch.name ?? row.name,
        mergedType,
        mergedType === "local" && mergedCommand ? JSON.stringify(mergedCommand) : null,
        mergedType === "remote" ? (mergedUrl ?? null) : null,
        encryptedEnv,
        nextRepoScope,
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
        now,
        id,
        expectedRevision ?? null
      );
      if (scopeChanged) {
        const [updateResult] = await this.db.batch([
          boundStatement,
          this.db
            .prepare("DELETE FROM mcp_server_repository_scopes WHERE mcp_server_id = ?")
            .bind(id),
          ...(patch.repositoryIds ?? []).map((repositoryId) =>
            this.db
              .prepare(
                `INSERT INTO mcp_server_repository_scopes
                   (mcp_server_id, repository_id, created_at)
                 VALUES (?, ?, ?)`
              )
              .bind(id, repositoryId, now)
          ),
        ]);
        if ((updateResult.meta?.changes ?? 0) === 0) {
          throw new McpServerConflictError("MCP server changed; reload and try again");
        }
        const updated = await this.get(id);
        if (!updated) {
          throw new McpServerConflictError("MCP server changed; reload and try again");
        }
        return updated;
      }
      const updated = await boundStatement.first<McpServerRow>();
      if (!updated) {
        throw new McpServerConflictError("MCP server changed; reload and try again");
      }
      const stableScopes = await this.repositoryScopesByServer([id]);
      return rowToMetadata(updated, stableScopes.get(id) ?? null);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new McpServerValidationError(
          `An MCP server named '${patch.name ?? row.name}' already exists`
        );
      }
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").bind(id).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Servers applicable to a session's member repositories: unscoped servers
   * always apply; scoped servers apply when ANY member matches a scope.
   * Pass an empty list for repo-less sessions (unscoped servers only).
   */
  async getDecryptedForSession(
    repositories: Array<{
      repoOwner: string;
      repoName: string;
      repositoryKey?: string | null;
    }>
  ): Promise<McpServerConfig[]> {
    const repoFullNames = new Set(
      repositories.map((repo) => `${repo.repoOwner}/${repo.repoName}`.toLowerCase())
    );
    const { results } = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name")
      .all<McpServerRow>();
    const stableScopes = await this.repositoryScopesByServer(results.map((row) => row.id));
    const repositoryKeys = new Set(
      repositories.flatMap((repository) =>
        repository.repositoryKey ? [repository.repositoryKey] : []
      )
    );

    const filtered = results.filter((row) => {
      const legacyScopes = parseRepoScopes(row.repo_scope);
      const repositoryIds = stableScopes.get(row.id);
      if (!legacyScopes?.length && !repositoryIds?.length) return true;
      if (repositoryIds?.some((repositoryId) => repositoryKeys.has(repositoryId))) return true;
      // Once a session has a stable repository identity, legacy owner/name
      // scopes are not an authority: the same path may exist on another forge.
      if (repositoryKeys.size > 0) return false;
      return Boolean(legacyScopes?.some((s) => repoFullNames.has(s.toLowerCase())));
    });

    return Promise.all(
      filtered.map((row) => this.decryptRow(row, stableScopes.get(row.id) ?? null))
    );
  }
}
