import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedSlack from "@open-inspect/shared/slack";
import type { Env } from "../types";

const { mockVerifySlackSignature } = vi.hoisted(() => ({
  mockVerifySlackSignature: vi.fn(),
}));

vi.mock("@open-inspect/shared/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedSlack>()),
  verifySlackSignature: mockVerifySlackSignature,
}));

import { commandRoutes } from "./commands";

function request(text: string): Request {
  return new Request("http://localhost/commands", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-signature": "v0=test",
      "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
    },
    body: new URLSearchParams({
      command: "/inspect",
      text,
      response_url: "https://hooks.slack.com/commands/T1/1/secret",
      user_id: "U123",
      channel_id: "C123",
      trigger_id: "123.456.token",
    }),
  });
}

function makeEnv(controlPlaneFetch = vi.fn()): Env {
  return {
    CONTROL_PLANE: { fetch: controlPlaneFetch },
    SERVICE_AUTH_SECRET: "service-secret",
    SLACK_SIGNING_SECRET: "signing-secret",
    WEB_APP_URL: "https://inspect.example.com",
  } as unknown as Env;
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as any;
}

describe("POST /commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockVerifySlackSignature.mockResolvedValue(true);
  });

  it("rejects an invalid Slack signature", async () => {
    mockVerifySlackSignature.mockResolvedValue(false);
    const response = await commandRoutes.fetch(request("help"), makeEnv(), makeCtx());
    expect(response.status).toBe(401);
  });

  it("shows namespaced help without calling the control plane", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const response = await commandRoutes.fetch(request("help"), env, ctx);
    const payload = (await response.json()) as { text: string };

    expect(response.status).toBe(200);
    expect(payload.text).toContain("/inspect status <session-id-or-url>");
    expect(payload.text).toContain("Slack uses `/inspect status`");
    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("acknowledges status immediately and returns Gitea runtime details asynchronously", async () => {
    const controlPlaneFetch = vi.fn(async () =>
      Response.json({
        action: "show-status",
        runtime: {
          target: {
            provider: "gitea",
            repositories: [{ owner: "huangdong", name: "n9n", branch: "main" }],
          },
          harness: "codex",
          routeId: "codex-openai-subscription",
          model: "gpt-5.6-codex",
          effort: "high",
          sandboxStatus: "running",
          sessionStatus: "running",
        },
      })
    );
    const responseUrlFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const env = makeEnv(controlPlaneFetch);
    const ctx = makeCtx();

    const response = await commandRoutes.fetch(
      request("status https://inspect.example.com/session/session-123"),
      env,
      ctx
    );
    expect(await response.json()).toEqual({
      response_type: "ephemeral",
      text: "Running `/inspect status`\u2026",
    });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await ctx.waitUntil.mock.calls[0][0];

    expect(controlPlaneFetch).toHaveBeenCalledOnce();
    const [url, init] = controlPlaneFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://internal/sessions/session-123/commands");
    expect(JSON.parse(String(init.body))).toEqual({
      commandId: "product.status",
      arguments: {},
      clientInvocationId: "slack:123.456.token",
    });
    expect(new Headers(init.headers).get("X-OpenInspect-Actor")).toBe("slack:U123");

    const responseBody = JSON.parse(String(responseUrlFetch.mock.calls[0]?.[1]?.body)) as {
      text: string;
    };
    expect(responseBody.text).toContain("Source: gitea");
    expect(responseBody.text).toContain("huangdong/n9n@main");
    expect(responseBody.text).toContain("Harness: codex");
  });

  it("does not accept an arbitrary response URL", async () => {
    const unsafe = request("status session-123");
    const body = await unsafe.text();
    const params = new URLSearchParams(body);
    params.set("response_url", "https://attacker.example/callback");
    const response = await commandRoutes.fetch(
      new Request(unsafe.url, { method: "POST", headers: unsafe.headers, body: params }),
      makeEnv(),
      makeCtx()
    );
    expect(response.status).toBe(400);
  });
});
