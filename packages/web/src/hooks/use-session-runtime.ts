"use client";

import useSWR from "swr";
import type {
  RuntimeCommandOption,
  RuntimeEffortOption,
  RuntimeModelOption,
  SessionLaunchSpecV1,
} from "@open-inspect/shared/types/runtime-launch";

export interface SessionRuntimeView {
  sessionId: string;
  launchSpec: SessionLaunchSpecV1 | null;
  legacy: boolean;
  liveMutation: { model: boolean; effort: boolean; settings: string[] };
  liveOptions: { models: RuntimeModelOption[]; efforts: RuntimeEffortOption[] };
  commands: RuntimeCommandOption[];
}

export function useSessionRuntime(sessionId: string) {
  return useSWR<SessionRuntimeView>(`/api/sessions/${encodeURIComponent(sessionId)}/runtime`, {
    revalidateOnFocus: false,
  });
}
