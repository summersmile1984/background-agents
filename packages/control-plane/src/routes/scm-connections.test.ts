import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScmConnectionRecord } from "../db/scm-connections";
import type { Env } from "../types";
import type { Route, UserRouteContext } from "./shared";

const mocks = vi.hoisted(() => ({
  admin: true,
  records: new Map<string, ScmConnectionRecord>(),
  secrets: new Map<string, string>(),
  probe: vi.fn(),
  preflightReady: true,
}));

vi.mock("../db/scm-backfill", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    ScmRepositoryBackfillStore: class {
      async preflight() {
        return {
          legacyRepositoryLocations: mocks.preflightReady ? 0 : 3,
          unresolvedActiveRepositories: 0,
          mixedSessionAggregates: 0,
          mixedEnvironmentAggregates: 0,
          mixedAutomationAggregates: 0,
          orphanRepositoryReferences: 0,
          readyForSecondConnection: mocks.preflightReady,
          job: null,
        };
      }
    },
  };
});

vi.mock("../auth/deployment-admin", () => ({
  isDeploymentAdmin: vi.fn(async () => mocks.admin),
}));

vi.mock("../auth/crypto", () => ({
  generateId: () => "generated",
}));

vi.mock("../source-control/providers/gitea-provider", () => ({
  GiteaSourceControlProvider: class {
    constructor(readonly config: unknown) {}
    probe() {
      return mocks.probe(this.config);
    }
  },
}));

vi.mock("../source-control/connection-registry", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    SourceControlConnectionRegistry: class {
      async getDefaultConnection() {
        return {
          connection: { id: "scm_github_default" },
          provider: {},
        };
      }
    },
  };
});

vi.mock("../db/scm-connections", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    ScmConnectionStore: class {
      async list() {
        return [...mocks.records.values()];
      }
      async get(id: string) {
        return mocks.records.get(id) ?? null;
      }
      async createWithEncryptedServiceCredential(
        input: Omit<
          ScmConnectionRecord,
          | "health"
          | "version"
          | "revision"
          | "lastCheckedAt"
          | "lastErrorCode"
          | "createdAt"
          | "updatedAt"
        >,
        secret: string
      ) {
        const now = Date.now();
        const record = {
          ...input,
          credentialRef: null,
          health: "unknown",
          version: null,
          revision: 1,
          lastCheckedAt: null,
          lastErrorCode: null,
          createdAt: now,
          updatedAt: now,
        } as ScmConnectionRecord;
        mocks.records.set(record.id, record);
        mocks.secrets.set(record.id, secret);
        return record;
      }
      async recordHealth(
        id: string,
        result: { version?: string; checkedAt?: number; errorCode?: string | null }
      ) {
        const record = mocks.records.get(id);
        if (record) {
          mocks.records.set(id, {
            ...record,
            version: result.version ?? null,
            lastCheckedAt: result.checkedAt ?? Date.now(),
            lastErrorCode: result.errorCode ?? null,
            health: result.errorCode ? "degraded" : "healthy",
          });
        }
      }
      async disable(id: string) {
        const record = mocks.records.get(id);
        if (!record) return false;
        mocks.records.set(id, { ...record, enabled: false, isDefault: false, health: "disabled" });
        return true;
      }
      async setDefault() {}
    },
    ScmConnectionCredentialStore: class {
      async has(id: string) {
        return mocks.secrets.has(id);
      }
      async get(id: string) {
        const secret = mocks.secrets.get(id);
        return secret ? { secret, encryptionFormatVersion: 1, expiresAt: null } : null;
      }
    },
  };
});

import { scmConnectionRoutes } from "./scm-connections";

function context(): UserRouteContext {
  return {
    db: {},
    principal: { kind: "user", userId: "user-1" },
    request_id: "request-1",
    trace_id: "trace-1",
    executionCtx: { submit() {} },
  } as unknown as UserRouteContext;
}

const env = {
  TOKEN_ENCRYPTION_KEY: "unused-by-mock",
  SCM_ALLOWED_HOSTS: "gitea.example.com",
} as Env;

function routeFor(method: string, path: string): { route: Route; match: RegExpMatchArray } {
  const route = scmConnectionRoutes.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path)
  );
  if (!route) throw new Error(`Missing route ${method} ${path}`);
  return { route, match: path.match(route.pattern)! };
}

