import { afterEach, describe, expect, it, vi } from "vitest";
import { handleGitHubGitProxy } from "./github-git-proxy";
import type { Env } from "./types";

function makeEnv(verifyStatus = 204): { env: Env; verifyFetch: ReturnType<typeof vi.fn> } {
  const verifyFetch = vi.fn(async () => new Response(null, { status: verifyStatus }));
  const env = {
    SESSION: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch: verifyFetch })),
    },
  } as unknown as Env;
  return { env, verifyFetch };
}

function proxyRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://cp.example.com${path}`, init);
}

describe("GitHub smart-HTTP proxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ignores non-proxy paths", async () => {
    const { env } = makeEnv();
    const request = proxyRequest("/health");
    await expect(handleGitHubGitProxy(request, new URL(request.url), env)).resolves.toBeNull();
  });

  it("challenges unauthenticated Git clients without calling GitHub", async () => {
    const upstreamFetch = vi.fn();
    vi.stubGlobal("fetch", upstreamFetch);
    const { env, verifyFetch } = makeEnv();
    const request = proxyRequest("/git/sess-1/acme/app.git/info/refs?service=git-upload-pack");

    const response = await handleGitHubGitProxy(request, new URL(request.url), env);

    expect(response?.status).toBe(401);
    expect(response?.headers.get("WWW-Authenticate")).toContain("Basic");
    expect(verifyFetch).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects an invalid sandbox capability before calling GitHub", async () => {
    const upstreamFetch = vi.fn();
    vi.stubGlobal("fetch", upstreamFetch);
    const { env, verifyFetch } = makeEnv(401);
    const authorization = `Basic ${btoa("bad-sandbox-token:ghs_secret")}`;
    const request = proxyRequest("/git/sess-1/acme/app.git/info/refs", {
      headers: { Authorization: authorization },
    });

    const response = await handleGitHubGitProxy(request, new URL(request.url), env);

    expect(response?.status).toBe(401);
    expect(verifyFetch).toHaveBeenCalledOnce();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("verifies the sandbox and streams an authenticated GitHub request", async () => {
    const upstreamFetch = vi.fn(
      async () =>
        new Response("pack", {
          status: 200,
          headers: { "Content-Type": "application/x-git-upload-pack-result" },
        })
    );
    vi.stubGlobal("fetch", upstreamFetch);
    const { env, verifyFetch } = makeEnv();
    const authorization = `Basic ${btoa("sandbox-token:ghs_secret")}`;
    const request = proxyRequest("/git/sess-1/acme/app.git/git-upload-pack", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "CF-Connecting-IP": "203.0.113.10",
        "Content-Type": "application/x-git-upload-pack-request",
      },
      body: "want refs",
    });

    const response = await handleGitHubGitProxy(request, new URL(request.url), env);

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("pack");
    expect(verifyFetch).toHaveBeenCalledOnce();
    const verifyRequest = verifyFetch.mock.calls[0][0] as Request;
    expect(await verifyRequest.json()).toEqual({ token: "sandbox-token" });
    expect(upstreamFetch).toHaveBeenCalledOnce();
    const [upstreamUrl, upstreamInit] = upstreamFetch.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(upstreamUrl.toString()).toBe("https://github.com/acme/app.git/git-upload-pack");
    expect(new Headers(upstreamInit.headers).get("Authorization")).toBe(
      `Basic ${btoa("x-access-token:ghs_secret")}`
    );
    expect(new Headers(upstreamInit.headers).has("CF-Connecting-IP")).toBe(false);
  });
});
