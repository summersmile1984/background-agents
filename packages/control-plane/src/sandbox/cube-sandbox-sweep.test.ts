import { describe, it, expect, vi } from "vitest";
import { CubeSandboxSweep } from "./cube-sandbox-sweep";
import type { E2BListedSandbox } from "./e2b-rest-client";
import type { Logger } from "../logger";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const NOW = Date.parse("2026-09-04T00:00:00Z");
const TTL_MS = 72 * 60 * 60 * 1000;

function paused(id: string, startedAt: string, state = "paused"): E2BListedSandbox {
  return { sandboxID: id, state, startedAt };
}

function deps(sandboxes: E2BListedSandbox[]) {
  return {
    listSandboxes: vi.fn(async () => sandboxes),
    killSandbox: vi.fn(async () => {}),
  };
}

describe("CubeSandboxSweep", () => {
  it("reaps paused sandboxes older than the TTL", async () => {
    const provider = deps([
      paused("old-1", "2026-09-01T00:00:00Z"),
      paused("old-2", "2026-08-30T00:00:00Z"),
      paused("fresh", "2026-09-03T20:00:00Z"),
    ]);
    const sweep = new CubeSandboxSweep(provider, log, TTL_MS);

    const result = await sweep.run(NOW);

    expect(result).toMatchObject({ listed: 3, stale: 2, reaped: 2, errored: 0 });
    expect(provider.killSandbox).toHaveBeenCalledWith("old-1");
    expect(provider.killSandbox).toHaveBeenCalledWith("old-2");
    expect(provider.killSandbox).not.toHaveBeenCalledWith("fresh");
  });

  it("ignores running sandboxes", async () => {
    const provider = deps([
      paused("paused-old", "2026-09-01T00:00:00Z"),
      paused("running-old", "2026-09-01T00:00:00Z", "running"),
    ]);
    const sweep = new CubeSandboxSweep(provider, log, TTL_MS);

    const result = await sweep.run(NOW);

    expect(result.stale).toBe(1);
    expect(provider.killSandbox).toHaveBeenCalledTimes(1);
    expect(provider.killSandbox).toHaveBeenCalledWith("paused-old");
  });

  it("skips paused sandboxes without a parseable age anchor", async () => {
    const provider = deps([paused("no-time", "")]);
    const sweep = new CubeSandboxSweep(provider, log, TTL_MS);

    const result = await sweep.run(NOW);

    expect(result.stale).toBe(0);
    expect(provider.killSandbox).not.toHaveBeenCalled();
  });

  it("bounds the batch by the configured limit", async () => {
    const provider = deps(
      Array.from({ length: 5 }, (_, i) => paused(`old-${i}`, "2026-09-01T00:00:00Z"))
    );
    const sweep = new CubeSandboxSweep(provider, log, TTL_MS, 2);

    const result = await sweep.run(NOW);

    expect(result.stale).toBe(5);
    expect(result.reaped).toBe(2);
    expect(provider.killSandbox).toHaveBeenCalledTimes(2);
  });

  it("counts kill failures as errored and keeps going", async () => {
    const provider = deps([
      paused("old-1", "2026-09-01T00:00:00Z"),
      paused("old-2", "2026-08-30T00:00:00Z"),
    ]);
    provider.killSandbox = vi
      .fn()
      .mockRejectedValueOnce(new Error("delete failed"))
      .mockResolvedValueOnce(undefined);
    const sweep = new CubeSandboxSweep(provider, log, TTL_MS);

    const result = await sweep.run(NOW);

    expect(result.reaped).toBe(1);
    expect(result.errored).toBe(1);
  });

  it("returns an empty result when listing fails", async () => {
    const provider = deps([]);
    provider.listSandboxes = vi.fn(async () => {
      throw new Error("api down");
    });
    const sweep = new CubeSandboxSweep(provider, log, TTL_MS);

    const result = await sweep.run(NOW);

    expect(result).toEqual({ listed: 0, stale: 0, reaped: 0, errored: 0 });
    expect(provider.killSandbox).not.toHaveBeenCalled();
  });
});
