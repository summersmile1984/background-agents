import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRepositoryCatalog } from "./targets";

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

  it("retries only a temporarily omitted connection and merges its cached catalog", async () => {
    mockSignedControlPlaneFetch
      .mockResolvedValueOnce(
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
          connectionErrors: [
            { connectionId: "scm_gitea_primary", code: "SCM_CATALOG_UNAVAILABLE" },
          ],
        })
      )
      .mockResolvedValueOnce(
        catalogResponse({
          repos: [
            repository({
              id: 2,
              owner: "huangdong",
              name: "n9n",
              connectionId: "scm_gitea_primary",
              provider: "gitea",
              connectionLabel: "Gitea",
            }),
          ],
          connections: [connections[1]!],
        })
      );
    vi.useFakeTimers();

    const resultPromise = listRepositoryCatalog(env, "trace-1");
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await resultPromise;

    expect(mockSignedControlPlaneFetch).toHaveBeenCalledTimes(2);
    expect(mockSignedControlPlaneFetch.mock.calls[1]?.[1]).toMatchObject({
      url: "https://internal/repos?connectionId=scm_gitea_primary",
    });
    expect(result.targets.map((target) => target.fullName)).toEqual(["octo/site", "huangdong/n9n"]);
    expect(result.connections).toEqual([
      {
        id: "scm_gitea_primary",
        label: "Gitea",
        provider: "gitea",
        repositoryCount: 1,
        catalogStatus: "available",
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
    mockSignedControlPlaneFetch
      .mockResolvedValueOnce(
        catalogResponse({
          repos: [],
          connections,
          connectionErrors: [
            { connectionId: "scm_gitea_primary", code: "SCM_CATALOG_UNAVAILABLE" },
          ],
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.useFakeTimers();

    const resultPromise = listRepositoryCatalog(env, "trace-2");
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await resultPromise;

    expect(result.connections).toContainEqual({
      id: "scm_gitea_primary",
      label: "Gitea",
      provider: "gitea",
      repositoryCount: 0,
      catalogStatus: "refreshing",
    });
  });
});
