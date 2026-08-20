import { afterEach, describe, expect, it, vi } from "vitest";
import { GiteaSourceControlProvider } from "./gitea-provider";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    owner: { login: "acme" },
    name: "app",
    full_name: "acme/app",
    description: "App",
    private: true,
    default_branch: "main",
    archived: false,
    html_url: "https://gitea.example.com/root/acme/app",
    clone_url: "https://gitea.example.com/root/acme/app.git",
    ...overrides,
  };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    url: "https://gitea.example.com/root/api/v1/repos/acme/app/pulls/7",
    html_url: "https://gitea.example.com/root/acme/app/pulls/7",
    state: "open",
    merged: false,
    draft: false,
    head: { ref: "agent/change", sha: "abc123" },
    base: { ref: "main", sha: "base123", repo: { id: 42 } },
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:01:00Z",
    closed_at: null,
    merged_at: null,
    ...overrides,
  };
}

function provider(): GiteaSourceControlProvider {
  return new GiteaSourceControlProvider({
    baseUrl: "https://gitea.example.com/root/",
    accessToken: "pat-secret",
    username: "agent-bot",
    userAgent: "Open-Inspect Test",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GiteaSourceControlProvider", () => {
  it("probes the version and authenticated service user with PAT header", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ version: "23.8.0" }))
      .mockResolvedValueOnce(json({ id: 5, login: "agent-bot" }))
      .mockResolvedValueOnce(
        json({ ok: true, data: [repository()] }, { headers: { "x-total-count": "12" } })
      );
    vi.stubGlobal("fetch", fetch);

    await expect(provider().probe()).resolves.toEqual({
      version: "23.8.0",
      userId: "5",
      login: "agent-bot",
      visibleRepositoryCount: 12,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][0]).toBe("https://gitea.example.com/root/api/v1/version");
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("Authorization")).toBe(
      "token pat-secret"
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(new URL(String(fetch.mock.calls[2][0])).searchParams.get("limit")).toBe("1");
  });

  it("lists owned and contributed repositories through paginated search", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ id: 5, login: "agent-bot" }))
      .mockResolvedValueOnce(
        json(
          { ok: true, data: [repository()] },
          { headers: { Link: '<https://gitea.example/api/v1/repos/search?page=2>; rel="next"' } }
        )
      )
      .mockResolvedValueOnce(
        json({
          ok: true,
          data: [
            repository({
              id: 43,
              name: "tools",
              full_name: "acme/tools",
              html_url: "https://gitea.example.com/root/acme/tools",
              clone_url: "https://gitea.example.com/root/acme/tools.git",
            }),
            repository({ id: 44, name: "archived", archived: true }),
          ],
        })
      );
    vi.stubGlobal("fetch", fetch);

    await expect(provider().listRepositories()).resolves.toMatchObject([
      { id: 42, owner: "acme", name: "app", defaultBranch: "main" },
      { id: 43, owner: "acme", name: "tools", defaultBranch: "main" },
    ]);
    const pageOne = new URL(String(fetch.mock.calls[1][0]));
    expect(pageOne.pathname).toBe("/root/api/v1/repos/search");
    expect(pageOne.searchParams.get("uid")).toBe("5");
    expect(pageOne.searchParams.get("private")).toBe("true");
    expect(pageOne.searchParams.get("exclusive")).toBe("false");
    expect(pageOne.searchParams.get("page")).toBe("1");
    expect(new URL(String(fetch.mock.calls[2][0])).searchParams.get("page")).toBe("2");
  });

  it("encodes nested owners and branch slashes as one logical parameter", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(repository({ owner: { login: "group/subgroup" } })))
      .mockResolvedValueOnce(json({ name: "feature/x", commit: { id: "deadbeef" } }));
    vi.stubGlobal("fetch", fetch);
    const gitea = provider();

    await expect(
      gitea.checkRepositoryAccess({ owner: "group/subgroup", name: "app" })
    ).resolves.toMatchObject({ repoId: 42, repoOwner: "group/subgroup" });
    await expect(
      gitea.getBranchHead({ owner: "group/subgroup", name: "app", branch: "feature/x" })
    ).resolves.toBe("deadbeef");
    expect(fetch.mock.calls[0][0]).toBe(
      "https://gitea.example.com/root/api/v1/repos/group/subgroup/app"
    );
    expect(fetch.mock.calls[1][0]).toBe(
      "https://gitea.example.com/root/api/v1/repos/group/subgroup/app/branches/feature%2Fx"
    );
  });

  it("creates a pull request with OAuth Bearer auth and normalizes lifecycle facts", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(pullRequest(), { status: 201 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      provider().createPullRequest(
        { authType: "oauth", token: "user-oauth" },
        {
          repository: {
            owner: "acme",
            name: "app",
            fullName: "acme/app",
            defaultBranch: "main",
            isPrivate: true,
            providerRepoId: 42,
          },
          title: "Change",
          body: "Body",
          sourceBranch: "agent/change",
          targetBranch: "main",
        }
      )
    ).resolves.toMatchObject({
      id: 7,
      lifecycleState: "open",
      repositoryExternalId: "42",
      headSha: "abc123",
    });
    const init = fetch.mock.calls[0][1];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer user-oauth");
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Change",
      body: "Body",
      head: "agent/change",
      base: "main",
    });
  });

  it("repairs a renamed repository by stable id before retrying a PR read", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ message: "not found" }, { status: 404 }))
      .mockResolvedValueOnce(
        json(
          repository({
            owner: { login: "platform" },
            name: "renamed",
            full_name: "platform/renamed",
          })
        )
      )
      .mockResolvedValueOnce(json(pullRequest()));
    vi.stubGlobal("fetch", fetch);

    await expect(
      provider().getPullRequest({
        owner: "acme",
        name: "old",
        number: 7,
        repositoryExternalId: "42",
      })
    ).resolves.toMatchObject({ repoOwner: "platform", repoName: "renamed", number: 7 });
    expect(fetch.mock.calls[1][0]).toBe("https://gitea.example.com/root/api/v1/repositories/42");
    expect(fetch.mock.calls[2][0]).toBe(
      "https://gitea.example.com/root/api/v1/repos/platform/renamed/pulls/7"
    );
  });

  it("keeps the PAT server-side and fails closed on legacy sandbox auth paths", async () => {
    const gitea = provider();
    await expect(gitea.getUpstreamGitAuthorization("write")).resolves.toEqual({
      username: "agent-bot",
      password: "pat-secret",
    });
    await expect(gitea.generatePushAuth()).rejects.toThrow("server-side Git proxy");
    await expect(gitea.generateCredentialHelperAuth()).rejects.toThrow(
      "cannot be released through the sandbox credential helper"
    );
    expect(() =>
      gitea.buildGitPushSpec({
        owner: "acme",
        name: "app",
        sourceRef: "HEAD",
        targetBranch: "agent/change",
        auth: { authType: "pat", token: "must-not-be-used" },
      })
    ).toThrow("server-side Git proxy");
  });
});
