import { describe, expect, it, vi } from "vitest";
import type { SessionLaunchSpecV1 } from "@open-inspect/shared/types/runtime-launch";
import { SessionLaunchSpecStore } from "./session-launch-specs";

function launchSpec(): SessionLaunchSpecV1 {
  const source = { scope: "session" as const, id: null };
  return {
    version: 1,
    resolverVersion: "1",
    capabilityCatalogVersion: "2026-08-21.1",
    resolvedAt: 123,
    draftDigest: "a".repeat(64),
    target: {
      kind: "repository",
      connectionId: "connection-1",
      provider: "gitea",
      environmentId: null,
      repositories: [
        {
          repositoryKey: "repository-1",
          connectionId: "connection-1",
          externalRepositoryId: "42",
          owner: "acme",
          name: "app",
          branch: "main",
          position: 0,
          webUrl: "https://gitea.example/acme/app",
          cloneUrl: "https://gitea.example/acme/app.git",
        },
      ],
    },
    runtime: {
      harness: { value: "codex", source, inherited: false },
      routeId: { value: "codex:openai:subscription", source, inherited: false },
      model: { value: "openai/gpt-5.6-luna", source, inherited: false },
      effort: { value: "high", source, inherited: false },
      nativeEffort: "high",
      settings: {
        approvalPolicy: { value: "never", source, inherited: true },
        sandboxMode: { value: "danger-full-access", source, inherited: true },
      },
    },
    skillsManifestId: "b".repeat(64),
    caller: { channel: "web", canonicalUserId: "user-1", integrationId: null },
  };
}

describe("SessionLaunchSpecStore", () => {
  it("binds indexed fields and the immutable JSON snapshot together", () => {
    const bind = vi.fn().mockReturnValue({});
    const prepare = vi.fn().mockReturnValue({ bind });
    const spec = launchSpec();
    new SessionLaunchSpecStore({ prepare } as never).bindCreate("session-1", spec);
    expect(bind).toHaveBeenCalledWith(
      "session-1",
      1,
      "1",
      "2026-08-21.1",
      "a".repeat(64),
      "codex",
      "codex:openai:subscription",
      "openai/gpt-5.6-luna",
      "high",
      JSON.stringify(spec),
      123
    );
  });

  it("validates a stored snapshot before returning it", async () => {
    const spec = launchSpec();
    const first = vi.fn().mockResolvedValue({ spec_json: JSON.stringify(spec) });
    const bind = vi.fn().mockReturnValue({ first });
    const prepare = vi.fn().mockReturnValue({ bind });
    await expect(
      new SessionLaunchSpecStore({ prepare } as never).get("session-1")
    ).resolves.toEqual(spec);
  });

  it("rejects corrupted or secret-shaped non-contract data", async () => {
    const first = vi.fn().mockResolvedValue({ spec_json: JSON.stringify({ token: "secret" }) });
    const bind = vi.fn().mockReturnValue({ first });
    const prepare = vi.fn().mockReturnValue({ bind });
    await expect(
      new SessionLaunchSpecStore({ prepare } as never).get("session-1")
    ).rejects.toThrow();
  });
});
