import { z } from "zod";

/** Coding-agent runtimes supported by the sandbox bridge. */
export const AGENT_HARNESSES = ["opencode", "codex", "claude", "deepseek"] as const;

export const agentHarnessSchema = z.enum(AGENT_HARNESSES);

export type AgentHarness = z.infer<typeof agentHarnessSchema>;

/** Existing installations remain OpenCode-first until explicitly configured. */
export const DEFAULT_AGENT_HARNESS: AgentHarness = "opencode";

export function getAgentHarnessOrDefault(value: unknown): AgentHarness {
  const parsed = agentHarnessSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_AGENT_HARNESS;
}
