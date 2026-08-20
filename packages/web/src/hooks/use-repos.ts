import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import type { SourceControlProviderName } from "@open-inspect/shared/types/source-control";

export interface Repo {
  id: number;
  repositoryKey?: string;
  connectionId?: string;
  provider?: SourceControlProviderName;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  webUrl?: string;
  cloneUrl?: string;
  connection?: {
    id: string;
    provider: SourceControlProviderName;
    displayName: string;
    baseUrl: string;
  };
}

interface ReposResponse {
  repos: Repo[];
}

export function useRepos() {
  const { data: session, status } = useAuthSession();

  const { data, isLoading, error } = useSWR<ReposResponse>(session ? "/api/repos" : null);

  return {
    repos: data?.repos ?? [],
    // The fetch is gated on the auth session, so the list is still loading
    // while the session itself resolves — don't report an authoritative [].
    loading: status === "loading" || isLoading,
    error,
  };
}
