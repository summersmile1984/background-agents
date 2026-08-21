/**
 * Session targets for the Slack bot.
 *
 * Every surface that picks "what to work on" — routing rules, clarification
 * quick-picks, the repository picker — resolves to a {@link SlackSessionTarget}:
 * a repository or a saved environment. Targets unify instead of migrate —
 * repositories never stop working; environments join them.
 *
 * This module owns the target-kind policy (value encoding, labels, launch
 * request fields, branch-preference applicability) so the message handler
 * stays orchestration-only. It is a pure leaf — no I/O — so anything,
 * including the types barrel, can import it.
 */

import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import type { Environment } from "@open-inspect/shared/types/environments";

export type SlackSessionTarget =
  | { kind: "repository"; repo: RepoConfig }
  | { kind: "environment"; environment: Environment };

/**
 * Prefix for environment values in Slack select options and quick-pick buttons.
 * Repository values prefer the stable Open-Inspect repository key and fall
 * back to the legacy `owner/name` id. Environment values are explicitly
 * prefixed, mirroring the web picker's `env:<id>` convention.
 */
const ENVIRONMENT_VALUE_PREFIX = "env:";

/** Reference decoded from a Slack option/button value — resolved against the live lists. */
export type SlackTargetRef =
  | { kind: "repository"; repoId: string }
  | { kind: "environment"; environmentId: string };

/** Stable option/button value: repository key (or legacy id), or `env:<id>`. */
export function targetValue(target: SlackSessionTarget): string {
  return target.kind === "environment"
    ? `${ENVIRONMENT_VALUE_PREFIX}${target.environment.id}`
    : (target.repo.repositoryKey ?? target.repo.id);
}

/**
 * Decode a Slack option/button value back into a target reference. Bare values
 * are repository keys or legacy repository ids — including every value in
 * clarification messages posted before environments existed.
 */
export function parseTargetValue(value: string): SlackTargetRef {
  if (value.startsWith(ENVIRONMENT_VALUE_PREFIX)) {
    return { kind: "environment", environmentId: value.slice(ENVIRONMENT_VALUE_PREFIX.length) };
  }
  return { kind: "repository", repoId: value };
}

/**
 * Canonical display label: the repo fullName or the environment name, **raw**.
 * Environment names are arbitrary user text — every `mrkdwn` render site must
 * escape this with `escapeMrkdwnText` (a name like `<!channel>` must never
 * become a live broadcast mention). Stored records (thread sessions, callback
 * contexts) carry the raw label so the encoding stays a render concern.
 */
export function targetLabel(target: SlackSessionTarget): string {
  return target.kind === "environment" ? target.environment.name : target.repo.fullName;
}

/** Stable id for storage: repository key (or legacy id), or environment id. */
export function targetId(target: SlackSessionTarget): string {
  return target.kind === "environment"
    ? target.environment.id
    : (target.repo.repositoryKey ?? target.repo.id);
}

/**
 * Create-session request fields for a target: stable repositoryKey when
 * available, legacy repoOwner/repoName otherwise, or environmentId. The create
 * schema makes these mutually exclusive, and an environment defines branches.
 */
export function buildSessionTargetRequestFields(
  target: SlackSessionTarget,
  branch: string | undefined
):
  | { repositoryKey: string; branch?: string }
  | { repoOwner: string; repoName: string; branch?: string }
  | { environmentId: string } {
  if (target.kind === "environment") return { environmentId: target.environment.id };
  if (target.repo.repositoryKey) return { repositoryKey: target.repo.repositoryKey, branch };
  return { repoOwner: target.repo.owner, repoName: target.repo.name, branch };
}

/**
 * The repository whose per-user branch preference applies to this launch, or
 * null when none does — an environment defines its own branches.
 */
export function branchPreferenceRepo(target: SlackSessionTarget): RepoConfig | null {
  return target.kind === "repository" ? target.repo : null;
}
