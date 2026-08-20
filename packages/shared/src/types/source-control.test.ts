import { describe, expect, it } from "vitest";
import {
  EMPTY_SOURCE_CONTROL_CAPABILITIES,
  sourceControlConnectionSummarySchema,
  sourceControlRepositoryCatalogItemSchema,
  sourceControlRepositoryIdentitySchema,
} from "./source-control";

describe("source-control contracts", () => {
  it("accepts a safe Gitea connection summary without credential fields", () => {
    const parsed = sourceControlConnectionSummarySchema.parse({
      id: "scm_gitea_aotsea",
      provider: "gitea",
      displayName: "Aotsea Gitea",
      baseUrl: "https://gitea.example.com/gitea",
      authMode: "pat",
      enabled: true,
      isDefault: false,
      health: "healthy",
      version: "23.8.0",
      lastCheckedAt: 1_700_000_000_000,
      lastErrorCode: null,
      capabilities: EMPTY_SOURCE_CONTROL_CAPABILITIES,
    });

    expect(parsed.provider).toBe("gitea");
    expect(parsed).not.toHaveProperty("credential");
  });

  it("represents an unresolved historical repository without inventing provider identity", () => {
    expect(
      sourceControlRepositoryIdentitySchema.parse({
        repositoryKey: "repo_legacy",
        connectionId: "scm_github_default",
        externalId: null,
        owner: "acme",
        name: "removed",
        resolutionStatus: "unresolved",
      })
    ).toEqual({
      repositoryKey: "repo_legacy",
      connectionId: "scm_github_default",
      externalId: null,
      owner: "acme",
      name: "removed",
      resolutionStatus: "unresolved",
    });
  });

  it("requires resolved catalog entries to have stable provider identity and safe URLs", () => {
    expect(() =>
      sourceControlRepositoryCatalogItemSchema.parse({
        repositoryKey: "repo_1",
        connectionId: "scm_1",
        externalId: null,
        owner: "acme",
        name: "app",
        resolutionStatus: "resolved",
      })
    ).toThrow();
  });
});
