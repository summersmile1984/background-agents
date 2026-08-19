import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT, DELETE } = settingsProxy<Record<string, never>>(
  () => "/agent-runtime/host-relay/deepseek-key",
  "Host DeepSeek credential"
);
