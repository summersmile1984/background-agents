import { describe, expect, it } from "vitest";
import { controlPlaneReposResponseSchema, repoConfigSchema } from "./repository-catalog";

describe("controlPlaneReposResponseSchema", () => {
  it("parses a valid control-plane repos response with nullable fields", () => {
    const result = controlPlaneReposResponseSchema.safeParse({
      repos: [
        {
          id: 123,
          owner: "Open-Inspect",
          name: "Background-Agents",
          fullName: "Open-Inspect/Background-Agents",
          description: null,
          private: true,
          defaultBranch: "main",
          archived: false,
          language: null,
          metadata: {
            description: "Slack-facing description",
            aliases: ["agents"],
            channelAssociations: ["C123"],
            keywords: ["classifier"],
            defaultEnvironmentId: "env_123",
          },
        },
      ],
      connections: [
        {
          id: "scm_gitea_primary",
          provider: "gitea",
          displayName: "Gitea",
          baseUrl: "https://gitea.example.com",
        },
      ],
      cached: false,
      cachedAt: "2026-07-27T00:00:00.000Z",
      connectionErrors: [{ connectionId: "scm_gitea_primary", code: "SCM_CATALOG_UNAVAILABLE" }],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.connectionErrors).toHaveLength(1);
    expect(result.data.connections[0]?.provider).toBe("gitea");
  });

  it("accepts older responses that do not include connection catalog state", () => {
    const result = controlPlaneReposResponseSchema.safeParse({
      repos: [],
      cached: true,
      cachedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.connections).toEqual([]);
    expect(result.data.connectionErrors).toEqual([]);
  });

  it("rejects malformed repo entries", () => {
    const result = controlPlaneReposResponseSchema.safeParse({
      repos: [{ owner: "Open-Inspect", name: "Background-Agents" }],
      cached: false,
      cachedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects repo entries missing canonical repository fields", () => {
    const result = controlPlaneReposResponseSchema.safeParse({
      repos: [
        {
          owner: "Open-Inspect",
          name: "Background-Agents",
          description: null,
          private: true,
          defaultBranch: "main",
        },
      ],
      cached: false,
      cachedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects responses missing cache metadata", () => {
    const result = controlPlaneReposResponseSchema.safeParse({
      repos: [
        {
          id: 123,
          owner: "Open-Inspect",
          name: "Background-Agents",
          fullName: "Open-Inspect/Background-Agents",
          description: null,
          private: true,
          defaultBranch: "main",
          archived: false,
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe("repoConfigSchema", () => {
  it("parses cached repo config values with nullable optional fields", () => {
    const result = repoConfigSchema.safeParse({
      id: "open-inspect/background-agents",
      owner: "open-inspect",
      name: "background-agents",
      fullName: "open-inspect/background-agents",
      displayName: "Background-Agents",
      description: "Cached repo",
      defaultBranch: "main",
      private: false,
      language: null,
    });

    expect(result.success).toBe(true);
  });

  it("rejects malformed cached repo config values", () => {
    const result = repoConfigSchema.safeParse({
      id: "open-inspect/background-agents",
      owner: "open-inspect",
      private: false,
    });

    expect(result.success).toBe(false);
  });
});
