import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy<Record<string, never>>(
  () => "/agent-runtime/host-relay/deepseek-test",
  "Host DeepSeek provider test"
);
