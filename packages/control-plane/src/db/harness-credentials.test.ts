import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSecrets = vi.hoisted(() => ({
  values: new Map<string, string>(),
  updatedAt: new Map<string, number>(),
  clock: 0,
}));

vi.mock("./global-secrets", () => ({
  GlobalSecretsStore: class {
    async listSecretKeys() {
      return Array.from(mockSecrets.values.keys()).map((key) => ({
        key,
        createdAt: 1,
        updatedAt: mockSecrets.updatedAt.get(key) ?? 1,
      }));
    }

    async getDecryptedSecrets() {
      return Object.fromEntries(mockSecrets.values);
    }

    async setSecrets(values: Record<string, string>) {
      for (const [key, value] of Object.entries(values)) {
        mockSecrets.values.set(key, value);
        mockSecrets.updatedAt.set(key, ++mockSecrets.clock);
      }
      return { created: 0, updated: 0, keys: Object.keys(values) };
    }

    async deleteSecret(key: string) {
      mockSecrets.updatedAt.delete(key);
      return mockSecrets.values.delete(key);
    }
  },
}));

import { HarnessCredentialStore, HarnessCredentialValidationError } from "./harness-credentials";

describe("HarnessCredentialStore", () => {
  beforeEach(() => {
    mockSecrets.values.clear();
    mockSecrets.updatedAt.clear();
    mockSecrets.clock = 0;
  });

  it("stores only metadata-facing fingerprints and removes a conflicting Codex mode", async () => {
    const store = new HarnessCredentialStore({} as never, "encryption-key");
    await store.set("codex-access-token", "enterprise-token");
    const auth = await store.set(
      "codex-auth-json",
      JSON.stringify({ tokens: { access: "secret" } })
    );

    expect(auth).toMatchObject({
      kind: "codex-auth-json",
      configured: true,
      fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{12}$/),
    });
    expect(JSON.stringify(auth)).not.toContain("secret");
    expect(mockSecrets.values.has("CODEX_ACCESS_TOKEN")).toBe(false);
  });

  it("normalizes expiry metadata and deletes it with the last active mode", async () => {
    const store = new HarnessCredentialStore({} as never, "encryption-key");
    const metadata = await store.set("claude-setup-token", "claude-token", "2030-01-02T03:04:05Z");
    expect(metadata.expiresAt).toBe("2030-01-02T03:04:05.000Z");
    await expect(store.delete("claude-setup-token")).resolves.toBe(true);
    expect(mockSecrets.values.has("CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT")).toBe(false);
  });

  it("rejects malformed Codex auth before writing it", async () => {
    const store = new HarnessCredentialStore({} as never, "encryption-key");
    await expect(store.set("codex-auth-json", "not-json")).rejects.toBeInstanceOf(
      HarnessCredentialValidationError
    );
    expect(mockSecrets.values.size).toBe(0);
  });
});
