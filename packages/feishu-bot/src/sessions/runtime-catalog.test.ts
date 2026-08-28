import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSignedControlPlaneFetch } = vi.hoisted(() => ({
  mockSignedControlPlaneFetch: vi.fn(),
}));

vi.mock("../internal-auth", () => ({
  signedControlPlaneFetch: mockSignedControlPlaneFetch,
}));

import { getRuntimeCatalog } from "./runtime-catalog";

describe("getRuntimeCatalog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns readiness-aware harnesses and draft commands", async () => {
    mockSignedControlPlaneFetch.mockResolvedValue(
      Response.json({
        catalog: [
          {
            harness: "codex",
            displayName: "Codex",
            ready: true,
            settings: [],
            routes: [
              {
                routeId: "codex:openai:subscription",
                ready: true,
                models: [
                  {
                    model: "openai/gpt-5.6-luna",
                    displayName: "GPT 5.6 Luna",
                    routeId: "codex:openai:subscription",
                    ready: true,
                    efforts: [],
                  },
                ],
              },
            ],
          },
          { harness: "claude", displayName: "Claude Code", ready: false, routes: [] },
        ],
        commands: [
          { id: "product.help", slashName: "help", title: "Help", available: true },
          { id: "product.stop", slashName: "stop", title: "Stop", available: false },
        ],
      })
    );

    await expect(
      getRuntimeCatalog(
        { CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "secret" },
        "trace-runtime"
      )
    ).resolves.toMatchObject({
      harnesses: [{ harness: "codex", displayName: "Codex" }],
      commands: [{ slashName: "help" }, { slashName: "stop" }],
    });
  });

  it("returns null when the service route is unavailable", async () => {
    mockSignedControlPlaneFetch.mockResolvedValue(
      Response.json({ error: "unavailable" }, { status: 503 })
    );
    await expect(
      getRuntimeCatalog({ CONTROL_PLANE: {} as Fetcher, SERVICE_AUTH_SECRET: "secret" })
    ).resolves.toBeNull();
  });
});
