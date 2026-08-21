import {
  persistedRuntimeConfigurationScopeSchema,
  runtimeConfigFragmentSchema,
  runtimeConfigurationRecordSchema,
  type PersistedRuntimeConfigurationScope,
  type RuntimeConfigFragment,
  type RuntimeConfigurationRecord,
} from "@open-inspect/shared/types/runtime-launch";
import type { SqlDatabase } from "./sql-database";

interface RuntimeConfigurationRow {
  id: string;
  scope_type: string;
  scope_id: string;
  config_json: string;
  schema_version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export class RuntimeConfigurationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigurationValidationError";
  }
}

function identifier(scope: PersistedRuntimeConfigurationScope, scopeId: string): string {
  return `${scope}:${scopeId}`;
}

function parseRow(row: RuntimeConfigurationRow): RuntimeConfigurationRecord {
  let config: unknown;
  try {
    config = JSON.parse(row.config_json);
  } catch {
    throw new Error("Stored runtime configuration must be valid JSON");
  }
  const parsed = runtimeConfigurationRecordSchema.safeParse({
    id: row.id,
    scope: row.scope_type,
    scopeId: row.scope_id,
    config,
    schemaVersion: row.schema_version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (!parsed.success) throw new Error("Stored runtime configuration is invalid");
  return parsed.data;
}

export class RuntimeConfigurationStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(
    scope: PersistedRuntimeConfigurationScope,
    scopeId: string
  ): Promise<RuntimeConfigurationRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, scope_type, scope_id, config_json, schema_version,
                created_by, created_at, updated_at
         FROM runtime_configurations WHERE scope_type = ? AND scope_id = ?`
      )
      .bind(scope, scopeId)
      .first<RuntimeConfigurationRow>();
    return row ? parseRow(row) : null;
  }

  async getMany(
    scopes: readonly { scope: PersistedRuntimeConfigurationScope; scopeId: string }[]
  ): Promise<Array<RuntimeConfigurationRecord | null>> {
    return Promise.all(scopes.map(({ scope, scopeId }) => this.get(scope, scopeId)));
  }

  async set(input: {
    scope: PersistedRuntimeConfigurationScope;
    scopeId: string;
    config: RuntimeConfigFragment;
    createdBy: string | null;
  }): Promise<RuntimeConfigurationRecord> {
    const parsedScope = persistedRuntimeConfigurationScopeSchema.safeParse(input.scope);
    const parsedConfig = runtimeConfigFragmentSchema.safeParse(input.config);
    const scopeId = input.scopeId.trim();
    if (!parsedScope.success || !scopeId || !parsedConfig.success) {
      throw new RuntimeConfigurationValidationError(
        parsedConfig.success
          ? "Runtime configuration scope is invalid"
          : (parsedConfig.error.issues[0]?.message ?? "Runtime configuration is invalid")
      );
    }
    const now = Date.now();
    const id = identifier(parsedScope.data, scopeId);
    await this.db
      .prepare(
        `INSERT INTO runtime_configurations
           (id, scope_type, scope_id, config_json, schema_version,
            created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(scope_type, scope_id) DO UPDATE SET
           config_json = excluded.config_json,
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`
      )
      .bind(
        id,
        parsedScope.data,
        scopeId,
        JSON.stringify(parsedConfig.data),
        input.createdBy,
        now,
        now
      )
      .run();
    const saved = await this.get(parsedScope.data, scopeId);
    if (!saved) throw new Error("Runtime configuration write did not persist");
    return saved;
  }

  async delete(scope: PersistedRuntimeConfigurationScope, scopeId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM runtime_configurations WHERE scope_type = ? AND scope_id = ?")
      .bind(scope, scopeId)
      .run();
    return Number(result.meta.changes ?? 0) > 0;
  }
}
