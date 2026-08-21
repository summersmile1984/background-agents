import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy(() => "/agent-runtime/resolve-draft", "runtime launch draft");
