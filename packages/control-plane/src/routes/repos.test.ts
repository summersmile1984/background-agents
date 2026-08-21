import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { reposRoutes } from "./repos";
import type * as SharedRoutes from "./shared";
import type { RequestContext } from "./shared";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";

const {
  mockCacheDelete,
  mockCacheGet,
  mockCachePut,
  mockGetBatch,
  mockGetBatchByRepositoryIds,
  mockListRepositories,
  mockConnectionList,
  mockLogger,
  mockUpsert,
  mockUpsertRepository,
} = vi.hoisted(() => ({
  mockCacheDelete: vi.fn(),
  mockCacheGet: vi.fn(),
  mockCachePut: vi.fn(),
  mockGetBatch: vi.fn(),
  mockGetBatchByRepositoryIds: vi.fn(),
  mockListRepositories: vi.fn(),
  mockConnectionList: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mockUpsert: vi.fn(),
  mockUpsertRepository: vi.fn(),
}));

vi.mock("../db/scm-connections", () => ({
  ScmConnectionStore: class {
    async list() {
      return mockConnectionList();
    }
  },
  ScmConnectionCredentialStore: class {},
}));

vi.mock("../db/scm-repositories", () => ({
  ScmRepositoryStore: class {
    upsertResolved(...args: unknown[]) {
      return mockUpsertRepository(...args);
    }
  },
}));

vi.mock("../source-control/connection-registry", () => ({
  SourceControlConnectionRegistry: class {
    async getConnection(connectionId: string) {
      return { provider: { listRepositories: () => mockListRepositories(connectionId) } };
    }
  },
}));

vi.mock("../db/repo-metadata", () => ({
  RepoMetadataStore: vi.fn().mockImplementation(function () {
    return {
      upsert: mockUpsert,
      getBatch: mockGetBatch,
      getBatchByRepositoryIds: mockGetBatchByRepositoryIds,
    };
  }),
}));

vi.mock("@open-inspect/shared/cache-store", () => ({
  createKvCacheStore: vi.fn(() => ({
    delete: mockCacheDelete,
    get: mockCacheGet,
    put: mockCachePut,
  })),
}));

vi.mock("../logger", () => ({
  createLogger: vi.fn(() => mockLogger),
}));

