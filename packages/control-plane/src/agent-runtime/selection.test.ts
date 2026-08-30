import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { assertAgentRuntimeSelection } from "./selection";

const mockState = vi.hoisted(() => ({
  preferences: {
    defaultAgentHarness: "opencode",
    enabledHarnesses: ["opencode", "codex", "claude", "deepseek"],
  },
  globalSecrets: {} as Record<string, string>,
  environmentSecrets: new Map<string, Record<string, string>>(),
  repoSecrets: new Map<number, Record<string, string>>(),
}));

vi.mock("../db/agent-runtime-preferences", () => ({
  AgentRuntimePreferencesStore: class {
    async getEffective() {
      return mockState.preferences;
    }
  },
}));

vi.mock("../db/global-secrets", () => ({
  GlobalSecretsStore: class {
    async getDecryptedSecrets() {
      return mockState.globalSecrets;
    }
  },
}));

vi.mock("../db/environment-secrets", () => ({
  EnvironmentSecretsStore: class {
    async getDecryptedSecrets(environmentId: string) {
      return mockState.environmentSecrets.get(environmentId) ?? {};
    }
  },
}));

vi.mock("../db/repo-secrets", () => ({
  RepoSecretsStore: class {
    async getDecryptedSecrets(repoId: number) {
      return mockState.repoSecrets.get(repoId) ?? {};
    }
  },
}));

const db = {} as SqlDatabase;
const env = {
  REPO_SECRETS_ENCRYPTION_KEY: "encryption-key",
  MODEL_RELAY_PUBLIC_URL: "https://relay.example.com",
} as Env;

describe("assertAgentRuntimeSelection", () => {
  beforeEach(() => {
    mockState.preferences = {
      defaultAgentHarness: "opencode",
      enabledHarnesses: ["opencode", "codex", "claude", "deepseek"],
    };
    mockState.globalSecrets = {};
    mockState.environmentSecrets.clear();
    mockState.repoSecrets.clear();
  });

  it("accepts a credential from the selected environment scope", async () => {
    mockState.environmentSecrets.set("env-1", {
      CODEX_ACCESS_TOKEN: "env-token",
      CODEX_ACCESS_TOKEN_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
    });

    await expect(
      assertAgentRuntimeSelection({
        db,
        env,
        harness: "codex",
        model: "openai/gpt-5.3-codex",
        target: { environmentId: "env-1" },
      })
    ).resolves.toBeUndefined();
  });

  it("matches sandbox repository precedence with the primary repository last", async () => {
    mockState.repoSecrets.set(2, {
      CODEX_ACCESS_TOKEN: "secondary-token",
      CODEX_ACCESS_TOKEN_EXPIRES_AT: "2000-01-01T00:00:00.000Z",
    });
    mockState.repoSecrets.set(1, {
      CODEX_ACCESS_TOKEN: "primary-token",
      CODEX_ACCESS_TOKEN_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
    });

    await expect(
      assertAgentRuntimeSelection({
        db,
        env,
        harness: "codex",
        model: "openai/gpt-5.3-codex",
        target: {
          environmentId: null,
          repositories: [{ repoId: 1 }, { repoId: 2 }],
        },
      })
    ).resolves.toBeUndefined();
  });

  it("rejects an expired effective native credential", async () => {
    await expect(
      assertAgentRuntimeSelection({
        db,
        env,
        harness: "claude",
        model: "anthropic/claude-sonnet-4-5",
        effectiveSecrets: {
          CLAUDE_CODE_OAUTH_TOKEN: "setup-token",
          CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: "2000-01-01T00:00:00.000Z",
        },
      })
    ).rejects.toMatchObject({
      code: "CREDENTIAL_EXPIRED",
    });
  });

  it("rejects a provider that the harness cannot run", async () => {
    await expect(
      assertAgentRuntimeSelection({
        db,
        env,
        harness: "claude",
        model: "openai/gpt-5.3-codex",
        effectiveSecrets: {},
      })
    ).rejects.toMatchObject({
      code: "MODEL_INCOMPATIBLE",
    });
  });

  it("rejects OpenCode OpenAI models when only native Codex auth is present", async () => {
    await expect(
      assertAgentRuntimeSelection({
        db,
        env,
        harness: "opencode",
        model: "openai/gpt-5.6-luna",
        effectiveSecrets: { CODEX_AUTH_JSON: "native-codex-login" },
      })
    ).rejects.toMatchObject({
      code: "CREDENTIAL_MISSING",
      message: expect.stringContaining("select Codex"),
    });
  });

  it("accepts OpenCode OpenAI models with a managed OAuth refresh token", async () => {
    await expect(
      assertAgentRuntimeSelection({
        db,
        env,
        harness: "opencode",
        model: "openai/gpt-5.6-luna",
        effectiveSecrets: { OPENAI_OAUTH_REFRESH_TOKEN: "managed-refresh" },
      })
    ).resolves.toBeUndefined();
  });
});
