import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./types";

const mocks = vi.hoisted(() => ({
  memberConnectionId: "scm_gitea_1" as string | null,
  repository: {
    id: "repo_1",
    connectionId: "scm_gitea_1",
    resolutionStatus: "resolved",
    removedAt: null,
    cloneUrl: "https://gitea.example.com/root/acme/app.git",
  } as Record<string, unknown> | null,
  connectionEnabled: true,
  upstreamAuth: vi.fn(),
}));

vi.mock("./db/scm-repositories", () => ({
  ScmRepositoryStore: class {
    async get() {
      return mocks.repository;
    }
  },
}));

vi.mock("./db/scm-connections", () => ({
  ScmConnectionStore: class {},
  ScmConnectionCredentialStore: class {},
}));

vi.mock("./source-control/connection-registry", async (importOriginal) => {
  const original = await importOriginal<{
    ScmConnectionDisabledError: new (connectionId: string) => Error;
    [key: string]: unknown;
  }>();
  return {
    ...original,
    SourceControlConnectionRegistry: class {
      async getConnection() {
        if (!mocks.connectionEnabled) {
          throw new original.ScmConnectionDisabledError("scm_gitea_1");
        }
        return {
          connection: {
            id: "scm_gitea_1",
            cloneBaseUrl: "https://gitea.example.com/root",
          },
          provider: {
            name: "gitea",
            getUpstreamGitAuthorization: mocks.upstreamAuth,
          },
        };
      }
    },
  };
});

import { handleScmGitProxy } from "./scm-git-proxy";

function basic(token: string): string {
  return `Basic ${btoa(`${token}:${token}`)}`;
}

function env(verified = true): Env {
  return {
    TOKEN_ENCRYPTION_KEY: "unused",
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () =>
            mocks.memberConnectionId ? { scm_connection_id: mocks.memberConnectionId } : null,
        }),
      }),
    },
    SESSION: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        fetch: async () => new Response(null, { status: verified ? 204 : 401 }),
      }),
    },
  } as unknown as Env;
}

function proxy(request: Request, url: URL, environment: Env = env()) {
  return handleScmGitProxy(request, url, environment, environment.DB);
}

const path = "/git/session/session_1/repo_1.git/info/refs?service=git-upload-pack";

describe("session-authorized SCM Git proxy", () => {
  beforeEach(() => {
    mocks.memberConnectionId = "scm_gitea_1";
    mocks.repository = {
      id: "repo_1",
      connectionId: "scm_gitea_1",
      resolutionStatus: "resolved",
      removedAt: null,
      cloneUrl: "https://gitea.example.com/root/acme/app.git",
    };
    mocks.connectionEnabled = true;
    mocks.upstreamAuth.mockReset().mockResolvedValue({
      username: "agent-bot",
      password: "server-only-pat",
    });
    vi.unstubAllGlobals();
  });

  it("rejects absent and invalid sandbox capabilities before database/provider access", async () => {
    const url = new URL(`https://control.example.com${path}`);
    const absent = await proxy(new Request(url), url);
    const invalid = await proxy(
      new Request(url, { headers: { Authorization: basic("wrong") } }),
      url,
      env(false)
    );

    expect(absent?.status).toBe(401);
    expect(invalid?.status).toBe(401);
    expect(mocks.upstreamAuth).not.toHaveBeenCalled();
  });

  it("rejects a repository outside the session membership", async () => {
    mocks.memberConnectionId = null;
    const url = new URL(`https://control.example.com${path}`);
    const response = await proxy(
      new Request(url, { headers: { Authorization: basic("sandbox-capability") } }),
      url,
      env()
    );

    expect(response?.status).toBe(403);
    expect(mocks.upstreamAuth).not.toHaveBeenCalled();
  });

  it("streams to the pinned upstream and keeps its PAT server-side", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("pack", {
        status: 200,
        headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
      })
    );
    vi.stubGlobal("fetch", fetch);
    const url = new URL(`https://control.example.com${path}`);
    const response = await proxy(
      new Request(url, { headers: { Authorization: basic("sandbox-capability") } }),
      url,
      env()
    );

    expect(response?.status).toBe(200);
    const responseBody = await response?.text();
    expect(responseBody).toBe("pack");
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://gitea.example.com/root/acme/app.git/info/refs?service=git-upload-pack"),
      expect.objectContaining({ redirect: "manual" })
    );
    const upstreamHeaders = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(atob(upstreamHeaders.get("Authorization")!.slice(6))).toBe("agent-bot:server-only-pat");
    expect(responseBody).not.toContain("server-only-pat");
  });

  it("refuses redirects and disabled connections", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } })
      );
    vi.stubGlobal("fetch", fetch);
    const url = new URL(`https://control.example.com${path}`);
    const redirected = await proxy(
      new Request(url, { headers: { Authorization: basic("sandbox-capability") } }),
      url,
      env()
    );
    mocks.connectionEnabled = false;
    const disabled = await proxy(
      new Request(url, { headers: { Authorization: basic("sandbox-capability") } }),
      url,
      env()
    );

    expect(redirected?.status).toBe(502);
    expect(redirected?.headers.get("Location")).toBeNull();
    expect(disabled?.status).toBe(409);
  });
});
