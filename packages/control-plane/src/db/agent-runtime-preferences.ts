import {
  AGENT_HARNESSES,
  agentHarnessSchema,
  type AgentHarness,
} from "@open-inspect/shared/types/agent-harness";
import {
  DEFAULT_AGENT_RUNTIME_PREFERENCES,
  agentRuntimePreferencesSchema,
  type AgentRuntimePreferences,
} from "@open-inspect/shared/types/agent-runtime";
import type { SqlDatabase } from "./sql-database";

interface AgentRuntimePreferencesRow {
  default_agent_harness: string;
  enabled_harnesses: string;
}

export class AgentRuntimePreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimePreferencesValidationError";
  }
}

function parseStoredPreferences(row: AgentRuntimePreferencesRow): AgentRuntimePreferences {
  let enabledHarnesses: unknown;
  try {
    enabledHarnesses = JSON.parse(row.enabled_harnesses);
  } catch {
    throw new Error("Stored enabled harnesses must be valid JSON");
  }
  const parsed = agentRuntimePreferencesSchema.safeParse({
    defaultAgentHarness: row.default_agent_harness,
    enabledHarnesses,
  });
  if (!parsed.success) throw new Error("Stored agent runtime preferences are invalid");
  return parsed.data;
}

export class AgentRuntimePreferencesStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(): Promise<AgentRuntimePreferences | null> {
    const row = await this.db
      .prepare(
        "SELECT default_agent_harness, enabled_harnesses FROM agent_runtime_preferences WHERE id = 'global'"
      )
      .first<AgentRuntimePreferencesRow>();
    return row ? parseStoredPreferences(row) : null;
  }

  async getEffective(deploymentDefault?: string): Promise<AgentRuntimePreferences> {
    const stored = await this.get();
    if (stored) return stored;
    const parsedDefault = agentHarnessSchema.safeParse(deploymentDefault);
    return {
      ...DEFAULT_AGENT_RUNTIME_PREFERENCES,
      defaultAgentHarness: parsedDefault.success
        ? parsedDefault.data
        : DEFAULT_AGENT_RUNTIME_PREFERENCES.defaultAgentHarness,
    };
  }

  async set(input: {
    defaultAgentHarness: AgentHarness;
    enabledHarnesses: AgentHarness[];
  }): Promise<AgentRuntimePreferences> {
    const normalizedEnabled = AGENT_HARNESSES.filter((harness) =>
      new Set(input.enabledHarnesses).has(harness)
    );
    const parsed = agentRuntimePreferencesSchema.safeParse({
      defaultAgentHarness: input.defaultAgentHarness,
      enabledHarnesses: normalizedEnabled,
    });
    if (!parsed.success) {
      throw new AgentRuntimePreferencesValidationError(
        parsed.error.issues[0]?.message ?? "Invalid agent runtime preferences"
      );
    }

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO agent_runtime_preferences
           (id, default_agent_harness, enabled_harnesses, created_at, updated_at)
         VALUES ('global', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           default_agent_harness = excluded.default_agent_harness,
           enabled_harnesses = excluded.enabled_harnesses,
           updated_at = excluded.updated_at`
      )
      .bind(parsed.data.defaultAgentHarness, JSON.stringify(parsed.data.enabledHarnesses), now, now)
      .run();
    return parsed.data;
  }
}
