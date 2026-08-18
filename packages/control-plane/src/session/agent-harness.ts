import {
  DEFAULT_AGENT_HARNESS,
  agentHarnessSchema,
  type AgentHarness,
} from "@open-inspect/shared/types/agent-harness";
import type { EnvironmentStore } from "../db/environments";

/** Resolve once at session creation so a later default change cannot mutate a running session. */
export async function resolveAgentHarness(options: {
  requested?: AgentHarness;
  environmentId?: string | null;
  environmentStore: EnvironmentStore;
  deploymentDefault?: string;
}): Promise<AgentHarness> {
  if (options.requested) return options.requested;

  if (options.environmentId) {
    const environment = await options.environmentStore.getById(options.environmentId);
    if (environment?.default_agent_harness) return environment.default_agent_harness;
  }

  const deploymentDefault = agentHarnessSchema.safeParse(options.deploymentDefault);
  return deploymentDefault.success ? deploymentDefault.data : DEFAULT_AGENT_HARNESS;
}
