// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { AgentRuntimeReadinessView } from "@/hooks/use-agent-runtime";
import { HarnessesSettings } from "./harnesses-settings";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  data: undefined as AgentRuntimeReadinessView | undefined,
  refresh: vi.fn(async () => undefined),
  mutate: vi.fn(async () => undefined),
}));

vi.mock("@/hooks/use-agent-runtime", () => ({
  AGENT_RUNTIME_READINESS_KEY: "/api/agent-runtime/readiness",
  useAgentRuntimeReadiness: () => ({
    data: mocks.data,
    error: undefined,
    loading: false,
    refresh: mocks.refresh,
  }),
  updateHarnessCredential: vi.fn(),
  deleteHarnessCredential: vi.fn(),
}));

vi.mock("swr", () => ({ mutate: mocks.mutate }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function readiness(canManage = true, checkedAt = 1): AgentRuntimeReadinessView {
  return {
    checkedAt,
    canManage,
    preferences: {
      defaultAgentHarness: "opencode",
      enabledHarnesses: ["opencode", "codex", "claude", "deepseek"],
    },
    credentials: [
      {
        kind: "codex-auth-json",
        configured: true,
        updatedAt: 1,
        expiresAt: null,
        fingerprint: "sha256:abcdef123456",
      },
      {
        kind: "codex-access-token",
        configured: false,
        updatedAt: null,
        expiresAt: null,
        fingerprint: null,
      },
      {
        kind: "claude-setup-token",
        configured: false,
        updatedAt: null,
        expiresAt: null,
        fingerprint: null,
      },
    ],
    harnesses: (["opencode", "codex", "claude", "deepseek"] as const).map((harness) => ({
      harness,
      enabled: true,
      runtimeAvailable: true,
      routes: [{ provider: "any" as const, ready: true, code: "READY" as const }],
    })),
    hostRelay: {
      connected: true,
      checkedAt,
      relay: "online",
      deepseek: { configured: true, fingerprint: "sha256:relay123456" },
    },
  };
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

beforeEach(() => {
  mocks.data = readiness();
  mocks.refresh.mockClear();
  mocks.mutate.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HarnessesSettings", () => {
  it("shows metadata without returning stored credential values", async () => {
    render(<HarnessesSettings />);

    expect(await screen.findByText(/sha256:abcdef123456/)).toBeInTheDocument();
    expect(screen.getByLabelText("New credential", { selector: "textarea" })).toHaveValue("");
    expect(screen.getByLabelText("New DeepSeek API key")).toHaveValue("");
    expect(screen.getByText(/SANDBOX_AUTH_TOKEN is generated automatically/)).toBeInTheDocument();
  });

  it("keeps unsaved Harness edits across status refreshes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<HarnessesSettings />);
    const codexToggle = await screen.findByRole("switch", { name: "Enable Codex" });

    await user.click(codexToggle);
    expect(codexToggle).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save Harness preferences" })).toBeEnabled();

    mocks.data = readiness(true, 2);
    rerender(<HarnessesSettings />);

    expect(screen.getByRole("switch", { name: "Enable Codex" })).not.toBeChecked();
  });

  it("submits the enabled Harness set and deployment default", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "updated" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<HarnessesSettings />);

    await user.click(await screen.findByRole("switch", { name: "Enable Codex" }));
    await user.click(screen.getByRole("button", { name: "Save Harness preferences" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent-runtime/preferences",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          defaultAgentHarness: "opencode",
          enabledHarnesses: ["opencode", "claude", "deepseek"],
        }),
      })
    );
  });

  it("renders shared controls read-only for non-admin users", async () => {
    mocks.data = readiness(false);
    render(<HarnessesSettings />);

    expect(await screen.findByText(/only a deployment administrator/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enable Codex" })).toBeDisabled();
    expect(screen.getByLabelText("New DeepSeek API key")).toBeDisabled();
  });
});
