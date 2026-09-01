import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import {
  deriveVncPassword,
  E2B_CREATE_TIME_ENV_CHUNK_PREFIX,
  E2B_CREATE_TIME_ENV_MAX_VALUE_BYTES,
} from "../sandbox-env";
import { E2BSandboxProvider, type E2BProviderConfig } from "./e2b-provider";
import { SandboxProviderError } from "../provider";
import {
  E2BNotFoundError,
  E2BConflictError,
  E2BApiError,
  type E2BRestClient,
  type E2BSandboxDetail,
} from "../e2b-rest-client";

const providerConfig: E2BProviderConfig = {
  scmProvider: "github",
  sandboxAccessPasswordSecret: "secret",
  sandboxTimeoutSeconds: 1800,
  autoPause: true,
};

function mockClient(overrides: Partial<E2BRestClient> = {}): E2BRestClient {
  return {
    config: { apiUrl: "https://api.e2b.app", apiKey: "secret", templateId: "tmpl" },
    createSandbox: vi.fn(async () => ({
      sandboxID: "e2b-id",
      templateID: "tmpl",
      envdAccessToken: "envd-token",
    })),
    writeSessionEnv: vi.fn(async () => {}),
    getSandbox: vi.fn(
      async (): Promise<E2BSandboxDetail> => ({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        state: "paused",
      })
    ),
    pauseSandbox: vi.fn(async () => {}),
    connectSandbox: vi.fn(async (): Promise<void> => {}),
    killSandbox: vi.fn(async () => {}),
    setSandboxTimeout: vi.fn(async () => {}),
    getSandboxLogs: vi.fn(async () =>
      JSON.stringify({ logEntries: [{ message: "start container finish" }] })
    ),
    getHostnameForPort: vi.fn((id: string, port: number) => `https://${port}-${id}.e2b.app`),
    ...overrides,
  } as unknown as E2BRestClient;
}

const baseCreateConfig = {
  sessionId: "sess-1",
  sandboxId: "sandbox-logical",
  repoOwner: "o",
  repoName: "r",
  controlPlaneUrl: "https://cp.test",
  sandboxAuthToken: "tok",
  provider: "anthropic",
  model: "claude",
  codeServerEnabled: true,
};

