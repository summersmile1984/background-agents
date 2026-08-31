import { describe, expect, it, vi } from "vitest";
import { PENDING_PROMPT_DISPATCH_TIMEOUT_MS } from "./message-queue";
import {
  StalePendingSweep,
  type StalePendingClient,
  type StalePendingIndex,
} from "./stale-pending-sweep";
import type { Logger } from "../logger";

const NOW = 1_000_000_000;

function log(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function index(ids: string[] | Error): StalePendingIndex {
  return {
    listStaleActiveSessionIds: vi.fn(async () => {
      if (ids instanceof Error) throw ids;
      return ids;
    }),
    failOrphanedActiveSession: vi.fn(async () => true),
  };
}

function client(
  outcomes: Record<string, Awaited<ReturnType<StalePendingClient["reconcilePending"]>> | Error> = {}
): StalePendingClient {
  return {
    reconcilePending: vi.fn(async (sessionId: string) => {
      const outcome = outcomes[sessionId] ?? "none";
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
}

describe("StalePendingSweep", () => {
  it("queries the active-session cutoff and aggregates outcomes", async () => {
    const idx = index(["failed", "waiting", "connected", "missing"]);
    const sweep = new StalePendingSweep(
      idx,
      client({ failed: "failed", waiting: "waiting", connected: "connected", missing: "missing" }),
      log(),
      PENDING_PROMPT_DISPATCH_TIMEOUT_MS,
      50
    );
    const result = await sweep.run(NOW);
    expect(idx.listStaleActiveSessionIds).toHaveBeenCalledWith(
      NOW - PENDING_PROMPT_DISPATCH_TIMEOUT_MS,
      50
    );
    expect(result).toMatchObject({
      candidates: 4,
      failed: 1,
      waiting: 1,
      connected: 1,
      missing: 1,
      errored: 0,
    });
  });

  it("isolates failed DO requests", async () => {
    const logger = log();
    const result = await new StalePendingSweep(
      index(["healthy", "broken"]),
      client({ broken: new Error("unreachable") }),
      logger,
      100,
      50
    ).run(NOW);
    expect(result).toMatchObject({ candidates: 2, noWork: 1, errored: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      "Stale pending session recovery failed",
      expect.objectContaining({ session_id: "broken" })
    );
  });
});
