// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SourceControlSettings } from "./source-control-settings";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  canManage: true,
  connections: [] as unknown[],
  mutate: vi.fn(),
}));

vi.mock("swr", () => ({
  default: (key: string | null) =>
    key === "/api/scm/migration/preflight"
      ? {
          data: {
            defaultConnectionId: "scm_github",
            preflight: {
              legacyRepositoryLocations: 0,
              unresolvedActiveRepositories: 0,
              mixedSessionAggregates: 0,
              mixedEnvironmentAggregates: 0,
              mixedAutomationAggregates: 0,
              orphanRepositoryReferences: 0,
              readyForSecondConnection: true,
              job: null,
            },
          },
          mutate: mocks.mutate,
        }
      : {
          data: { connections: mocks.connections, canManage: mocks.canManage },
          error: undefined,
          isLoading: false,
        },
  mutate: mocks.mutate,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  mocks.canManage = true;
  mocks.connections = [];
  mocks.mutate.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SourceControlSettings", () => {
  it("checks the host and security version before accepting a PAT", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/scm/connections/preflight");
      return Response.json({
        preflight: {
          status: "ready",
          baseUrl: "https://gitea.aotsea.com",
          apiBaseUrl: "https://gitea.aotsea.com/api/v1",
          cloneBaseUrl: "https://gitea.aotsea.com",
          host: "gitea.aotsea.com",
          version: "1.27.2",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SourceControlSettings />);

    await user.click(screen.getByRole("button", { name: "Add Gitea" }));
    const token = screen.getByLabelText("Personal access token");
    expect(token).toBeDisabled();

    await user.type(screen.getByLabelText("Gitea base URL"), "https://gitea.aotsea.com");
    await user.click(screen.getByRole("button", { name: "Check host and version" }));

    await waitFor(() => expect(token).toBeEnabled());
    expect(screen.getByText(/Ready · gitea\.aotsea\.com · Gitea 1\.27\.2/)).toBeInTheDocument();
  });

  it("labels Quick Tunnel connections as ephemeral tests", () => {
    mocks.canManage = false;
    mocks.connections = [
      {
        id: "scm_test",
        provider: "gitea",
        displayName: "Temporary Gitea",
        baseUrl: "https://example.trycloudflare.com",
        apiBaseUrl: "https://example.trycloudflare.com/api/v1",
        cloneBaseUrl: "https://example.trycloudflare.com",
        authMode: "pat",
        username: "agent",
        enabled: true,
        isDefault: false,
        health: "healthy",
        version: "1.27.2",
        revision: 1,
        lastCheckedAt: Date.now(),
        lastErrorCode: null,
        capabilities: {
          listRepositories: true,
          listBranches: true,
          createPullRequest: true,
          draftPullRequest: false,
          userOAuth: false,
          webhooks: false,
          commitSigning: false,
          repositoryById: true,
        },
        credentialConfigured: true,
      },
    ];

    render(<SourceControlSettings />);

    expect(screen.getByText("Ephemeral test")).toBeInTheDocument();
    expect(screen.getByText("example.trycloudflare.com")).toBeInTheDocument();
  });
});
