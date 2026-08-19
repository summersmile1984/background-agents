import { beforeEach, describe, expect, it, vi } from "vitest";

const identityState = vi.hoisted(() => ({
  user: null as null | { email: string | null; emailVerified: boolean },
  identities: [] as Array<{
    provider: string;
    providerLogin: string | null;
  }>,
}));

vi.mock("../db/user-store", () => ({
  UserStore: class {
    async getUserById() {
      return identityState.user;
    }
    async getIdentitiesForUser() {
      return identityState.identities;
    }
  },
}));

import { isDeploymentAdmin } from "./deployment-admin";

describe("isDeploymentAdmin", () => {
  beforeEach(() => {
    identityState.user = null;
    identityState.identities = [];
  });

  it("matches explicit canonical user, verified email, and GitHub identities", async () => {
    await expect(
      isDeploymentAdmin(
        {} as never,
        { DEPLOYMENT_ADMIN_IDENTITIES: "user:user-1" } as never,
        "user-1"
      )
    ).resolves.toBe(true);

    identityState.user = { email: "Admin@Example.com", emailVerified: true };
    await expect(
      isDeploymentAdmin(
        {} as never,
        { DEPLOYMENT_ADMIN_IDENTITIES: "email:admin@example.com" } as never,
        "user-2"
      )
    ).resolves.toBe(true);

    identityState.user = null;
    identityState.identities = [{ provider: "github", providerLogin: "OctoCat" }];
    await expect(
      isDeploymentAdmin(
        {} as never,
        { DEPLOYMENT_ADMIN_IDENTITIES: "github:octocat" } as never,
        "user-3"
      )
    ).resolves.toBe(true);
  });

  it("falls back only to exact admission allowlists", async () => {
    identityState.identities = [{ provider: "github", providerLogin: "octocat" }];
    await expect(
      isDeploymentAdmin({} as never, { ALLOWED_USERS: "octocat" } as never, "user-1")
    ).resolves.toBe(true);
    await expect(
      isDeploymentAdmin(
        {} as never,
        { ALLOWED_EMAIL_DOMAINS: "example.com", ALLOWED_GITHUB_ORGS: "acme" } as never,
        "user-1"
      )
    ).resolves.toBe(false);
  });

  it("does not trust an unverified email", async () => {
    identityState.user = { email: "admin@example.com", emailVerified: false };
    await expect(
      isDeploymentAdmin(
        {} as never,
        { DEPLOYMENT_ADMIN_IDENTITIES: "email:admin@example.com" } as never,
        "user-1"
      )
    ).resolves.toBe(false);
  });
});
