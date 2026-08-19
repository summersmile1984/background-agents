import { settingsProxy } from "@/lib/settings-proxy";

export const { GET } = settingsProxy<Record<string, never>>(
  () => "/agent-runtime/readiness",
  "agent runtime readiness"
);