describe("E2BSandboxProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("createSandbox returns running status and tunnel urls", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    const result = await provider.createSandbox(baseCreateConfig);
    expect(result.status).toBe("running");
    expect(result.providerObjectId).toBe("e2b-id");
    expect(result.codeServerUrl).toBe("https://8080-e2b-id.e2b.app");
    const expected = (await computeHmacHex("code-server:sandbox-logical", "secret")).slice(0, 32);
    expect(result.codeServerPassword).toBe(expected);
  });

  it("injects and returns VNC access without including its port in generic tunnels", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    const result = await provider.createSandbox({
      ...baseCreateConfig,
      vncEnabled: true,
      sandboxSettings: { vncPort: 6099, tunnelPorts: [6099, 3000] },
    });
    const [, env] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    const expected = await deriveVncPassword("sandbox-logical", "secret");

    expect(env).toMatchObject({ VNC_PASSWORD: expected, NOVNC_PORT: "6099" });
    expect(result).toMatchObject({
      vncAccess: { url: "https://6099-e2b-id.e2b.app", password: expected },
      tunnelUrls: { "3000": "https://3000-e2b-id.e2b.app" },
    });
  });

  it("uses a trusted preview gateway for generic tunnels only", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, {
      ...providerConfig,
      previewBaseUrl: "https://preview.example.test/prefix",
    });

    const result = await provider.createSandbox({
      ...baseCreateConfig,
      sandboxSettings: { tunnelPorts: [3000] },
    });

    expect(result.codeServerUrl).toBe("https://8080-e2b-id.e2b.app");
    expect(result.tunnelUrls).toEqual({
      "3000": "https://preview.example.test/prefix/sandbox/e2b-id/3000/",
    });
  });

  it("system vars override user vars (delivered via writeSessionEnv)", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    await provider.createSandbox({ ...baseCreateConfig, userEnvVars: { SANDBOX_ID: "evil" } });
    // Per-session env is delivered as a file, not via POST /sandboxes envVars.
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.not.objectContaining({ envVars: expect.anything() })
    );
    const [sbxId, env] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    expect(sbxId).toBe("e2b-id");
    expect(env.SANDBOX_ID).toBe("sandbox-logical");
    // Token-free: git auth is brokered per-request via the credential helper,
    // never embedded in sandbox env (would expire on long-running/resumed sessions).
    expect(env).not.toHaveProperty("VCS_CLONE_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_APP_TOKEN");
  });

  it("maps bitbucket to the Bitbucket clone identity", async () => {
    // E2B historically collapsed bitbucket to the GitHub identity (a
    // pre-Bitbucket-support drift that made bitbucket clones impossible);
    // it now resolves the real Bitbucket identity like every provider.
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, {
      ...providerConfig,
      scmProvider: "bitbucket",
    });

    await provider.createSandbox(baseCreateConfig);

    const [, env] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    expect(env.VCS_HOST).toBe("bitbucket.org");
    expect(env.VCS_CLONE_USERNAME).toBe("x-token-auth");
  });

  it("supports a Gitea session through the proxy with a Gitea deployment default", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, {
      ...providerConfig,
      scmProvider: "gitea",
    });

    await provider.createSandbox({
      ...baseCreateConfig,
      scmGitProxyBaseUrl: "https://control-plane.example/git/session/sess-1",
      scmGitCapability: "oig-capability",
    });

    const [, env] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    expect(env).toMatchObject({
      VCS_HOST: "control-plane.example",
      VCS_CLONE_USERNAME: "open-inspect-capability",
      VCS_CLONE_BASE_URL: "https://control-plane.example/git/session/sess-1",
      SCM_GIT_CAPABILITY: "oig-capability",
      OI_SCM_PROXY_MODE: "1",
    });
  });

  it("resumeSandbox paused uses connectSandbox", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    const result = await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
    });
    expect(result.success).toBe(true);
    expect(client.connectSandbox).toHaveBeenCalledWith("e2b-id", 1800);
  });

  it("returns VNC access after resume", async () => {
    const result = await new E2BSandboxProvider(mockClient(), providerConfig).resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
      vncEnabled: true,
    });

    expect(result.vncAccess?.url).toBe("https://6080-e2b-id.e2b.app");
    expect(result.vncAccess?.password).toMatch(/^[A-Za-z0-9]{8}$/);
  });

  it("resumeSandbox running uses setSandboxTimeout only", async () => {
    const client = mockClient({
      getSandbox: vi.fn(async () => ({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        state: "running",
      })),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
    });
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("e2b-id", 1800);
    expect(client.connectSandbox).not.toHaveBeenCalled();
  });

  it("resumeSandbox 404 returns shouldSpawnFresh", async () => {
    const client = mockClient({
      getSandbox: vi.fn(async () => {
        throw new E2BNotFoundError("gone");
      }),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    const result = await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
    });
    expect(result.shouldSpawnFresh).toBe(true);
  });

  it("stopSandbox pauses (resumable), not kills, and treats 404/409 as success", async () => {
    const client = mockClient();
    const res = await new E2BSandboxProvider(client, providerConfig).stopSandbox({
      providerObjectId: "x",
      sessionId: "s",
      reason: "idle",
    });
    expect(res.success).toBe(true);
    expect(client.pauseSandbox).toHaveBeenCalledWith("x");
    expect(client.killSandbox).not.toHaveBeenCalled();

    for (const err of [new E2BNotFoundError("gone"), new E2BConflictError("already paused")]) {
      const c = mockClient({
        pauseSandbox: vi.fn(async () => {
          throw err;
        }),
      });
      expect(
        (
          await new E2BSandboxProvider(c, providerConfig).stopSandbox({
            providerObjectId: "x",
            sessionId: "s",
            reason: "idle",
          })
        ).success
      ).toBe(true);
    }
  });

  it.each([
    "connecting_timeout",
    "pending_dispatch_timeout",
    "prompt_dispatch_send_failed",
    "runtime_failure",
    "stop_confirmation_timeout",
    "stop_send_failed",
    "respawn",
  ])("stopSandbox KILLS on terminal reason %s", async (reason) => {
    const client = mockClient();
    const res = await new E2BSandboxProvider(client, providerConfig).stopSandbox({
      providerObjectId: "x",
      sessionId: "s",
      reason,
    });
    expect(res.success).toBe(true);
    expect(client.killSandbox).toHaveBeenCalledWith("x");
    expect(client.pauseSandbox).not.toHaveBeenCalled();
  });

  it("forwards the caller signal when killing a replaced sandbox", async () => {
    const client = mockClient();
    const signal = AbortSignal.timeout(1_000);

    await new E2BSandboxProvider(client, providerConfig).stopSandbox({
      providerObjectId: "x",
      sessionId: "s",
      reason: "respawn",
      signal,
    });

    expect(client.killSandbox).toHaveBeenCalledWith("x", signal);
  });

  it("resumeSandbox: 404 during connect (post-GET race) returns shouldSpawnFresh", async () => {
    const client = mockClient({
      getSandbox: vi.fn(async () => ({ sandboxID: "e2b-id", templateID: "tmpl", state: "paused" })),
      connectSandbox: vi.fn(async () => {
        throw new E2BNotFoundError("vanished mid-resume");
      }),
    });
    const result = await new E2BSandboxProvider(client, providerConfig).resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
    });
    expect(result.success).toBe(false);
    expect(result.shouldSpawnFresh).toBe(true);
  });

  it("replaces a Cube sandbox whose shim exited after a nominal resume", async () => {
    const client = mockClient({
      getSandbox: vi
        .fn()
        .mockResolvedValueOnce({ sandboxID: "e2b-id", templateID: "tmpl", state: "paused" })
        .mockResolvedValueOnce({ sandboxID: "e2b-id", templateID: "tmpl", state: "running" }),
      getSandboxLogs: vi.fn(async () => '{"message":"wait container finish, exit code:1"}'),
    });
    const provider = new E2BSandboxProvider(client, {
      ...providerConfig,
      useCreateTimeEnv: true,
      createTimeEnvVerifyDelayMs: 0,
    });

    const result = await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
    });

    expect(client.connectSandbox).toHaveBeenCalledWith("e2b-id", 1800);
    expect(client.getSandboxLogs).toHaveBeenCalledWith("e2b-id");
    expect(result).toMatchObject({
      success: false,
      shouldSpawnFresh: true,
      error: expect.stringContaining("runtime exited"),
    });
  });

  it("accepts a Cube resume only after the shim remains healthy", async () => {
    const client = mockClient({
      getSandbox: vi
        .fn()
        .mockResolvedValueOnce({ sandboxID: "e2b-id", templateID: "tmpl", state: "paused" })
        .mockResolvedValueOnce({ sandboxID: "e2b-id", templateID: "tmpl", state: "running" }),
    });
    const provider = new E2BSandboxProvider(client, {
      ...providerConfig,
      useCreateTimeEnv: true,
      createTimeEnvVerifyDelayMs: 0,
    });

    const result = await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
    });

    expect(result.success).toBe(true);
    expect(client.getSandbox).toHaveBeenCalledTimes(2);
    expect(client.getSandboxLogs).toHaveBeenCalledWith("e2b-id");
  });

  it("preserves a resumed Cube workspace when only the lifecycle log probe is unavailable", async () => {
    const client = mockClient({
      getSandbox: vi
        .fn()
        .mockResolvedValueOnce({ sandboxID: "e2b-id", templateID: "tmpl", state: "paused" })
        .mockResolvedValueOnce({ sandboxID: "e2b-id", templateID: "tmpl", state: "running" }),
      getSandboxLogs: vi.fn(async () => {
        throw new E2BApiError("logs unavailable", 503);
      }),
    });
    const provider = new E2BSandboxProvider(client, {
      ...providerConfig,
      useCreateTimeEnv: true,
      createTimeEnvVerifyDelayMs: 0,
    });

    const result = await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
    });

    expect(result.success).toBe(true);
    expect(result.shouldSpawnFresh).toBeUndefined();
  });

  it("honors config.timeoutSeconds on create and resume (child sandboxes)", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);

    await provider.createSandbox({ ...baseCreateConfig, timeoutSeconds: 3600 });
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 3600 })
    );

    await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
      timeoutSeconds: 3600,
    });
    expect(client.connectSandbox).toHaveBeenCalledWith("e2b-id", 3600);
  });

  it("falls back to the provider default timeout when config has none", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    await provider.createSandbox(baseCreateConfig);
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 1800 })
    );
    expect(client.writeSessionEnv).toHaveBeenCalledWith(
      "e2b-id",
      expect.objectContaining({ SANDBOX_TIMEOUT_SECONDS: "1800" }),
      expect.any(Object)
    );
  });

  it("kills the created sandbox when writeSessionEnv fails (no leak)", async () => {
    const client = mockClient({
      writeSessionEnv: vi.fn(async () => {
        throw new E2BApiError("envd unreachable", 502);
      }),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toBeInstanceOf(
      SandboxProviderError
    );
    expect(client.killSandbox).toHaveBeenCalledWith("e2b-id");
  });

  it("still surfaces the original error when the cleanup kill also fails", async () => {
    const client = mockClient({
      writeSessionEnv: vi.fn(async () => {
        throw new E2BApiError("envd unreachable", 502);
      }),
      killSandbox: vi.fn(async () => {
        throw new E2BApiError("kill failed too", 500);
      }),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      message: expect.stringContaining("envd unreachable"),
    });
  });

  it("threads the sandbox domain into code-server and tunnel URLs", async () => {
    const client = mockClient({
      createSandbox: vi.fn(async () => ({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        domain: "dedicated.example",
        envdAccessToken: "envd-token",
      })),
      getHostnameForPort: vi.fn(
        (id: string, port: number, domain?: string | null) =>
          `https://${port}-${id}.${domain || "e2b.app"}`
      ),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    const result = await provider.createSandbox(baseCreateConfig);
    expect(result.codeServerUrl).toBe("https://8080-e2b-id.dedicated.example");
  });

  it("creates with secure envd + autoPause, but NOT provider auto-resume", async () => {
    const client = mockClient();
    await new E2BSandboxProvider(client, providerConfig).createSandbox(baseCreateConfig);
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true, autoPause: true, autoResume: false })
    );
    // secure create returns the token; it must be threaded to the env upload
    const [, , opts] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    expect(opts).toMatchObject({ envdAccessToken: "envd-token" });
  });

  it("fails closed (kills the sandbox, no env write) when create returns no envd token", async () => {
    const client = mockClient({
      createSandbox: vi.fn(async () => ({ sandboxID: "e2b-id", templateID: "tmpl" })),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "permanent",
      message: expect.stringMatching(/envd access token/),
    });
    expect(client.writeSessionEnv).not.toHaveBeenCalled();
    expect(client.killSandbox).toHaveBeenCalledWith("e2b-id");
  });

  it("uses create-time env without an envd token for an explicitly compatible backend", async () => {
    const client = mockClient({
      createSandbox: vi.fn(async () => ({ sandboxID: "e2b-id", templateID: "tmpl" })),
      getSandbox: vi.fn(async () => ({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        state: "running",
      })),
    });
    const provider = new E2BSandboxProvider(client, {
      ...providerConfig,
      useCreateTimeEnv: true,
      createTimeEnvVerifyDelayMs: 0,
    });

    await expect(provider.createSandbox(baseCreateConfig)).resolves.toMatchObject({
      status: "running",
      providerObjectId: "e2b-id",
    });
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: expect.objectContaining({
          SANDBOX_ID: "sandbox-logical",
          OI_USE_CREATE_TIME_ENV: "1",
          VCS_CLONE_BASE_URL: "https://cp.test/git/sess-1",
        }),
        envVarsField: "envs",
        secure: true,
      })
    );
    expect(client.writeSessionEnv).not.toHaveBeenCalled();
    expect(client.killSandbox).not.toHaveBeenCalled();
    expect(client.getSandbox).toHaveBeenCalledWith("e2b-id");
    expect(client.getSandboxLogs).toHaveBeenCalledWith("e2b-id");
  });

  it("kills and transparently replaces a Cube sandbox whose runtime exits after create", async () => {
    const client = mockClient({
      createSandbox: vi
        .fn()
        .mockResolvedValueOnce({ sandboxID: "dead-id", templateID: "tmpl" })
        .mockResolvedValueOnce({ sandboxID: "healthy-id", templateID: "tmpl" }),
      getSandbox: vi
        .fn()
        .mockResolvedValueOnce({ sandboxID: "dead-id", templateID: "tmpl", state: "running" })
        .mockResolvedValueOnce({ sandboxID: "healthy-id", templateID: "tmpl", state: "running" }),
      getSandboxLogs: vi
        .fn()
        .mockResolvedValueOnce('{"message":"wait container finish, exit code:0"}')
        .mockResolvedValueOnce('{"message":"start container finish"}'),
    });
    const provider = new E2BSandboxProvider(client, {
      ...providerConfig,
      useCreateTimeEnv: true,
      createTimeEnvVerifyDelayMs: 0,
    });

    await expect(provider.createSandbox(baseCreateConfig)).resolves.toMatchObject({
      status: "running",
      providerObjectId: "healthy-id",
    });
    expect(client.createSandbox).toHaveBeenCalledTimes(2);
    expect(client.killSandbox).toHaveBeenCalledWith("dead-id");
  });

  it("fails quickly as transient after bounded Cube runtime replacement attempts", async () => {
    const client = mockClient({
      createSandbox: vi
        .fn()
        .mockResolvedValueOnce({ sandboxID: "dead-1", templateID: "tmpl" })
        .mockResolvedValueOnce({ sandboxID: "dead-2", templateID: "tmpl" }),
      getSandbox: vi.fn(async () => ({
        sandboxID: "dead",
        templateID: "tmpl",
        state: "running",
      })),
      getSandboxLogs: vi.fn(async () => '{"message":"TaskExit event"}'),
    });
    const provider = new E2BSandboxProvider(client, {
      ...providerConfig,
      useCreateTimeEnv: true,
      createTimeEnvVerifyDelayMs: 0,
    });

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "transient",
      message: expect.stringContaining("Cube runtime exited during startup"),
    });
    expect(client.createSandbox).toHaveBeenCalledTimes(2);
    expect(client.killSandbox).toHaveBeenNthCalledWith(1, "dead-1");
    expect(client.killSandbox).toHaveBeenNthCalledWith(2, "dead-2");
  });

  it("chunks oversized create-time secrets so CubeSandbox accepts Codex auth", async () => {
    const client = mockClient({
      createSandbox: vi.fn(async () => ({ sandboxID: "e2b-id", templateID: "tmpl" })),
      getSandbox: vi.fn(async () => ({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        state: "running",
      })),
    });
    const provider = new E2BSandboxProvider(client, {
      ...providerConfig,
      useCreateTimeEnv: true,
      createTimeEnvVerifyDelayMs: 0,
    });
    const authJson = `${"a".repeat(5000)}🙂`;

    await provider.createSandbox({
      ...baseCreateConfig,
      userEnvVars: { CODEX_AUTH_JSON: authJson },
    });

    const request = vi.mocked(client.createSandbox).mock.calls[0][0];
    const env = request.envVars!;
    const chunks = Object.entries(env)
      .filter(([key]) => key.startsWith(E2B_CREATE_TIME_ENV_CHUNK_PREFIX))
      .sort(([left], [right]) => left.localeCompare(right));

    expect(env).not.toHaveProperty("CODEX_AUTH_JSON");
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        ([, value]) =>
          new TextEncoder().encode(value).byteLength <= E2B_CREATE_TIME_ENV_MAX_VALUE_BYTES
      )
    ).toBe(true);
    expect(chunks.map(([, value]) => value).join("")).toBe(authJson);
    expect(client.writeSessionEnv).not.toHaveBeenCalled();
  });

  it("429 maps to a TRANSIENT SandboxProviderError (not counted toward the circuit breaker)", async () => {
    const client = mockClient({
      createSandbox: vi.fn(async () => {
        throw new E2BApiError("rate limited", 429);
      }),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "transient",
      message: expect.stringContaining("rate-limited"),
    } satisfies Partial<SandboxProviderError>);
  });

  it("SESSION_CONFIG carries mcp_servers and the multi-repo repositories list", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    await provider.createSandbox({
      ...baseCreateConfig,
      mcpServers: [{ id: "m1", name: "linear", type: "remote", url: "https://mcp", enabled: true }],
      repositories: [
        { repoOwner: "o", repoName: "r", baseBranch: "main" },
        { repoOwner: "o2", repoName: "r2", baseBranch: "dev" },
      ],
    });
    const [, env] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    const sessionConfig = JSON.parse(env.SESSION_CONFIG);
    expect(sessionConfig.mcp_servers).toHaveLength(1);
    expect(sessionConfig.repositories).toEqual([
      { repo_owner: "o", repo_name: "r", branch: "main" },
      { repo_owner: "o2", repo_name: "r2", branch: "dev" },
    ]);
  });

  it("emits CODE_SERVER_PORT (default, and a custom configured port)", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);

    await provider.createSandbox(baseCreateConfig);
    expect(vi.mocked(client.writeSessionEnv).mock.calls[0][1].CODE_SERVER_PORT).toBe("8080");

    vi.clearAllMocks();
    const result = await provider.createSandbox({
      ...baseCreateConfig,
      sandboxSettings: { codeServerPort: 9999 } as never,
    });
    expect(vi.mocked(client.writeSessionEnv).mock.calls[0][1].CODE_SERVER_PORT).toBe("9999");
    // The configured port must drive the code-server URL too, not a hardcoded 8080.
    expect(result.codeServerUrl).toBe("https://9999-e2b-id.e2b.app");
  });

  it("resumeSandbox running extends the TTL via setSandboxTimeout", async () => {
    const client = mockClient({
      getSandbox: vi.fn(async () => ({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        state: "running",
      })),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
      timeoutSeconds: 7200,
    });
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("e2b-id", 7200);
  });
});
