import { describe, expect, it } from "vitest";
import { buildRuntimeHarnessOptions } from "./capabilities";

const readiness = [
  {
    harness: "opencode" as const,
    enabled: true,
    runtimeAvailable: true,
    routes: [
      { provider: "any" as const, ready: true, code: "READY" as const },
      { provider: "deepseek" as const, ready: true, code: "READY" as const },
    ],
  },
  {
    harness: "codex" as const,
    enabled: true,
    runtimeAvailable: true,
    routes: [
      { provider: "openai" as const, ready: true, code: "READY" as const },
      { provider: "deepseek" as const, ready: true, code: "READY" as const },
    ],
  },
  {
    harness: "claude" as const,
    enabled: true,
    runtimeAvailable: true,
    routes: [
      {
        provider: "anthropic" as const,
        ready: false,
        code: "CREDENTIAL_MISSING" as const,
        message: "Claude credential is not configured",
      },
      { provider: "deepseek" as const, ready: true, code: "READY" as const },
    ],
  },
  {
    harness: "deepseek" as const,
    enabled: true,
    runtimeAvailable: true,
    routes: [{ provider: "deepseek" as const, ready: true, code: "READY" as const }],
  },
];

describe("runtime capability catalog", () => {
  it("does not make an unready Claude provider selectable through another ready route", () => {
    const options = buildRuntimeHarnessOptions({
      readiness,
      enabledModels: ["anthropic/claude-haiku-4-5", "deepseek/deepseek-v4-flash"],
    });
    const claude = options.find((option) => option.harness === "claude")!;
    expect(claude.ready).toBe(true);
    expect(
      claude.routes
        .find((route) => route.provider === "anthropic")!
        .models.find((model) => model.model === "anthropic/claude-haiku-4-5")
    ).toMatchObject({ ready: false, disabledReason: "Claude credential is not configured" });
    expect(
      claude.routes
        .find((route) => route.provider === "deepseek")!
        .models.find((model) => model.model === "deepseek/deepseek-v4-flash")
    ).toMatchObject({ ready: true });
  });

  it("removes max from Codex efforts when the driver cannot transmit it", () => {
    const options = buildRuntimeHarnessOptions({
      readiness,
      enabledModels: ["openai/gpt-5.6-luna"],
    });
    const luna = options
      .find((option) => option.harness === "codex")!
      .routes.flatMap((route) => route.models)
      .find((model) => model.model === "openai/gpt-5.6-luna")!;
    expect(luna.efforts.map((effort) => effort.value)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("does not advertise API-only models to a ChatGPT-backed Codex sandbox", () => {
    const options = buildRuntimeHarnessOptions({
      readiness,
      enabledModels: ["openai/gpt-5.3-codex", "openai/gpt-5.6-luna"],
      codexSubscriptionConfigured: true,
    });
    const codexModels = options
      .find((option) => option.harness === "codex")!
      .routes.find((route) => route.routeId === "codex:openai:subscription")!
      .models.map((model) => model.model);

    expect(codexModels).not.toContain("openai/gpt-5.3-codex");
    expect(codexModels).toContain("openai/gpt-5.6-luna");
  });
});
