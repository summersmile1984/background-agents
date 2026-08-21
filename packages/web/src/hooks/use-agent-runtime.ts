import useSWR from "swr";
import type {
  AgentRuntimeReadinessResponse,
  HarnessCredentialKind,
} from "@open-inspect/shared/types/agent-runtime";
import type {
  RuntimeConfigFragment,
  RuntimeConfigurationRecord,
  RuntimeHarnessOption,
} from "@open-inspect/shared/types/runtime-launch";
import { browserApiFetch } from "@/lib/browser-api-fetch";

const AGENT_RUNTIME_READINESS_KEY = "/api/agent-runtime/readiness";

export interface AgentRuntimeReadinessView extends AgentRuntimeReadinessResponse {
  canManage: boolean;
  capabilityCatalogVersion?: string;
  catalog?: RuntimeHarnessOption[];
}

export function useAgentRuntimeReadiness() {
  const { data, error, isLoading, mutate } = useSWR<AgentRuntimeReadinessView>(
    AGENT_RUNTIME_READINESS_KEY,
    { refreshInterval: 60_000 }
  );
  return { data, error, loading: isLoading, refresh: mutate };
}

export function useUserRuntimeConfiguration() {
  const key = "/api/agent-runtime/configurations/user";
  const { data, error, isLoading, mutate } = useSWR<{
    configuration: RuntimeConfigurationRecord | null;
  }>(key);
  return { data, error, loading: isLoading, refresh: mutate };
}

export function updateUserRuntimeConfiguration(config: RuntimeConfigFragment): Promise<Response> {
  return browserApiFetch("/api/agent-runtime/configurations/user", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
}

export async function updateHarnessCredential(input: {
  kind: HarnessCredentialKind;
  value: string;
  expiresAt?: string | null;
}): Promise<Response> {
  return browserApiFetch(`/api/agent-runtime/credentials/${encodeURIComponent(input.kind)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: input.value, expiresAt: input.expiresAt }),
  });
}

export async function deleteHarnessCredential(kind: HarnessCredentialKind): Promise<Response> {
  return browserApiFetch(`/api/agent-runtime/credentials/${encodeURIComponent(kind)}`, {
    method: "DELETE",
  });
}
