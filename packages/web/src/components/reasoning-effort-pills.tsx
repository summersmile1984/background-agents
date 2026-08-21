import {
  MODEL_REASONING_CONFIG,
  type ValidModel,
  type ReasoningEffort,
} from "@open-inspect/shared/models";
import type { RuntimeEffortOption } from "@open-inspect/shared/types/runtime-launch";

interface ReasoningEffortPillsProps {
  selectedModel: string;
  reasoningEffort: string | undefined;
  onSelect: (effort: string) => void;
  disabled: boolean;
  options?: RuntimeEffortOption[];
}

export function ReasoningEffortPills({
  selectedModel,
  reasoningEffort,
  onSelect,
  disabled,
  options,
}: ReasoningEffortPillsProps) {
  const config = MODEL_REASONING_CONFIG[selectedModel as ValidModel];
  const efforts = options?.map((option) => option.value) ?? config?.efforts ?? [];
  const defaultEffort = options?.find((option) => option.isDefault)?.value ?? config?.default;
  if (efforts.length === 0) return null;

  // If effort is not in the list (e.g. model just changed), -1 wraps to index 0 on cycle
  const currentIndex = reasoningEffort ? efforts.indexOf(reasoningEffort as ReasoningEffort) : -1;
  const handleCycle = () => {
    const nextIndex = (currentIndex + 1) % efforts.length;
    onSelect(efforts[nextIndex]);
  };

  return (
    <button
      type="button"
      onClick={handleCycle}
      disabled={disabled}
      className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground transition disabled:opacity-50 disabled:cursor-not-allowed"
      aria-label={`Reasoning: ${reasoningEffort ?? defaultEffort ?? "model default"} (click to cycle)`}
      title={`Reasoning: ${reasoningEffort ?? defaultEffort ?? "model default"} (click to cycle)`}
    >
      {reasoningEffort ?? defaultEffort ?? "model default"}
    </button>
  );
}
