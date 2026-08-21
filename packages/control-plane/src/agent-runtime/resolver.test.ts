import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";

const state = vi.hoisted(() => ({
  preferences: {
    defaultAgentHarness: "opencode" as const,
    enabledHarnesses: ["opencode", "codex", "claude", "deepseek"] as const,
  },
  enabledModels: [
    "openai/gpt-5.6-luna",
    "anthropic/claude-haiku-4-5",
    "deepseek/deepseek-v4-flash",
  ],
  secrets: {} as Record<string, string>,
  configurations: new Map<string, Record<string, unknown>>(),
  legacyIntegration: {} as Record<string, unknown>,
}));

vi.mock("../db/agent-runtime-preferences", () => ({
  AgentRuntimePreferencesStore: class {
    async getEffective() {
      return state.preferences;
    }
  },
}));

vi.mock("../db/model-preferences", () => ({
  async getEffectiveEnabledModels() {
    return state.enabledModels;
  },
}));

vi.mock("../db/runtime-configurations", () => ({
  RuntimeConfigurationStore: class {
    async getMany(scopes: Array<{ scope: string; scopeId: string }>) {
      return scopes.map(({ scope, scopeId }) => {
        const config = state.configurations.get(`${scope}:${scopeId}`);
        return config
          ? {
              id: `${scope}:${scopeId}`,
              scope,
              scopeId,
              config,
              schemaVersion: 1,
              createdBy: null,
              createdAt: 1,
              updatedAt: 1,
            }
          : null;
      });
    }
  },
}));

vi.mock("../db/integration-settings", () => ({
  IntegrationSettingsStore: class {
    async getResolvedConfig() {
      return { repositoryEnabled: true, settings: state.legacyIntegration };
    }
    async getGlobal() {
      return { defaults: state.legacyIntegration };
    }
  },
}));

vi.mock("./selection", () => ({
  async loadEffectiveAgentRuntimeSecrets() {
    return state.secrets;
  },
}));

vi.mock("../db/scm-repositories", () => ({
  ScmRepositoryStore: class {
    async get(id: string) {
      return {
        id,
        connectionId: "scm-gitea",
        externalId: "42",
        owner: "huangdong",
        name: "n9n",
        defaultBranch: "main",
        webUrl: "https://gitea.example.com/huangdong/n9n",
        cloneUrl: "https://gitea.example.com/huangdong/n9n.git",
        resolutionStatus: "resolved",
        removedAt: null,
      };
    }
  },
}));

vi.mock("../db/scm-connections", () => ({
  ScmConnectionStore: class {
    async get() {
      return { id: "scm-gitea", provider: "gitea", enabled: true };
    }
  },
}));

vi.mock("../db/environments", () => ({
  EnvironmentStore: class {
    async getById() {
      return null;
    }
    async getRepositoriesForEnvironment() {
      return [];
    }
  },
}));

import { resolveRuntimeLaunchDraft } from "./resolver";

const env = {
  REPO_SECRETS_ENCRYPTION_KEY: "test-key",
  SANDBOX_RUNTIME_HARNESSES: "opencode,codex,claude,deepseek",
} as Env;

describe("runtime launch resolver", () => {
  beforeEach(() => {
    state.secrets = {};
    state.configurations.clear();
    state.legacyIntegration = {};
    state.enabledModels = [
      "openai/gpt-5.6-luna",
      "anthropic/claude-haiku-4-5",
      "deepseek/deepseek-v4-flash",
    ];
  });

  it("applies canonical user defaults and preserves provenance", async () => {
    state.configurations.set("user:user-1", {
      harness: "claude",
      model: "deepseek/deepseek-v4-flash",
      settings: { systemPromptAppend: "Prefer focused changes." },
    });
    const result = await resolveRuntimeLaunchDraft({
      db: {} as never,
      env,
      relayReady: true,
      configurationOwners: [{ scope: "user", id: "user-1" }],
      request: {
        target: { kind: "repository", repositoryKey: "repo-1" },
        runtime: {},
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.launchable).toBe(true);
    expect(result.effective.harness).toMatchObject({
      value: "claude",
      source: { scope: "user", id: "user-1" },
      inherited: true,
    });
    expect(result.effective.model?.value).toBe("deepseek/deepseek-v4-flash");
    expect(result.effective.settings.systemPromptAppend).toMatchObject({
      value: "Prefer focused changes.",
      source: { scope: "user", id: "user-1" },
    });
  });

  it("migrates legacy integration model defaults below canonical target layers", async () => {
    state.secrets = { ANTHROPIC_API_KEY: "test-key" };
    state.enabledModels.push("anthropic/claude-sonnet-4-6");
    state.legacyIntegration = {
      model: "deepseek/deepseek-v4-flash",
    };
    state.configurations.set("integration:slack", {
      harness: "claude",
      model: "anthropic/claude-sonnet-4-6",
    });
    state.configurations.set("repository:repo-1", { effort: "medium" });

    const result = await resolveRuntimeLaunchDraft({
      db: {} as never,
      env,
      relayReady: true,
      configurationOwners: [{ scope: "integration", id: "slack" }],
      request: {
        target: { kind: "repository", repositoryKey: "repo-1" },
        runtime: { harness: "inherit", model: "inherit", effort: "inherit" },
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.launchable).toBe(true);
    expect(result.effective.model).toMatchObject({
      value: "anthropic/claude-sonnet-4-6",
      source: { scope: "integration", id: "slack" },
    });
    expect(result.effective.effort).toMatchObject({
      value: "medium",
      source: { scope: "repository", id: "repo-1" },
    });
  });

  it("selects only a ready Claude route when Anthropic credentials are missing", async () => {
    const result = await resolveRuntimeLaunchDraft({
      db: {} as never,
      env,
      relayReady: true,
      request: {
        target: { kind: "repository", repositoryKey: "repo-1" },
        runtime: { harness: "claude" },
      },
    });

    expect(result.launchable).toBe(true);
    expect(result.effective.model?.value).toBe("deepseek/deepseek-v4-flash");
    expect(result.options.models.map((model) => model.model)).toEqual([
      "deepseek/deepseek-v4-flash",
    ]);
  });

  it("rejects an explicitly selected model on an unready provider route", async () => {
    const result = await resolveRuntimeLaunchDraft({
      db: {} as never,
      env,
      relayReady: true,
      request: {
        target: { kind: "repository", repositoryKey: "repo-1" },
        runtime: { harness: "claude", model: "anthropic/claude-haiku-4-5" },
      },
    });

    expect(result.launchable).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "CREDENTIAL_MISSING", field: "model" })
    );
  });

  it("rejects Codex max instead of silently dropping it", async () => {
    state.secrets = { CODEX_ACCESS_TOKEN: "token" };
    const result = await resolveRuntimeLaunchDraft({
      db: {} as never,
      env,
      relayReady: true,
      request: {
        target: { kind: "repository", repositoryKey: "repo-1" },
        runtime: {
          harness: "codex",
          model: "openai/gpt-5.6-luna",
          effort: "max",
        },
      },
    });

    expect(result.launchable).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "EFFORT_UNSUPPORTED", field: "effort" })
    );
    expect(result.options.efforts.map((effort) => effort.value)).not.toContain("max");
  });
});
