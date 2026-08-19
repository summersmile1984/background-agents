import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRelayAdminClient } from "./model-relay-admin-client";

afterEach(() => vi.unstubAllGlobals());

function statusResponse(configured = true): Response {
  return Response.json({
    status: "ok",
    relay: "online",
    deepseek: { configured, fingerprint: configured ? "sha256:abcdef123456" : null },
  });
}

describe("ModelRelayAdminClient", () => {
  it("signs status requests as the outbound-only control-plane service", async () => {
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        statusResponse()
    );
    vi.stubGlobal("fetch", fetchMock);
    const status = await new ModelRelayAdminClient(
      "https://relay-admin.example.test",
      "admin-secret"
    ).status();
    expect(status).toMatchObject({ connected: true, relay: "online" });
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>)["X-OpenInspect-Service"]).toBe(
      "control-plane"
    );
    expect((init?.headers as Record<string, string>)["X-OpenInspect-Service-Signature"]).toMatch(
      /^sig1\./
    );
  });

  it("sends the key only in the signed request body and returns fresh Host status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status: "updated" }))
      .mockResolvedValueOnce(statusResponse());
    vi.stubGlobal("fetch", fetchMock);
    const status = await new ModelRelayAdminClient(
      "https://relay-admin.example.test",
      "admin-secret"
    ).replaceDeepSeekKey("provider-secret");
    expect(status.deepseek.configured).toBe(true);
    expect(fetchMock.mock.calls[0][1]?.body).toBe('{"apiKey":"provider-secret"}');
    expect(JSON.stringify(status)).not.toContain("provider-secret");
  });

  it("degrades status without throwing when the Host is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 }))
    );
    await expect(
      new ModelRelayAdminClient("https://relay-admin.example.test", "admin-secret").status()
    ).resolves.toMatchObject({
      connected: false,
      relay: "unavailable",
      errorCode: "UNAVAILABLE",
    });
  });

  it("rejects an unsafe management URL", () => {
    expect(
      () => new ModelRelayAdminClient("http://relay-admin.example.test", "admin-secret")
    ).toThrow("HTTPS URL");
  });
});
