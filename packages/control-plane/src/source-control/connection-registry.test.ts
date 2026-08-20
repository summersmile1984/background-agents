import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScmConnectionRecord } from "../db/scm-connections";
import type { Env } from "../types";

const mocks = vi.hoisted(() => ({
  factory: vi.fn(),
}));

vi.mock("./providers", () => ({
  createSourceControlProvider: (...args: unknown[]) => mocks.factory(...args),
}));

import { ScmConnectionDisabledError, SourceControlConnectionRegistry } from "./connection-registry";

function record(overrides: Partial<ScmConnectionRecord> = {}): ScmConnectionRecord {
  return {
    id: "scm_gitea_a",
    provider: "gitea",
    displayName: "Gitea A",
    baseUrl: "https://gitea.example.com",
    apiBaseUrl: "https://gitea.example.com/api/v1",
    cloneBaseUrl: "https://gitea.example.com",
    authMode: "pat",
    credentialSource: "encrypted_d1",
    credentialRef: null,
    username: "agent-bot",
    enabled: true,
    isDefault: true,
    health: "healthy",
    capabilities: {
      listRepositories: true,
      listBranches: true,
      createPullRequest: true,
      draftPullRequest: false,
      userOAuth: false,
      webhooks: false,
      commitSigning: false,
      repositoryById: true,
    },
    version: "23.8.0",
    revision: 1,
    lastCheckedAt: 1,
    lastErrorCode: null,
    createdBy: "user-1",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function registry(rows: ScmConnectionRecord[]) {
  const connections = {
    get: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    getDefault: vi.fn(async () => rows.find((row) => row.isDefault && row.enabled) ?? null),
    list: vi.fn(async () => rows),
    create: vi.fn(),
  };
  const credentials = {
    get: vi.fn(async (id: string) => ({
      secret: `secret-for-${id}`,
      encryptionFormatVersion: 1,
      expiresAt: null,
    })),
  };
  return {
    value: new SourceControlConnectionRegistry({ TOKEN_ENCRYPTION_KEY: "unused" } as Env, {
      connections: connections as never,
      credentials: credentials as never,
    }),
    connections,
    credentials,
  };
}

describe("SourceControlConnectionRegistry", () => {
  beforeEach(() => {
    mocks.factory.mockReset().mockImplementation((config: unknown) => ({ config }));
  });

  it("resolves credentials and caches providers only for one connection revision", async () => {
    const row = record();
    const { value, credentials } = registry([row]);

    const first = await value.getConnection(row.id);
    const second = await value.getConnection(row.id);
    row.revision = 2;
    const third = await value.getConnection(row.id);

    expect(first.provider).toBe(second.provider);
    expect(third.provider).not.toBe(first.provider);
    expect(mocks.factory).toHaveBeenCalledTimes(2);
    expect(credentials.get).toHaveBeenCalledTimes(2);
    expect(mocks.factory).toHaveBeenLastCalledWith({
      provider: "gitea",
      gitea: expect.objectContaining({
        accessToken: "secret-for-scm_gitea_a",
        username: "agent-bot",
      }),
    });
  });

  it("isolates equal provider identities by connection id", async () => {
    const a = record();
    const b = record({
      id: "scm_gitea_b",
      displayName: "Gitea B",
      baseUrl: "https://forge.example.net/root",
      apiBaseUrl: "https://forge.example.net/root/api/v1",
      cloneBaseUrl: "https://forge.example.net/root",
      isDefault: false,
    });
    const { value } = registry([a, b]);

    const resolvedA = await value.getConnection(a.id);
    const resolvedB = await value.getConnection(b.id);

    expect(resolvedA.connection.id).not.toBe(resolvedB.connection.id);
    expect(resolvedA.provider).not.toBe(resolvedB.provider);
    expect(mocks.factory).toHaveBeenCalledTimes(2);
  });

  it("fails closed for a disabled connection", async () => {
    const disabled = record({ enabled: false, isDefault: false, health: "disabled" });
    const { value } = registry([disabled]);

    await expect(value.getConnection(disabled.id)).rejects.toBeInstanceOf(
      ScmConnectionDisabledError
    );
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it("does not guess a default when durable connections already exist", async () => {
    const nonDefault = record({ isDefault: false });
    const { value, connections } = registry([nonDefault]);

    await expect(value.getDefaultConnection()).rejects.toThrow(
      "No enabled default source-control connection"
    );
    expect(connections.create).not.toHaveBeenCalled();
  });
});
