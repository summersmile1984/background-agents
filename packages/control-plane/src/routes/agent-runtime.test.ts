import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type { Route, UserRouteContext } from "./shared";

const mocks = vi.hoisted(() => ({
  admin: true,
  setCredential: vi.fn(),
  replaceDeepSeekKey: vi.fn(),
}));

vi.mock("../auth/deployment-admin", () => ({
  isDeploymentAdmin: vi.fn(async () => mocks.admin),
}));

vi.mock("../db/agent-runtime-preferences", () => ({
  AgentRuntimePreferencesValidationError: class extends Error {},
  AgentRuntimePreferencesStore: class {
    async getEffective() {
      return {
        defaultAgentHarness: "opencode",
        enabledHarnesses: ["opencode", "codex", "claude", "deepseek"],
      };
    }
    async set(value: unknown) {
      return value;
    }
  },
}));

vi.mock("../db/harness-credentials", () => ({
  HarnessCredentialValidationError: class extends Error {},
  HarnessCredentialStore: class {
    async listMetadata() {
      return [
        {
          kind: "codex-access-token",
          configured: true,
          updatedAt: 1,
          expiresAt: null,
          fingerprint: "sha256:abcdef123456",
        },
      ];
    }
    set(...args: unknown[]) {
      return mocks.setCredential(...args);
    }
    async delete() {
      return true;
    }
  },
}));

vi.mock("../db/global-secrets", () => ({
  GlobalSecretsStore: class {
    async getDecryptedSecrets() {
      return {};
    }
  },
}));

vi.mock("../agent-runtime/model-relay-admin-client", () => ({
  ModelRelayAdminError: class extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  },
  unavailableHostRelayStatus: () => ({
    connected: false,
    checkedAt: 1,
    relay: "not-configured",
    deepseek: { configured: false, fingerprint: null },
    errorCode: "NOT_CONFIGURED",
  }),
  ModelRelayAdminClient: class {
    async status() {
      return {
        connected: true,
        checkedAt: 1,
        relay: "online",
        deepseek: { configured: true, fingerprint: "sha256:relay123456" },
      };
    }
    replaceDeepSeekKey(...args: unknown[]) {
      return mocks.replaceDeepSeekKey(...args);
    }
  },
}));

import { agentRuntimeRoutes } from "./agent-runtime";

function routeFor(method: string, path: string): { route: Route; match: RegExpMatchArray } {
  const route = agentRuntimeRoutes.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path)
  );
  if (!route) throw new Error(`Missing route ${method} ${path}`);
  return { route, match: path.match(route.pattern)! };
}

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
  REPO_SECRETS_ENCRYPTION_KEY: "encryption-key",
  MODEL_RELAY_ADMIN_URL: "https://relay-admin.example.com",
  MODEL_RELAY_ADMIN_AUTH_SECRET: "management-secret",
} as Env;

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

describe("agent runtime routes", () => {
  beforeEach(() => {
    mocks.admin = true;
    mocks.setCredential.mockReset();
    mocks.replaceDeepSeekKey.mockReset();
  });

  it("returns credential metadata without secret values", async () => {
    const response = await dispatch("GET", "/agent-runtime/credentials");
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("sha256:abcdef123456");
    expect(text).not.toContain("access-token-value");
  });

  it("rejects shared credential writes from non-admin users", async () => {
    mocks.admin = false;

    const response = await dispatch("PUT", "/agent-runtime/credentials/codex-access-token", {
      value: "access-token-value",
    });

    expect(response.status).toBe(403);
    expect(mocks.setCredential).not.toHaveBeenCalled();
  });

  it("forwards a DeepSeek key to Host management without returning it", async () => {
    mocks.replaceDeepSeekKey.mockResolvedValue({
      connected: true,
      checkedAt: 1,
      relay: "online",
      deepseek: { configured: true, fingerprint: "sha256:relay123456" },
    });

    const response = await dispatch("PUT", "/agent-runtime/host-relay/deepseek-key", {
      apiKey: "provider-secret",
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(mocks.replaceDeepSeekKey).toHaveBeenCalledWith("provider-secret");
    expect(text).not.toContain("provider-secret");
    expect(text).toContain("sha256:relay123456");
  });
});