function createContext(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
    principal: { kind: "user", userId: "user-1" },
    db: {} as SqlDatabase,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

vi.mock("./shared", async () => {
  const actual = await vi.importActual<typeof SharedRoutes>("./shared");
  return {
    ...actual,
    createRouteSourceControlProvider: vi.fn(() => ({
      listRepositories: mockListRepositories,
    })),
  };
});

function getListHandler() {
  const route = reposRoutes.find(
    (candidate) => candidate.method === "GET" && candidate.pattern.test("/repos")
  );
  if (!route) throw new Error("No repository list route found");
  const match = "/repos".match(route.pattern);
  if (!match) throw new Error("List route did not match /repos");
  return { handler: route.handler, match };
}

function getUpdateHandler(path: string) {
  const route = reposRoutes.find((candidate) => candidate.method === "PUT");
  if (!route) throw new Error("No repository metadata update route found");
  const match = path.match(route.pattern);
  if (!match) throw new Error(`Update route did not match ${path}`);
  return { handler: route.handler, match };
}

describe("repository list route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionList.mockReturnValue([
      {
        id: "scm_github_default",
        provider: "github",
        displayName: "GitHub",
        baseUrl: "https://github.com",
        cloneBaseUrl: "https://github.com",
        revision: 1,
        isDefault: true,
        enabled: true,
      },
    ]);
    mockCacheGet.mockResolvedValue(null);
    mockCachePut.mockResolvedValue(undefined);
    mockGetBatch.mockResolvedValue(new Map());
    mockGetBatchByRepositoryIds.mockResolvedValue(new Map());
    mockListRepositories.mockResolvedValue([
      {
        id: 1,
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets",
        description: null,
        private: true,
        archived: false,
        defaultBranch: "main",
      },
    ]);
    mockUpsertRepository.mockResolvedValue({ id: "repo-1" });
  });

  it("keeps the cold-cache refresh alive when the client disconnects", async () => {
    // A cold cache is populated synchronously. The web proxy aborts at
    // CONTROL_PLANE_FETCH_TIMEOUT_MS, which cancels the worker — so unless the
    // refresh is registered with waitUntil, the KV write never lands and every
    // later request repeats the same slow path against an empty cache.
    const waitUntil = vi.fn();
    const { handler, match } = getListHandler();
    const ctx = createContext();

    const response = await handler(
      new Request("https://test.local/repos"),
      { REPOS_CACHE: {} as KVNamespace, TOKEN_ENCRYPTION_KEY: "unused" } as Env,
      match,
      {
        ...ctx,
        executionCtx: { submit: waitUntil },
      }
    );

    expect(response.status).toBe(200);
    expect(mockCachePut).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0][0]).resolves.not.toThrow();
  });

  it("shares a connection catalog cache between user and service principals", async () => {
    mockCacheGet.mockResolvedValue({
      repos: [
        {
          id: 1,
          owner: "acme",
          name: "widgets",
          fullName: "acme/widgets",
          description: null,
          private: true,
          archived: false,
          defaultBranch: "main",
          repositoryKey: "repo-1",
          connectionId: "scm_github_default",
          provider: "github",
          webUrl: "https://github.com/acme/widgets",
          cloneUrl: "https://github.com/acme/widgets.git",
        },
      ],
      cachedAt: "2026-08-21T00:00:00.000Z",
      freshUntil: Date.now() + 60_000,
    });
    const { handler, match } = getListHandler();
    const userContext = createContext();
    const serviceContext: RequestContext = {
      ...createContext(),
      principal: { kind: "service", service: "slack-bot", actor: null },
    };

    await handler(
      new Request("https://test.local/repos"),
      { REPOS_CACHE: {} as KVNamespace, TOKEN_ENCRYPTION_KEY: "unused" } as Env,
      match,
      userContext
    );
    await handler(
      new Request("https://test.local/repos"),
      { REPOS_CACHE: {} as KVNamespace, TOKEN_ENCRYPTION_KEY: "unused" } as Env,
      match,
      serviceContext
    );

    expect(mockCacheGet.mock.calls.map(([key]) => key)).toEqual([
      "repos:list:v4:scm_github_default:1",
      "repos:list:v4:scm_github_default:1",
    ]);
    expect(mockListRepositories).not.toHaveBeenCalled();
  });

  it("loads enabled SCM connections concurrently", async () => {
    mockConnectionList.mockReturnValue([
      {
        id: "scm_github_default",
        provider: "github",
        displayName: "GitHub",
        baseUrl: "https://github.com",
        cloneBaseUrl: "https://github.com",
        revision: 1,
        isDefault: true,
        enabled: true,
      },
      {
        id: "scm_gitea_primary",
        provider: "gitea",
        displayName: "Gitea",
        baseUrl: "https://gitea.example.com",
        cloneBaseUrl: "https://gitea.example.com",
        revision: 1,
        isDefault: false,
        enabled: true,
      },
    ]);
    let resolveGitHub!: (repositories: unknown[]) => void;
    const githubRepositories = new Promise<unknown[]>((resolve) => {
      resolveGitHub = resolve;
    });
    mockListRepositories.mockImplementation((connectionId: string) => {
      if (connectionId === "scm_github_default") return githubRepositories;
      return Promise.resolve([
        {
          id: 2,
          owner: "huangdong",
          name: "n9n",
          fullName: "huangdong/n9n",
          description: null,
          private: true,
          archived: false,
          defaultBranch: "main",
          webUrl: "https://gitea.example.com/huangdong/n9n",
          cloneUrl: "https://gitea.example.com/huangdong/n9n.git",
        },
      ]);
    });
    mockUpsertRepository
      .mockResolvedValueOnce({ id: "repo-gitea" })
      .mockResolvedValueOnce({ id: "repo-github" });
    const { handler, match } = getListHandler();
    const responsePromise = handler(
      new Request("https://test.local/repos"),
      { REPOS_CACHE: {} as KVNamespace, TOKEN_ENCRYPTION_KEY: "unused" } as Env,
      match,
      createContext()
    );

    await vi.waitFor(() => expect(mockListRepositories).toHaveBeenCalledTimes(2));
    resolveGitHub([
      {
        id: 1,
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets",
        description: null,
        private: true,
        archived: false,
        defaultBranch: "main",
      },
    ]);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    const body = (await response.json()) as { repos: Array<{ owner: string }> };
    expect(body.repos.map((repository) => repository.owner).sort()).toEqual(["acme", "huangdong"]);
  });
});

