import { controlPlaneReposResponseSchema } from "@open-inspect/shared/types/repository-catalog";
import type { z } from "zod";
import { signedControlPlaneFetch, type ControlPlaneEnv } from "./internal-auth";

const CATALOG_FETCH_TIMEOUT_MS = 20_000;
// A cold Gitea catalog with more than one page may complete just after the
// control plane returns its bounded partial response. Give that background
// refresh time to populate KV before asking for only the missing connection.
const CATALOG_REFRESH_RETRY_DELAY_MS = 3_000;

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

function waitForCatalogRefresh(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, CATALOG_REFRESH_RETRY_DELAY_MS));
}

/**
 * Loads the target catalog without silently hiding a slow SCM connection.
 *
 * The control plane intentionally returns a partial catalog when a cold
 * provider exceeds its response budget, while continuing the refresh in the
 * background. We retry just the omitted connection after a short bounded
 * delay. If it remains unavailable, it is still returned to the picker with
 * a clear refreshing state instead of being mistaken for an absent provider.
 */
export async function listRepositoryCatalog(
  env: ControlPlaneEnv,
  traceId?: string
): Promise<FeishuRepositoryCatalog> {
  const initial = await fetchRepositoryCatalog(env, traceId);
  if (!initial) return { targets: [], connections: [] };

  const catalogs = [initial];
  const unavailable = new Set(initial.connectionErrors.map((entry) => entry.connectionId));
  if (unavailable.size > 0) {
    await waitForCatalogRefresh();
    const retried = await Promise.all(
      [...unavailable].map(async (connectionId) => ({
        connectionId,
        catalog: await fetchRepositoryCatalog(env, traceId, connectionId),
      }))
    );
    for (const result of retried) {
      if (!result.catalog || result.catalog.connectionErrors.length > 0) continue;
      catalogs.push(result.catalog);
      unavailable.delete(result.connectionId);
    }
  }

  const targets = uniqueTargets(catalogs.flatMap(toTargets));
  const configuredConnections = new Map(
    catalogs
      .flatMap((catalog) => catalog.connections)
      .map((connection) => [connection.id, connection])
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
