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
    label: "DeepSeek (CodeWhale)",
    description: "Native CodeWhale app-server; requires DEEPSEEK_API_KEY",
  },
];

export function AgentHarnessSelector({
  value,
  onChange,
  inheritLabel = "Default harness",
  disabled = false,
}: {
  value: AgentHarness | null | undefined;
  onChange: (value: AgentHarness | null) => void;
  inheritLabel?: string;
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
      <span className="truncate">
        {value ? HARNESS_OPTIONS.find((option) => option.value === value)?.label : inheritLabel}
      </span>
    </Combobox>
  );
}
