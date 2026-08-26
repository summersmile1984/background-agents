"use client";

import { MonitorIcon } from "@/components/ui/icons";

export function VisualVerificationToggle({
  checked,
  onChange,
  disabled = false,
  available = true,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  available?: boolean;
}) {
  const unavailableMessage =
    "Enable Visual Verification in Settings → Sandbox before requesting browser checks";
  return (
    <button
      type="button"
      aria-label="Verify UI and attach screenshots"
      aria-pressed={checked}
      disabled={disabled || !available}
      onClick={() => onChange(!checked)}
      title={available ? "Verify UI and attach screenshots for this message" : unavailableMessage}
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
        checked
          ? "border-accent bg-accent/10 text-accent"
          : "border-border-muted text-muted-foreground hover:text-foreground"
      }`}
    >
      <MonitorIcon className="h-3.5 w-3.5" />
      <span>Verify UI</span>
    </button>
  );
}
