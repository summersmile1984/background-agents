import { settingsProxy } from "@/lib/settings-proxy";

export const { PUT, DELETE } = settingsProxy<{ kind: string }>(
  ({ kind }) => `/agent-runtime/credentials/${encodeURIComponent(kind)}`,
  "harness credential"
);
