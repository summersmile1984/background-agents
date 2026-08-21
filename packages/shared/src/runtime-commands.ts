import type { AgentHarness } from "./types/agent-harness";
import type {
  RuntimeCommandContext,
  RuntimeCommandDefinition,
  RuntimeCommandOption,
} from "./types/runtime-launch";

/** Product-owned command catalog shared by every client surface. */
export const RUNTIME_COMMANDS: readonly RuntimeCommandDefinition[] = [
  {
    id: "product.help",
    slashName: "help",
    title: "Help",
    description: "Show commands available for this runtime.",
    group: "session",
    owner: "product",
    harnesses: "all",
    contexts: ["draft", "idle-session", "running-session"],
    execution: "control-plane",
    arguments: [],
    mutates: [],
  },
  {
    id: "product.stop",
    slashName: "stop",
    title: "Stop current turn",
    description: "Interrupt the active harness turn.",
    group: "session",
    owner: "product",
    harnesses: "all",
    contexts: ["running-session"],
    execution: "control-plane",
    arguments: [],
    mutates: ["session"],
  },
  {
    id: "product.status",
    slashName: "status",
    title: "Runtime status",
    description: "Show target, sandbox, harness, route, model, and effort.",
    group: "session",
    owner: "product",
    harnesses: "all",
    contexts: ["idle-session", "running-session"],
    execution: "control-plane",
    arguments: [],
    mutates: [],
  },
  {
    id: "product.model",
    slashName: "model",
    title: "Choose model",
    description: "Open model selection when live switching is supported.",
    group: "runtime",
    owner: "product",
    harnesses: "all",
    contexts: ["draft", "idle-session"],
    execution: "control-plane",
    arguments: [],
    mutates: ["model"],
  },
  {
    id: "product.effort",
    slashName: "effort",
    title: "Choose effort",
    description: "Open effort selection when live switching is supported.",
    group: "runtime",
    owner: "product",
    harnesses: "all",
    contexts: ["draft", "idle-session"],
    execution: "control-plane",
    arguments: [],
    mutates: ["effort"],
  },
  {
    id: "product.new",
    slashName: "new",
    title: "New session",
    description: "Start a draft that inherits this target and eligible runtime settings.",
    group: "session",
    owner: "product",
    harnesses: "all",
    contexts: ["draft", "idle-session", "running-session"],
    execution: "control-plane",
    arguments: [],
    mutates: ["session"],
  },
  {
    id: "product.compact",
    slashName: "compact",
    title: "Compact context",
    description: "Compact the active harness context when a tested adapter is available.",
    group: "harness",
    owner: "product",
    harnesses: "all",
    contexts: [],
    execution: "driver",
    arguments: [],
    mutates: ["context"],
  },
  {
    id: "product.review",
    slashName: "review",
    title: "Review changes",
    description: "Run the managed code-review workflow.",
    group: "session",
    owner: "product",
    harnesses: "all",
    contexts: ["idle-session"],
    execution: "prompt-transform",
    arguments: [],
    mutates: ["session"],
  },
] as const;

export function buildRuntimeCommandOptions(input: {
  context: RuntimeCommandContext;
  harness: AgentHarness;
  liveMutation?: { model: boolean; effort: boolean; settings: string[] };
}): RuntimeCommandOption[] {
  return RUNTIME_COMMANDS.map((definition) => {
    let unavailableReason: string | undefined;
    if (!definition.contexts.includes(input.context)) {
      unavailableReason =
        definition.id === "product.compact"
          ? "No tested compaction adapter is available for this harness version"
          : input.context === "running-session"
            ? "Unavailable while a turn is running"
            : "Unavailable in the current session state";
    } else if (definition.harnesses !== "all" && !definition.harnesses.includes(input.harness)) {
      unavailableReason = `Unavailable for ${input.harness}`;
    } else if (
      input.context !== "draft" &&
      definition.id === "product.model" &&
      !input.liveMutation?.model
    ) {
      unavailableReason = "This session's pinned harness does not support live model changes";
    } else if (
      input.context !== "draft" &&
      definition.id === "product.effort" &&
      !input.liveMutation?.effort
    ) {
      unavailableReason = "This session's pinned harness does not support live effort changes";
    }
    return {
      ...definition,
      available: unavailableReason === undefined,
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  });
}
