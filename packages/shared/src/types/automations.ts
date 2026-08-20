import { z } from "zod";
import {
  automationTriggerTypeSchema,
  triggerConfigSchema,
  type AutomationTriggerType,
  type TriggerConfig,
} from "../triggers/types";
import {
  MAX_TARGET_REPOSITORIES,
  repositoriesInputSchema,
  repositoryInputSchema,
} from "./repositories";
import type { RepositoryInput, RepositoryRef } from "./repositories";
import { agentHarnessSchema, type AgentHarness } from "./agent-harness";

export type AutomationRunStatus = "starting" | "running" | "completed" | "failed" | "skipped";

export type AutomationInvocationSource = "schedule" | "manual" | "event";

/**
 * Derived from an invocation's child runs — never stored. Zero children ⇔
 * skipped; `partial_failed` means the runs finished terminal with a mix of
 * completed and failed.
 */
export type AutomationInvocationStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "partial_failed"
  | "skipped";

/** Maximum repositories an automation can fan out across per invocation. */
export const MAX_AUTOMATION_REPOSITORIES = MAX_TARGET_REPOSITORIES;

/** A repository selected on an automation (response shape, resolved). */
const automationRepositorySchema = z.object({
  repositoryKey: z.string().min(1).nullable().optional(),
  connectionId: z.string().min(1).nullable().optional(),
  repoOwner: z.string(),
  repoName: z.string(),
  repoId: z.number().nullable(),
  baseBranch: z.string().nullable(),
});

export type AutomationRepository = z.infer<typeof automationRepositorySchema>;

/**
 * Convert a resolved automation-shaped repository into a RepositoryRef.
 * Throws when repoId is missing — refs are the fully-resolved flavor.
 */
export function toRepositoryRef(
  repo: AutomationRepository,
  fallbackBaseBranch = "main"
): RepositoryRef {
  if (repo.repoId == null) {
    throw new Error(`repository ${repo.repoOwner}/${repo.repoName} is not resolved (no repoId)`);
  }
  return {
    ...(repo.repositoryKey ? { repositoryKey: repo.repositoryKey } : {}),
    ...(repo.connectionId ? { connectionId: repo.connectionId } : {}),
    repoOwner: repo.repoOwner,
    repoName: repo.repoName,
    repoId: repo.repoId,
    baseBranch: repo.baseBranch ?? fallbackBaseBranch,
  };
}

// Aliases: the input schemas are target-agnostic (defined with the repository
// list contracts above); existing automation imports keep working.
export const automationRepositoryInputSchema = repositoryInputSchema;
export type AutomationRepositoryInput = RepositoryInput;
export const automationRepositoriesInputSchema = repositoriesInputSchema;

export const automationRepositoryKeysInputSchema = z
  .array(
    z.object({
      repositoryKey: z.string().trim().min(1),
      baseBranch: z.string().trim().min(1).nullish(),
    })
  )
  .max(MAX_AUTOMATION_REPOSITORIES)
  .superRefine((repositories, ctx) => {
    const seen = new Set<string>();
    repositories.forEach((repository, index) => {
      if (seen.has(repository.repositoryKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate repository key: ${repository.repositoryKey}`,
          path: [index],
        });
      }
      seen.add(repository.repositoryKey);
    });
  });
export type AutomationRepositoryKeyInput = z.input<
  typeof automationRepositoryKeysInputSchema
>[number];

const automationSchema = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string(),
  triggerType: automationTriggerTypeSchema,
  scheduleCron: z.string().nullable(),
  scheduleTz: z.string(),
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  agentHarness: agentHarnessSchema.nullable().optional(),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  consecutiveFailures: z.number(),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().nullable(),
  eventType: z.string().nullable(),
  triggerConfig: triggerConfigSchema.nullable(),
  repositories: z.array(automationRepositorySchema),
  environmentIds: z.array(z.string()),
});

export type Automation = z.infer<typeof automationSchema>;

export interface CreateAutomationRequest {
  name: string;
  instructions: string;
  triggerType?: AutomationTriggerType;
  scheduleCron?: string;
  scheduleTz?: string;
  model?: string;
  reasoningEffort?: string | null;
  agentHarness?: AgentHarness | null;
  eventType?: string;
  triggerConfig?: TriggerConfig;
  sentryClientSecret?: string;
  /** Repositories to run against (0..MAX_AUTOMATION_REPOSITORIES). */
  repositories?: AutomationRepositoryInput[];
  /** Stable repository identities. Mutually exclusive with repositories. */
  repositoryKeys?: AutomationRepositoryKeyInput[];
  /** Environments to fan out over, one workspace session each (design §13.3). */
  environmentIds?: string[];
}

export interface UpdateAutomationRequest {
  name?: string;
  instructions?: string;
  scheduleCron?: string;
  scheduleTz?: string;
  model?: string;
  reasoningEffort?: string | null;
  agentHarness?: AgentHarness | null;
  eventType?: string;
  triggerConfig?: TriggerConfig;
  /** Replaces the full repository selection when present. */
  repositories?: AutomationRepositoryInput[];
  /** Stable repository identities. Mutually exclusive with repositories. */
  repositoryKeys?: AutomationRepositoryKeyInput[];
  /** Replaces the full environment selection when present (empty clears). */
  environmentIds?: string[];
}

export interface AutomationRun {
  id: string;
  automationId: string;
  /** The firing this run belongs to. */
  invocationId: string;
  sessionId: string | null;
  status: AutomationRunStatus;
  skipReason: string | null;
  failureReason: string | null;
  scheduledAt: number;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  sessionTitle: string | null;
  artifactSummary: string | null;
  /**
   * Repository snapshot taken at firing time — history never depends on the
   * live selection. Null for repo-less runs and legacy session-less rows.
   */
  repoOwner: string | null;
  repoName: string | null;
  repoId: number | null;
  repositoryKey?: string | null;
  connectionId?: string | null;
  baseBranch: string | null;
  /**
   * Environment snapshot taken at firing time; the run's session opens this
   * environment's workspace. Null for repository and repo-less runs.
   */
  environmentId: string | null;
}

export const listAutomationsResponseSchema = z.discriminatedUnion("hasMore", [
  z.object({
    automations: z.array(automationSchema),
    hasMore: z.literal(false),
    nextCursor: z.null(),
  }),
  z.object({
    automations: z.array(automationSchema),
    hasMore: z.literal(true),
    nextCursor: z.string().min(1),
  }),
]);

export type ListAutomationsResponse = z.infer<typeof listAutomationsResponseSchema>;

/**
 * One firing of an automation: 0 runs when skipped, else one run per target —
 * repository or environment — with repo-less automations getting a single run.
 */
export interface AutomationInvocation {
  id: string;
  automationId: string;
  status: AutomationInvocationStatus;
  source: AutomationInvocationSource;
  /** The cron slot this firing served; null for manual/event firings. */
  scheduledAt: number | null;
  /** Non-null ⇔ this firing was skipped (runs is then empty). */
  skipReason: string | null;
  createdAt: number;
  /** Latest child completion; null until all runs are terminal. */
  completedAt: number | null;
  runs: AutomationRun[];
}

export interface ListAutomationInvocationsResponse {
  invocations: AutomationInvocation[];
  /** Counts invocations (each firing is one row regardless of fan-out width). */
  total: number;
}
