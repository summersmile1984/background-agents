"use client";

import type { AgentHarness } from "@open-inspect/shared/types/agent-harness";
import { Combobox } from "@/components/ui/combobox";

const INHERIT_VALUE = "__default__";

const HARNESS_OPTIONS: Array<{
  value: AgentHarness;
  label: string;
  description: string;
}> = [
  {
    value: "opencode",
    label: "OpenCode",
    description: "Default upstream-compatible harness",
  },
  {
    value: "codex",
    label: "Codex",
    description: "Native Codex app-server with subscription login support",
  },
  {
    value: "claude",
    label: "Claude Code",
    description: "Claude Agent SDK with setup-token session resume",
  },
  {
    value: "deepseek",
    label: "DeepSeek Harness",
    description: "Native CodeWhale app-server; requires DEEPSEEK_API_KEY",
  },
];

export function getAgentHarnessLabel(value: AgentHarness): string {
  return HARNESS_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function AgentHarnessSelector({
  value,
  onChange,
  inheritLabel = "Default harness",
  showPrefix = false,
  disabled = false,
}: {
  value: AgentHarness | null | undefined;
  onChange: (value: AgentHarness | null) => void;
  inheritLabel?: string;
  showPrefix?: boolean;
  disabled?: boolean;
}) {
  return (
    <Combobox
      value={value ?? INHERIT_VALUE}
      onChange={(nextValue) =>
        onChange(nextValue === INHERIT_VALUE ? null : (nextValue as AgentHarness))
      }
      items={[
        {
          value: INHERIT_VALUE,
          label: inheritLabel,
          description: "Resolve from the environment or deployment default",
        },
        ...HARNESS_OPTIONS,
      ]}
      direction="up"
      dropdownWidth="w-64"
      disabled={disabled}
      triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
    >
      {showPrefix && <span className="shrink-0 text-xs">Harness:&nbsp;</span>}
      <span className="truncate">{value ? getAgentHarnessLabel(value) : inheritLabel}</span>
    </Combobox>
  );
}

export function SessionAgentHarness({ value }: { value: AgentHarness }) {
  const label = getAgentHarnessLabel(value);

  return (
    <span
      data-testid="session-agent-harness"
      className="flex max-w-full items-center gap-1 text-sm text-muted-foreground"
      title="The harness is fixed when this session is created. Start a new session to change it."
      aria-label={`Harness: ${label}; locked for this session`}
    >
      <span className="shrink-0 text-xs">Harness:</span>
      <span className="truncate font-medium text-foreground">{label}</span>
      <span className="shrink-0 text-xs">· locked</span>
    </span>
  );
}
