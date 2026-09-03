/**
 * CubeSandboxSweep — reaps paused Cube sandboxes the control plane leaked.
 *
 * The lifecycle manager pauses (never kills) a sandbox on idle timeout so a
 * follow-up prompt can resume it in place. That is the right behaviour while
 * the session is live, but a paused sandbox whose session ended — completed
 * and then abandoned, or whose kill failed during replacement — would otherwise
 * sit in Cube indefinitely. This sweep is the backstop: it reaps paused
 * sandboxes older than the TTL, so the pause path stays resumable without
 * accumulating provider-side objects forever.
 */

import type { Logger } from "../logger";
import type { E2BListedSandbox } from "./e2b-rest-client";

/** Offset from the other sweeps so they never fire together. */
export const CUBE_SANDBOX_SWEEP_CRON = "53 * * * *";

/**
 * A paused sandbox this old is treated as leaked. Deliberately long: a user
 * may leave a session paused overnight and still expect an instant resume. The
 * sweep is a backstop, not a resource optimizer.
 */
export const CUBE_SANDBOX_SWEEP_TTL_MS = 72 * 60 * 60 * 1000;

/** Max sandboxes reaped per sweep (backpressure; a backlog drains over ticks). */
export const CUBE_SANDBOX_SWEEP_LIMIT = 100;

/** Provider operations the sweep needs; `E2BRestClient` satisfies it. */
export interface CubeSandboxSweepDeps {
  listSandboxes(): Promise<E2BListedSandbox[]>;
  killSandbox(id: string): Promise<void>;
}

export interface CubeSandboxSweepResult {
  /** Total sandboxes the provider returned. */
  listed: number;
  /** Paused sandboxes older than the TTL. */
  stale: number;
  /** Sandboxes successfully killed. */
  reaped: number;
  /** Sandboxes whose kill failed (retried on a later tick). */
  errored: number;
}

export class CubeSandboxSweep {
  constructor(
    private readonly deps: CubeSandboxSweepDeps,
    private readonly log: Logger,
    private readonly ttlMs: number = CUBE_SANDBOX_SWEEP_TTL_MS,
    private readonly limit: number = CUBE_SANDBOX_SWEEP_LIMIT
  ) {}

  async run(now: number): Promise<CubeSandboxSweepResult> {
    const result: CubeSandboxSweepResult = { listed: 0, stale: 0, reaped: 0, errored: 0 };

    let sandboxes: E2BListedSandbox[];
    try {
      sandboxes = await this.deps.listSandboxes();
    } catch (error) {
      this.log.error("Cube sandbox sweep failed to list sandboxes", {
        event: "cube.sandbox_sweep_list_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return result;
    }

    result.listed = sandboxes.length;

    // Oldest-first so the backlog drains deterministically across ticks.
    const stale = sandboxes
      .filter((sandbox) => this.isStalePaused(sandbox, now))
      .sort((left, right) => this.ageAnchor(left).localeCompare(this.ageAnchor(right)));

    result.stale = stale.length;

    const outcomes = await Promise.allSettled(
      stale.slice(0, this.limit).map((sandbox) => this.reapOne(sandbox.sandboxID))
    );

    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        result.errored += 1;
      } else {
        result.reaped += 1;
      }
    }

    this.log.info("Cube sandbox sweep completed", {
      event: "cube.sandbox_sweep",
      listed: result.listed,
      stale: result.stale,
      reaped: result.reaped,
      errored: result.errored,
    });

    return result;
  }

  private isStalePaused(sandbox: E2BListedSandbox, now: number): boolean {
    if (sandbox.state !== "paused") return false;
    const anchor = this.ageAnchor(sandbox);
    if (!anchor) return false;
    const anchorMs = Date.parse(anchor);
    if (Number.isNaN(anchorMs)) return false;
    return now - anchorMs >= this.ttlMs;
  }

  /**
   * Age anchor for a listed sandbox. `startedAt` is the stable create/start
   * timestamp; `endAt` is a fallback for Cube versions that only populate it.
   */
  private ageAnchor(sandbox: E2BListedSandbox): string {
    return sandbox.startedAt ?? sandbox.endAt ?? "";
  }

  private async reapOne(sandboxId: string): Promise<void> {
    try {
      await this.deps.killSandbox(sandboxId);
    } catch (error) {
      this.log.warn("Cube sandbox sweep kill failed", {
        event: "cube.sandbox_sweep_kill_failed",
        sandbox_id: sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
