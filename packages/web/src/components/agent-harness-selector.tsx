"use client";

import type { AgentHarness } from "@open-inspect/shared/types/agent-harness";
import type { RuntimeHarnessOption } from "@open-inspect/shared/types/runtime-launch";
import { Combobox } from "@/components/ui/combobox";
import { useAgentRuntimeReadiness } from "@/hooks/use-agent-runtime";

const INHERIT_VALUE = "__default__";

const HARNESS_OPTIONS: Array<{
  value: AgentHarness;
  label: string;
  description: string;
}> = [
  {
    value: "opencode",
    label: "OpenCode",
    description: "Upstream-compatible OpenCode harness",
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
    description: "Native CodeWhale app-server via the Host model relay",
  },
];

export function getAgentHarnessLabel(value: AgentHarness): string {
  return HARNESS_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function AgentHarnessSelector({
  value,
  onChange,
  inheritLabel,
  allowInherit = true,
  showPrefix = false,
  disabled = false,
  runtimeOptions,
}: {
  value: AgentHarness | null | undefined;
  onChange: (value: AgentHarness | null) => void;
  inheritLabel?: string;
  allowInherit?: boolean;
  showPrefix?: boolean;
  disabled?: boolean;
  /** Target-aware options from the control-plane runtime resolver. */
  runtimeOptions?: RuntimeHarnessOption[];
}) {
  const { data } = useAgentRuntimeReadiness();
  const resolvedInheritLabel =
    inheritLabel ??
    (data
      ? `Deployment default (${getAgentHarnessLabel(data.preferences.defaultAgentHarness)})`
      : "Deployment default");
  const availability = new Map(data?.harnesses.map((harness) => [harness.harness, harness]) ?? []);
  const targetAvailability = new Map(
    runtimeOptions?.map((option) => [option.harness, option]) ?? []
  );
  return (
    <Combobox
      value={value ?? INHERIT_VALUE}
      onChange={(nextValue) =>
        onChange(nextValue === INHERIT_VALUE ? null : (nextValue as AgentHarness))
      }
      items={[
        ...(allowInherit
          ? [
              {
                value: INHERIT_VALUE,
                label: resolvedInheritLabel,
                description: "Resolve from the environment or deployment setting",
              },
            ]
          : []),
        ...HARNESS_OPTIONS.map((option) => {
          const targetOption = targetAvailability.get(option.value);
          const readiness = availability.get(option.value);
          const available = targetOption
            ? targetOption.ready
            : !readiness ||
              (readiness.enabled &&
                readiness.runtimeAvailable &&
                readiness.routes.some((route) => route.ready));
          const partiallyReady =
            available &&
            (targetOption
              ? targetOption.routes.some((route) => !route.ready)
              : readiness?.routes.some((route) => !route.ready));
          return {
            ...option,
            disabled: !available,
            description: available
              ? partiallyReady
                ? `${option.description} · Some providers need setup`
                : option.description
              : `${option.description} · ${targetOption?.disabledReason ?? "Needs setup in Settings → Harnesses"}`,
          };
        }),
      ]}
      direction="up"
      dropdownWidth="w-64"
      disabled={disabled}
      triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
    >
      {showPrefix && <span className="shrink-0 text-xs">Harness:&nbsp;</span>}
      <span className="truncate">{value ? getAgentHarnessLabel(value) : resolvedInheritLabel}</span>
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
