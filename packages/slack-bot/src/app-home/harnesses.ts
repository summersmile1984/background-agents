import { agentHarnessSchema, type AgentHarness } from "@open-inspect/shared/types/agent-harness";
import { signedControlPlaneFetch } from "../internal-auth";
import type { Env } from "../types";

const LABELS: Record<AgentHarness, string> = {
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude Code",
  deepseek: "DeepSeek Harness",
};

export interface SlackHarnessOption {
  label: string;
  value: AgentHarness;
}

export async function getAvailableHarnesses(env: Env): Promise<SlackHarnessOption[]> {
  try {
    const response = await signedControlPlaneFetch(env, {
      method: "GET",
      url: "https://internal/agent-runtime/catalog",
    });
    if (!response.ok) return [];
    const raw = (await response.json()) as { catalog?: unknown };
    if (!Array.isArray(raw.catalog)) return [];
    return raw.catalog.flatMap((entry): SlackHarnessOption[] => {
      if (!entry || typeof entry !== "object") return [];
      const candidate = entry as { harness?: unknown; ready?: unknown; displayName?: unknown };
      const parsed = agentHarnessSchema.safeParse(candidate.harness);
      if (!parsed.success || candidate.ready !== true) return [];
      return [
        {
          value: parsed.data,
          label:
            typeof candidate.displayName === "string" ? candidate.displayName : LABELS[parsed.data],
        },
      ];
    });
  } catch {
    return [];
  }
}
