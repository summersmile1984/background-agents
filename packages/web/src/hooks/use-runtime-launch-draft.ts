import useSWR from "swr";
import type {
  ResolveRuntimeLaunchDraftRequest,
  ResolveRuntimeLaunchDraftResponse,
} from "@open-inspect/shared/types/runtime-launch";
import { browserApiFetch } from "@/lib/browser-api-fetch";

const RUNTIME_DRAFT_ENDPOINT = "/api/agent-runtime/resolve-draft" as const;

export function useRuntimeLaunchDraft(request: ResolveRuntimeLaunchDraftRequest | null) {
  const serialized = request ? JSON.stringify(request) : null;
  const { data, error, isLoading, isValidating, mutate } =
    useSWR<ResolveRuntimeLaunchDraftResponse>(
      serialized ? [RUNTIME_DRAFT_ENDPOINT, serialized] : null,
      async ([endpoint, body]: [typeof RUNTIME_DRAFT_ENDPOINT, string]) => {
        const response = await browserApiFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: unknown;
          } | null;
          throw new Error(
            typeof payload?.error === "string" ? payload.error : "Failed to resolve runtime options"
          );
        }
        return response.json() as Promise<ResolveRuntimeLaunchDraftResponse>;
      },
      { keepPreviousData: false }
    );
  return { data, error, loading: isLoading, validating: isValidating, refresh: mutate };
}
