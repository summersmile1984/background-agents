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

  it("stores canonical personal runtime defaults without credentials", async () => {
    const userId = "11111111111111111111111111111111";
    const saved = await serviceFetch(
      `https://test.local/agent-runtime/configurations/user/${userId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          config: {
            harness: "claude",
            model: "deepseek/deepseek-v4-flash",
            settings: { systemPromptAppend: "Keep changes focused." },
          },
        }),
      }
    );
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    expect(savedText).toContain('"scope":"user"');
    expect(savedText).not.toContain("token");
    expect(savedText).not.toContain("apiKey");

    const row = await env.DB.prepare(
      "SELECT scope_type, scope_id, config_json FROM runtime_configurations WHERE scope_type = 'user'"
    ).first<{ scope_type: string; scope_id: string; config_json: string }>();
    expect(row).toEqual({
      scope_type: "user",
      scope_id: userId,
      config_json: JSON.stringify({
        harness: "claude",
        model: "deepseek/deepseek-v4-flash",
        settings: { systemPromptAppend: "Keep changes focused." },
      }),
    });
  });

  it("allows Slack to update only its own namespaced preference", async () => {
    const own = await serviceFetch(
      "https://test.local/agent-runtime/configurations/user/slack%3AU123",
      {
        service: "slack-bot",
        actor: "slack:U123",
        method: "PUT",
        body: JSON.stringify({
          config: { harness: "codex", model: "openai/gpt-5.6-luna", effort: "high" },
        }),
      }
    );
    expect(own.status).toBe(200);

    const anotherUser = await serviceFetch(
      "https://test.local/agent-runtime/configurations/user/slack%3AU999",
      {
        service: "slack-bot",
        actor: "slack:U123",
        method: "PUT",
        body: JSON.stringify({ config: { harness: "deepseek" } }),
      }
    );
    expect(anotherUser.status).toBe(403);
  });

  it("exposes the secret-free capability catalog to integrations", async () => {
    const response = await serviceFetch("https://test.local/agent-runtime/catalog", {
      service: "slack-bot",
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("capabilityCatalogVersion");
    expect(text).toContain("codex:openai:subscription");
    expect(text).not.toContain("encrypted_value");
    expect(text).not.toContain("access_token");
  });
});
