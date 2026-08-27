import { beforeEach, describe, expect, it, vi } from "vitest";
import { inferRepositoryBranch, listRepositoryCatalog } from "./targets";

const { mockSignedControlPlaneFetch } = vi.hoisted(() => ({
  mockSignedControlPlaneFetch: vi.fn(),
}));

vi.mock("./internal-auth", () => ({
  signedControlPlaneFetch: mockSignedControlPlaneFetch,
}));

const env = { CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "test-secret" };

function catalogResponse(input: {
  repos: Array<Record<string, unknown>>;
  connections: Array<Record<string, unknown>>;
  connectionErrors?: Array<Record<string, unknown>>;
}): Response {
  return Response.json({
    ...input,
    cached: false,
    cachedAt: "2026-08-25T00:00:00.000Z",
    connectionErrors: input.connectionErrors ?? [],
  });
}

function repository(input: {
  id: number;
  owner: string;
  name: string;
  connectionId: string;
  provider: "github" | "gitea";
  connectionLabel: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    owner: input.owner,
    name: input.name,
    fullName: `${input.owner}/${input.name}`,
    description: null,
    private: true,
    defaultBranch: "main",
    archived: false,
    repositoryKey: `repo-${input.id}`,
    connectionId: input.connectionId,
    provider: input.provider,
    webUrl: `https://example.test/${input.owner}/${input.name}`,
    cloneUrl: `https://example.test/${input.owner}/${input.name}.git`,
    connection: {
      id: input.connectionId,
      provider: input.provider,
      displayName: input.connectionLabel,
      baseUrl: "https://example.test",
    },
  };
}

const connections = [
  {
    id: "scm_github_default",
    provider: "github",
    displayName: "GitHub",
    baseUrl: "https://github.com",
  },
  {
    id: "scm_gitea_primary",
    provider: "gitea",
    displayName: "Gitea",
    baseUrl: "https://gitea.example.test",
  },
];

describe("listRepositoryCatalog", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns a partial catalog without a synchronous retry", async () => {
    mockSignedControlPlaneFetch.mockResolvedValueOnce(
      catalogResponse({
        repos: [
          repository({
            id: 1,
            owner: "octo",
            name: "site",
            connectionId: "scm_github_default",
            provider: "github",
            connectionLabel: "GitHub",
          }),
        ],
        connections,
        connectionErrors: [{ connectionId: "scm_gitea_primary", code: "SCM_CATALOG_UNAVAILABLE" }],
      })
    );

    const result = await listRepositoryCatalog(env, "trace-1");

    expect(mockSignedControlPlaneFetch).toHaveBeenCalledOnce();
    expect(result.targets.map((target) => target.fullName)).toEqual(["octo/site"]);
    expect(result.connections).toEqual([
      {
        id: "scm_gitea_primary",
        label: "Gitea",
        provider: "gitea",
        repositoryCount: 0,
        catalogStatus: "refreshing",
      },
      {
        id: "scm_github_default",
        label: "GitHub",
        provider: "github",
        repositoryCount: 1,
        catalogStatus: "available",
      },
    ]);
  });

  it("shows an enabled connection as refreshing instead of silently omitting it", async () => {
    mockSignedControlPlaneFetch.mockResolvedValueOnce(
      catalogResponse({
        repos: [],
        connections,
        connectionErrors: [{ connectionId: "scm_gitea_primary", code: "SCM_CATALOG_UNAVAILABLE" }],
      })
    );

    const result = await listRepositoryCatalog(env, "trace-2");

    expect(result.connections).toContainEqual({
      id: "scm_gitea_primary",
      label: "Gitea",
      provider: "gitea",
      repositoryCount: 0,
      catalogStatus: "refreshing",
    });
  });
});

describe("inferRepositoryBranch", () => {
  const target = {
    repositoryKey: "repo-1",
    fullName: "summersmile1984/background-agents",
    displayName: "background-agents",
    provider: "github",
    connectionId: "scm_github_default",
    connectionLabel: "GitHub",
    defaultBranch: "main",
  };

  it("accepts an explicit owner/repo@branch reference with slashes", () => {
    expect(
      inferRepositoryBranch(
        target,
        "summersmile1984/background-agents@codex/visual-e2e-fixture 生产视觉验证"
      )
    ).toBe("codex/visual-e2e-fixture");
  });

  it("does not infer a branch from an ordinary repository mention", () => {
    expect(inferRepositoryBranch(target, "检查 summersmile1984/background-agents")).toBeUndefined();
  });
});
