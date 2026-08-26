import { controlPlaneReposResponseSchema } from "@open-inspect/shared/types/repository-catalog";
import type { z } from "zod";
import { signedControlPlaneFetch, type ControlPlaneEnv } from "./internal-auth";

const CATALOG_FETCH_TIMEOUT_MS = 20_000;

export interface FeishuRepositoryTarget {
  repositoryKey: string;
  fullName: string;
  displayName: string;
  provider: string;
  connectionId: string;
  connectionLabel: string;
  defaultBranch: string;
}

export interface FeishuRepositoryConnection {
  id: string;
  label: string;
  provider: string;
  repositoryCount: number;
  catalogStatus: "available" | "refreshing";
}

export interface FeishuRepositoryCatalog {
  targets: FeishuRepositoryTarget[];
  connections: FeishuRepositoryConnection[];
}

type ControlPlaneRepositoryCatalog = z.infer<typeof controlPlaneReposResponseSchema>;

function toTarget(
  repo: z.infer<typeof controlPlaneReposResponseSchema>["repos"][number]
): FeishuRepositoryTarget | null {
  if (!repo.repositoryKey || !repo.connectionId) return null;
  return {
    repositoryKey: repo.repositoryKey,
    fullName: `${repo.owner}/${repo.name}`,
    displayName: repo.name,
    provider: repo.provider ?? "source control",
    connectionId: repo.connectionId,
    connectionLabel: repo.connection?.displayName ?? repo.provider ?? "Source control",
    defaultBranch: repo.defaultBranch,
  };
}

async function fetchRepositoryCatalog(
  env: ControlPlaneEnv,
  traceId: string | undefined,
  connectionId?: string
): Promise<ControlPlaneRepositoryCatalog | null> {
  const url = new URL("https://internal/repos");
  if (connectionId) url.searchParams.set("connectionId", connectionId);
  try {
    const response = await signedControlPlaneFetch(
      env,
      { method: "GET", url: url.toString(), traceId },
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
      }
    );
    if (!response.ok) return null;
    const parsed = controlPlaneReposResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toTargets(catalog: ControlPlaneRepositoryCatalog): FeishuRepositoryTarget[] {
  return catalog.repos.flatMap((repo) => {
    const target = toTarget(repo);
    return target ? [target] : [];
  });
}

function uniqueTargets(targets: FeishuRepositoryTarget[]): FeishuRepositoryTarget[] {
  return [...new Map(targets.map((target) => [target.repositoryKey, target])).values()];
}

/**
 * Loads the target catalog without silently hiding a slow SCM connection.
 *
 * The control plane intentionally returns a partial catalog when a cold
 * provider exceeds its response budget and continues that refresh in the
 * background. Do not synchronously retry here: the control plane can spend 16
 * seconds on each attempt, so a second attempt would outlive the Feishu
 * event's background execution window. Return the partial catalog immediately
 * and mark omitted connections as refreshing; the next card interaction will
 * read the cache populated by the control plane's background refresh.
 */
export async function listRepositoryCatalog(
  env: ControlPlaneEnv,
  traceId?: string
): Promise<FeishuRepositoryCatalog> {
  const initial = await fetchRepositoryCatalog(env, traceId);
  if (!initial) return { targets: [], connections: [] };

  const unavailable = new Set(initial.connectionErrors.map((entry) => entry.connectionId));
  const targets = uniqueTargets(toTargets(initial));
  const configuredConnections = new Map(
    initial.connections.map((connection) => [connection.id, connection])
  );
  return {
    targets,
    connections: listRepositoryConnections(targets, configuredConnections, unavailable),
  };
}

export async function listRepositoryTargets(
  env: ControlPlaneEnv,
  traceId?: string
): Promise<FeishuRepositoryTarget[]> {
  return (await listRepositoryCatalog(env, traceId)).targets;
}

export function findRepositoryTarget(
  targets: FeishuRepositoryTarget[],
  repositoryKey: string
): FeishuRepositoryTarget | null {
  return targets.find((target) => target.repositoryKey === repositoryKey) ?? null;
}

export function listRepositoryConnections(
  targets: FeishuRepositoryTarget[],
  configuredConnections: ReadonlyMap<
    string,
    z.infer<typeof controlPlaneReposResponseSchema>["connections"][number]
  > = new Map(),
  unavailableConnectionIds: ReadonlySet<string> = new Set()
): FeishuRepositoryConnection[] {
  const grouped = new Map<string, FeishuRepositoryConnection>();
  for (const connection of configuredConnections.values()) {
    grouped.set(connection.id, {
      id: connection.id,
      label: connection.displayName,
      provider: connection.provider,
      repositoryCount: 0,
      catalogStatus: unavailableConnectionIds.has(connection.id) ? "refreshing" : "available",
    });
  }
  for (const target of targets) {
    const existing = grouped.get(target.connectionId);
    if (existing) {
      existing.repositoryCount += 1;
      continue;
    }
    grouped.set(target.connectionId, {
      id: target.connectionId,
      label: target.connectionLabel,
      provider: target.provider,
      repositoryCount: 1,
      catalogStatus: unavailableConnectionIds.has(target.connectionId) ? "refreshing" : "available",
    });
  }
  return [...grouped.values()].sort(
    (left, right) =>
      left.label.localeCompare(right.label, "zh-CN") || left.id.localeCompare(right.id)
  );
}

export function findRepositoryConnection(
  targets: FeishuRepositoryTarget[],
  connectionId: string,
  configuredConnections?: ReadonlyMap<
    string,
    z.infer<typeof controlPlaneReposResponseSchema>["connections"][number]
  >,
  unavailableConnectionIds?: ReadonlySet<string>
): FeishuRepositoryConnection | null {
  return (
    listRepositoryConnections(targets, configuredConnections, unavailableConnectionIds).find(
      (connection) => connection.id === connectionId
    ) ?? null
  );
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