async function dispatch(method: string, path: string, body?: unknown): Promise<Response> {
  const { route, match } = routeFor(method, path);
  return route.handler(
    new Request(`https://control.example.com${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    match,
    context()
  );
}

describe("SCM connection routes", () => {
  beforeEach(() => {
    mocks.admin = true;
    mocks.records.clear();
    mocks.secrets.clear();
    mocks.probe.mockReset().mockResolvedValue({
      version: "23.8.0",
      userId: "7",
      login: "agent-bot",
      visibleRepositoryCount: 3,
    });
    mocks.preflightReady = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preflights an allowlisted Gitea host before receiving a credential", async () => {
    const fetchMock = vi.fn(async () => Response.json({ version: "23.8.0" }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await dispatch("POST", "/scm/connections/preflight", {
      provider: "gitea",
      baseUrl: "https://gitea.example.com/root/",
    });
    const body = (await response.json()) as {
      preflight: { baseUrl: string; apiBaseUrl: string; host: string; version: string };
    };

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitea.example.com/root/api/v1/version",
      expect.objectContaining({ method: "GET", redirect: "manual" })
    );
    expect(body.preflight).toMatchObject({
      baseUrl: "https://gitea.example.com/root",
      apiBaseUrl: "https://gitea.example.com/root/api/v1",
      host: "gitea.example.com",
      version: "23.8.0",
    });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.secrets.size).toBe(0);
  });

  it("discovers the service username from the PAT owner", async () => {
    const response = await dispatch("POST", "/scm/connections", {
      provider: "gitea",
      displayName: "Team Gitea",
      baseUrl: "https://gitea.example.com",
      accessToken: "top-secret-pat",
    });

    expect(response.status).toBe(201);
    expect(mocks.records.get("scm_generated")?.username).toBe("agent-bot");
  });

  it("creates a probed Gitea connection without returning its PAT", async () => {
    const response = await dispatch("POST", "/scm/connections", {
      provider: "gitea",
      displayName: "Team Gitea",
      baseUrl: "https://gitea.example.com/root/",
      username: "agent-bot",
      accessToken: "top-secret-pat",
    });
    const text = await response.text();

    expect(response.status).toBe(201);
    expect(text).not.toContain("top-secret-pat");
    expect(text).toContain('"credentialConfigured":true');
    expect(text).toContain('"visibleRepositoryCount":3');
    expect(mocks.secrets.get("scm_generated")).toBe("top-secret-pat");
    expect(mocks.probe).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://gitea.example.com/root",
        apiBaseUrl: "https://gitea.example.com/root/api/v1",
      })
    );
  });

  it("requires deployment-admin authority for secret writes", async () => {
    mocks.admin = false;
    const response = await dispatch("POST", "/scm/connections", {
      provider: "gitea",
      displayName: "Team Gitea",
      baseUrl: "https://gitea.example.com",
      username: "agent-bot",
      accessToken: "top-secret-pat",
    });

    expect(response.status).toBe(403);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.secrets.size).toBe(0);
  });

  it("blocks a second connection until the legacy repository preflight passes", async () => {
    const now = Date.now();
    mocks.records.set("scm_github_default", {
      id: "scm_github_default",
      provider: "github",
      displayName: "GitHub",
      baseUrl: "https://github.com",
      apiBaseUrl: "https://api.github.com",
      cloneBaseUrl: "https://github.com",
      authMode: "github_app",
      credentialSource: "worker_binding",
      credentialRef: "github_app",
      username: "x-access-token",
      enabled: true,
      isDefault: true,
      health: "healthy",
      capabilities: {
        listRepositories: true,
        listBranches: true,
        createPullRequest: true,
        draftPullRequest: true,
        userOAuth: true,
        webhooks: true,
        commitSigning: true,
        repositoryById: true,
      },
      version: null,
      revision: 1,
      lastCheckedAt: now,
      lastErrorCode: null,
      createdBy: "system",
      createdAt: now,
      updatedAt: now,
    });
    mocks.preflightReady = false;

    const response = await dispatch("POST", "/scm/connections", {
      provider: "gitea",
      displayName: "Team Gitea",
      baseUrl: "https://gitea.example.com",
      username: "agent-bot",
      accessToken: "top-secret-pat",
    });
    const text = await response.text();

    expect(response.status).toBe(409);
    expect(text).toContain("SCM_MIGRATION_REQUIRED");
    expect(text).not.toContain("top-secret-pat");
    expect(mocks.records.size).toBe(1);
    expect(mocks.secrets.size).toBe(0);
  });

  it("rejects passwords and endpoints outside the deployment allowlist", async () => {
    const passwordResponse = await dispatch("POST", "/scm/connections", {
      provider: "gitea",
      displayName: "Team Gitea",
      baseUrl: "https://gitea.example.com",
      username: "agent-bot",
      password: "account-password",
      accessToken: "token",
    });
    const hostResponse = await dispatch("POST", "/scm/connections", {
      provider: "gitea",
      displayName: "Other Gitea",
      baseUrl: "https://untrusted.example.net",
      username: "agent-bot",
      accessToken: "token",
    });

    expect(passwordResponse.status).toBe(400);
    expect(hostResponse.status).toBe(400);
    expect(mocks.probe).not.toHaveBeenCalled();
  });
});
