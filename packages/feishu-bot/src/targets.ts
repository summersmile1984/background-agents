import { controlPlaneReposResponseSchema } from "@open-inspect/shared/types/repository-catalog";
import type { z } from "zod";
import { signedControlPlaneFetch, type ControlPlaneEnv } from "./internal-auth";

export interface FeishuRepositoryTarget {
  repositoryKey: string;
  fullName: string;
  displayName: string;
  provider: string;
  defaultBranch: string;
}

function toTarget(
  repo: z.infer<typeof controlPlaneReposResponseSchema>["repos"][number]
): FeishuRepositoryTarget | null {
  if (!repo.repositoryKey) return null;
  return {
    repositoryKey: repo.repositoryKey,
    fullName: `${repo.owner}/${repo.name}`,
    displayName: repo.name,
    provider: repo.provider ?? "source control",
    defaultBranch: repo.defaultBranch,
  };
}

export async function listRepositoryTargets(
  env: ControlPlaneEnv,
  traceId?: string
): Promise<FeishuRepositoryTarget[]> {
  const response = await signedControlPlaneFetch(
    env,
    { method: "GET", url: "https://internal/repos", traceId },
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }
  );
  if (!response.ok) return [];
  const parsed = controlPlaneReposResponseSchema.safeParse(await response.json());
  if (!parsed.success) return [];
  return parsed.data.repos.flatMap((repo) => {
    const target = toTarget(repo);
    return target ? [target] : [];
  });
}

export function findRepositoryTarget(
  targets: FeishuRepositoryTarget[],
  repositoryKey: string
): FeishuRepositoryTarget | null {
  return targets.find((target) => target.repositoryKey === repositoryKey) ?? null;
}

/**
 * Deterministic, non-LLM matching for the common "owner/repo" case.  A
 * broad or ambiguous mention returns null and is resolved by a card instead.
 */
export function inferRepositoryTarget(
  targets: FeishuRepositoryTarget[],
  prompt: string
): FeishuRepositoryTarget | null {
  const normalized = prompt.toLowerCase();
  const matches = targets.filter((target) => normalized.includes(target.fullName.toLowerCase()));
  return matches.length === 1 ? matches[0]! : null;
}
