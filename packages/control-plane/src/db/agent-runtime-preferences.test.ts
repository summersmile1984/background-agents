import { describe, expect, it } from "vitest";
import {
  AgentRuntimePreferencesStore,
  AgentRuntimePreferencesValidationError,
} from "./agent-runtime-preferences";

class FakeStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: FakeDatabase,
    private readonly query: string
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    return this.db.first(this.query) as T | null;
  }

  async run<T>() {
    return this.db.run(this.query, this.values) as { results: T[]; meta: { changes: number } };
  }

  async all<T>() {
    return { results: [] as T[], meta: { changes: 0 } };
  }
}

class FakeDatabase {
  row: { default_agent_harness: string; enabled_harnesses: string } | null = null;

  prepare(query: string) {
    return new FakeStatement(this, query);
  }

  async batch() {
    return [];
  }

  first(query: string) {
    if (!query.includes("FROM agent_runtime_preferences")) throw new Error("Unexpected query");
    return this.row;
  }

  run(query: string, values: unknown[]) {
    if (!query.includes("INSERT INTO agent_runtime_preferences"))
      throw new Error("Unexpected query");
    this.row = {
      default_agent_harness: values[0] as string,
      enabled_harnesses: values[1] as string,
    };
    return { results: [], meta: { changes: 1 } };
  }
}

describe("AgentRuntimePreferencesStore", () => {
  it("uses the deployment default until a D1 preference is saved", async () => {
    const store = new AgentRuntimePreferencesStore(new FakeDatabase() as never);
    await expect(store.getEffective("claude")).resolves.toEqual({
      defaultAgentHarness: "claude",
      enabledHarnesses: ["opencode", "codex", "claude", "deepseek"],
    });
  });

  it("normalizes order and persists a valid preference", async () => {
    const db = new FakeDatabase();
    const store = new AgentRuntimePreferencesStore(db as never);
    await expect(
      store.set({ defaultAgentHarness: "codex", enabledHarnesses: ["deepseek", "codex", "codex"] })
    ).resolves.toEqual({ defaultAgentHarness: "codex", enabledHarnesses: ["codex", "deepseek"] });
    await expect(store.get()).resolves.toEqual({
      defaultAgentHarness: "codex",
      enabledHarnesses: ["codex", "deepseek"],
    });
  });

  it("rejects disabling the default Harness", async () => {
    const store = new AgentRuntimePreferencesStore(new FakeDatabase() as never);
    await expect(
      store.set({ defaultAgentHarness: "claude", enabledHarnesses: ["opencode"] })
    ).rejects.toBeInstanceOf(AgentRuntimePreferencesValidationError);
  });
});