describe("repository metadata routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue(undefined);
    mockCacheDelete.mockResolvedValue(undefined);
  });

  it("returns success when cache invalidation fails after the metadata update commits", async () => {
    let resolveUpsert!: () => void;
    mockUpsert.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveUpsert = resolve;
        })
    );
    const cacheError = new Error("KV unavailable");
    mockCacheDelete.mockRejectedValue(cacheError);
    const path = "/repos/Acme/Widget/metadata";
    const { handler, match } = getUpdateHandler(path);

    const responsePromise = handler(
      new Request(`https://test.local${path}`, {
        method: "PUT",
        body: JSON.stringify({ description: "Updated description" }),
      }),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      createContext()
    );

    await vi.waitFor(() => expect(mockUpsert).toHaveBeenCalledOnce());
    expect(mockCacheDelete).not.toHaveBeenCalled();
    resolveUpsert();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "updated",
      repo: "acme/widget",
      metadata: { description: "Updated description" },
    });
    expect(mockUpsert).toHaveBeenCalledWith("Acme", "Widget", {
      description: "Updated description",
    });
    expect(mockCacheDelete).toHaveBeenCalledOnce();
    expect(mockLogger.warn).toHaveBeenCalledWith("Failed to invalidate repos cache", {
      trace_id: "trace-1",
      error: cacheError,
      repo_owner: "Acme",
      repo_name: "Widget",
    });
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("returns an error and skips cache invalidation when the metadata update fails", async () => {
    const updateError = new Error("D1 unavailable");
    mockUpsert.mockRejectedValue(updateError);
    const path = "/repos/acme/widget/metadata";
    const { handler, match } = getUpdateHandler(path);

    const response = await handler(
      new Request(`https://test.local${path}`, {
        method: "PUT",
        body: JSON.stringify({ description: "Updated description" }),
      }),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      createContext()
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to update metadata" });
    expect(mockCacheDelete).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith("Failed to update repo metadata", {
      error: updateError,
    });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("rejects malformed metadata before persistence", async () => {
    const path = "/repos/acme/widget/metadata";
    const { handler, match } = getUpdateHandler(path);

    const response = await handler(
      new Request(`https://test.local${path}`, {
        method: "PUT",
        body: JSON.stringify({ aliases: ["api", 42] }),
      }),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      createContext()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid repository metadata" });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with the same 400 as an invalid object", async () => {
    const path = "/repos/acme/widget/metadata";
    const { handler, match } = getUpdateHandler(path);

    const response = await handler(
      new Request(`https://test.local${path}`, { method: "PUT", body: "{" }),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      createContext()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid repository metadata" });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  it("persists only schema fields and drops unknown keys", async () => {
    const path = "/repos/acme/widget/metadata";
    const { handler, match } = getUpdateHandler(path);

    const response = await handler(
      new Request(`https://test.local${path}`, {
        method: "PUT",
        body: JSON.stringify({
          description: "Updated description",
          keywords: ["billing"],
          notAField: "dropped",
        }),
      }),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      createContext()
    );

    expect(response.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith("acme", "widget", {
      description: "Updated description",
      keywords: ["billing"],
    });
  });
});
