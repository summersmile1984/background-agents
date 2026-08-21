// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useRuntimeLaunchDraft } from "./use-runtime-launch-draft";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/browser-api-fetch", () => ({
  browserApiFetch: (...args: unknown[]) => fetchMock(...args),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

describe("useRuntimeLaunchDraft", () => {
  beforeEach(() => fetchMock.mockReset());

  it("posts the complete target and runtime draft", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          resolverVersion: "1",
          capabilityCatalogVersion: "test",
          checkedAt: 1,
          draftDigest: "digest",
          launchable: true,
          effective: {},
          options: { harnesses: [], models: [], efforts: [] },
          issues: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const request = {
      target: { kind: "repository" as const, repositoryKey: "repo-1", branch: "main" },
      runtime: { harness: "codex" as const, model: "openai/gpt-5.6-luna", effort: "high" },
    };
    const { result } = renderHook(() => useRuntimeLaunchDraft(request), { wrapper });

    await waitFor(() => expect(result.current.data?.draftDigest).toBe("digest"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent-runtime/resolve-draft",
      expect.objectContaining({ method: "POST", body: JSON.stringify(request) })
    );
  });
});
