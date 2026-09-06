import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSignedControlPlaneFetch } = vi.hoisted(() => ({
  mockSignedControlPlaneFetch: vi.fn(),
}));

vi.mock("../internal-auth", () => ({
  signedControlPlaneFetch: mockSignedControlPlaneFetch,
}));

import { resolveFeishuRuntimeDraft } from "./runtime-draft";

const validDraft = {
  resolverVersion: "1",
  capabilityCatalogVersion: "catalog-1",
  checkedAt: 1,
  draftDigest: "a".repeat(64),
  launchable: false,
  effective: {
    target: {
      kind: "none",
      connectionId: null,
      provider: null,
      environmentId: null,
      repositories: [],
    },
    harness: null,
    routeId: null,
    model: null,
    effort: null,
    nativeEffort: null,
    settings: {},
  },
  options: { harnesses: [], models: [], efforts: [], commands: [] },
  issues: [],
};

describe("Feishu runtime draft client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the actor-aware service route and validates the resolver response", async () => {
    mockSignedControlPlaneFetch.mockResolvedValue(Response.json(validDraft));

    await expect(
      resolveFeishuRuntimeDraft({
        env: { CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "test-secret" },
        actorId: "feishu:tenant:user",
        target: { kind: "repository", repositoryKey: "repo-1" },
        runtime: { harness: "codex" },
        traceId: "trace-1",
      })
    ).resolves.toEqual({ ok: true, data: validDraft });

    expect(mockSignedControlPlaneFetch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        method: "POST",
        url: "https://internal/agent-runtime/resolve-draft",
        actor: "feishu:tenant:user",
        traceId: "trace-1",
        body: JSON.stringify({
          target: { kind: "repository", repositoryKey: "repo-1" },
          runtime: { harness: "codex" },
        }),
      }),
      expect.any(Object)
    );
  });

  it("rejects malformed success payloads and distinguishes invalid selections", async () => {
    mockSignedControlPlaneFetch.mockResolvedValueOnce(Response.json({ launchable: true }));
    await expect(
      resolveFeishuRuntimeDraft({
        env: { CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "test-secret" },
        actorId: "feishu:tenant:user",
        target: { kind: "none" },
      })
    ).resolves.toMatchObject({ ok: false, reason: "unavailable" });

    mockSignedControlPlaneFetch.mockResolvedValueOnce(
      Response.json({ code: "MODEL_DISABLED", error: "model disabled" }, { status: 400 })
    );
    await expect(
      resolveFeishuRuntimeDraft({
        env: { CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "test-secret" },
        actorId: "feishu:tenant:user",
        target: { kind: "none" },
      })
    ).resolves.toEqual({
      ok: false,
      reason: "invalid",
      status: 400,
      code: "MODEL_DISABLED",
      error: "model disabled",
    });
  });
});
