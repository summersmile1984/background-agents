import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT } = settingsProxy<Record<string, never>>(
  () => "/agent-runtime/preferences",
  "agent runtime preferences"
);
