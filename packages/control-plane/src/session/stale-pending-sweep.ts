/**
 * Reconcile sessions that were left active by an older deployment before the
 * pending-dispatch alarm was installed. The Durable Object is the source of
 * truth for messages; D1 only supplies a bounded list of candidates to wake.
 */

import { z } from "zod";
import { buildSessionInternalUrl, SessionInternalPaths } from "./contracts";
import type { Logger } from "../logger";
import { PENDING_PROMPT_DISPATCH_TIMEOUT_MS } from "./message-queue";

export const STALE_PENDING_SWEEP_CRON = "43 * * * *";
export const STALE_PENDING_SWEEP_LIMIT = 50;
export const STALE_PENDING_SWEEP_TIMEOUT_MS = 10_000;

const recoveryOutcomeSchema = z.enum(["none", "connected", "waiting", "failed"]);
const recoveryResponseSchema = z.object({ outcome: recoveryOutcomeSchema });

export type PendingRecoveryOutcome = z.infer<typeof recoveryOutcomeSchema> | "missing";

export interface StalePendingIndex {
  listStaleActiveSessionIds(staleBefore: number, limit: number): Promise<string[]>;
  failOrphanedActiveSession(id: string): Promise<boolean>;
}

export interface StalePendingClient {
  reconcilePending(sessionId: string): Promise<PendingRecoveryOutcome>;
}

export class SessionPendingRecoveryClient implements StalePendingClient {
  constructor(private readonly sessions: DurableObjectNamespace) {}

  async reconcilePending(sessionId: string): Promise<PendingRecoveryOutcome> {
    const stub = this.sessions.get(this.sessions.idFromName(sessionId));
    const response = await stub.fetch(
      buildSessionInternalUrl(SessionInternalPaths.reconcilePending),
      {
        method: "POST",
        signal: AbortSignal.timeout(STALE_PENDING_SWEEP_TIMEOUT_MS),
      }
    );
    if (response.status === 404) return "missing";
    if (!response.ok) throw new Error(`Pending recovery failed with status ${response.status}`);
    const parsed = recoveryResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Pending recovery returned an unrecognized outcome");
    return parsed.data.outcome;
  }
}

export interface StalePendingSweepResult {
  candidates: number;
  failed: number;
  waiting: number;
  noWork: number;
  connected: number;
  missing: number;
  errored: number;
  truncated: boolean;
}

export class StalePendingSweep {
  constructor(
    private readonly index: StalePendingIndex,
    private readonly client: StalePendingClient,
    private readonly log: Logger,
    private readonly timeoutMs: number = PENDING_PROMPT_DISPATCH_TIMEOUT_MS,
    private readonly limit: number = STALE_PENDING_SWEEP_LIMIT
  ) {}

  async run(now: number): Promise<StalePendingSweepResult> {
    const empty: StalePendingSweepResult = {
      candidates: 0,
      failed: 0,
      waiting: 0,
      noWork: 0,
      connected: 0,
      missing: 0,
      errored: 0,
      truncated: false,
    };
    let candidates: string[];
    try {
      candidates = await this.index.listStaleActiveSessionIds(now - this.timeoutMs, this.limit);
    } catch (error) {
      this.log.error("Stale pending sweep failed to query candidates", {
        event: "scheduler.stale_pending_sweep_query_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
    if (candidates.length === 0) return empty;

    const outcomes = await Promise.allSettled(
      candidates.map((sessionId) => this.client.reconcilePending(sessionId))
    );
    const result: StalePendingSweepResult = {
      ...empty,
      candidates: candidates.length,
      truncated: candidates.length === this.limit,
    };
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "rejected") {
        result.errored += 1;
        this.log.warn("Stale pending session recovery failed", {
          event: "scheduler.stale_pending_recovery_failed",
          session_id: candidates[index],
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
        continue;
      }
      switch (outcome.value) {
        case "failed":
          result.failed += 1;
          break;
        case "waiting":
          result.waiting += 1;
          break;
        case "connected":
          result.connected += 1;
          break;
        case "none":
          result.noWork += 1;
          break;
        case "missing":
          result.missing += 1;
          try {
            await this.index.failOrphanedActiveSession(candidates[index]);
          } catch (error) {
            result.errored += 1;
            this.log.warn("Orphaned active session index repair failed", {
              event: "scheduler.stale_pending_index_repair_failed",
              session_id: candidates[index],
              error: error instanceof Error ? error.message : String(error),
            });
          }
          break;
      }
    }
    this.log.info("Stale pending sweep completed", {
      event: "scheduler.stale_pending_sweep",
      candidates: result.candidates,
      failed: result.failed,
      waiting: result.waiting,
      no_work: result.noWork,
      connected: result.connected,
      missing: result.missing,
      errored: result.errored,
      truncated: result.truncated,
    });
    return result;
  }
}
