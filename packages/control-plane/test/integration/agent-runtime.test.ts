import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

describe("Agent runtime API", () => {
  beforeEach(cleanD1Tables);

  it("persists deployment Harness preferences in migrated D1 storage", async () => {
    const defaults = await serviceFetch("https://test.local/agent-runtime/preferences");
    expect(defaults.status).toBe(200);
    await expect(defaults.json()).resolves.toMatchObject({
      defaultAgentHarness: "opencode",
      enabledHarnesses: ["opencode", "codex", "claude", "deepseek"],
      canManage: true,
    });

    const updated = await serviceFetch("https://test.local/agent-runtime/preferences", {
      method: "PUT",
      body: JSON.stringify({
        defaultAgentHarness: "codex",
        enabledHarnesses: ["codex", "deepseek"],
      }),
    });
    expect(updated.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT default_agent_harness, enabled_harnesses FROM agent_runtime_preferences WHERE id = 'global'"
    ).first<{ default_agent_harness: string; enabled_harnesses: string }>();
    expect(row).toEqual({
      default_agent_harness: "codex",
      enabled_harnesses: '["codex","deepseek"]',
    });
  });

  it("stores native credentials encrypted and returns metadata only", async () => {
    const authJson = JSON.stringify({ tokens: { access_token: "subscription-secret" } });
    const saved = await serviceFetch(
      "https://test.local/agent-runtime/credentials/codex-auth-json",
      {
        method: "PUT",
        body: JSON.stringify({ value: authJson, expiresAt: "2099-01-01T00:00:00.000Z" }),
      }
    );
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain("subscription-secret");

    const stored = await env.DB.prepare(
      "SELECT encrypted_value FROM global_secrets WHERE key = 'CODEX_AUTH_JSON'"
    ).first<{ encrypted_value: string }>();
    expect(stored?.encrypted_value).toBeTruthy();
    expect(stored?.encrypted_value).not.toContain("subscription-secret");

    const listed = await serviceFetch("https://test.local/agent-runtime/credentials");
    const listedText = await listed.text();
    expect(listed.status).toBe(200);
    expect(listedText).toContain('"configured":true');
    expect(listedText).toContain("sha256:");
    expect(listedText).not.toContain("subscription-secret");

    const readiness = await serviceFetch("https://test.local/agent-runtime/readiness");
    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toMatchObject({
      canManage: true,
      harnesses: expect.arrayContaining([
        expect.objectContaining({
          harness: "codex",
          routes: expect.arrayContaining([
            expect.objectContaining({ provider: "openai", ready: true, code: "READY" }),
          ]),
        }),
      ]),
      hostRelay: expect.objectContaining({ connected: false, relay: "not-configured" }),
    });
  });

  it("keeps Harness settings human-user-only", async () => {
    const response = await serviceFetch("https://test.local/agent-runtime/readiness", {
      service: "github-bot",
    });
    expect(response.status).toBe(403);
  });
});
