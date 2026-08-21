"use client";

import type {
  ResolvedRuntimeValue,
  RuntimeHarnessOption,
} from "@open-inspect/shared/types/runtime-launch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";

export function RuntimeSettingsPopover({
  harness,
  effective,
  values,
  onChange,
  disabled = false,
}: {
  harness?: RuntimeHarnessOption;
  effective?: Record<string, ResolvedRuntimeValue<unknown>>;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  if (!harness) return null;
  const editable = harness.settings.filter((setting) => setting.visibility === "user");
  const enforced = harness.settings.filter((setting) => setting.visibility !== "user");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="text-xs text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`${harness.displayName} runtime settings`}
        >
          Settings
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 space-y-4">
        <div>
          <div className="text-sm font-medium">{harness.displayName} settings</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Schema {harness.settingsSchemaVersion} · locked when the session starts
          </div>
        </div>
        {editable.map((setting) => {
          const resolved = effective?.[setting.key];
          const value = values[setting.key] ?? resolved?.value ?? setting.defaultValue;
          return (
            <label key={setting.key} className="block space-y-1.5">
              <span className="text-xs font-medium">{setting.label}</span>
              {setting.type === "string" ? (
                <Textarea
                  value={typeof value === "string" ? value : ""}
                  maxLength={
                    typeof setting.constraints?.maxLength === "number"
                      ? setting.constraints.maxLength
                      : undefined
                  }
                  rows={4}
                  onChange={(event) => {
                    const next = { ...values };
                    if (event.target.value) next[setting.key] = event.target.value;
                    else delete next[setting.key];
                    onChange(next);
                  }}
                />
              ) : null}
              <span className="block text-[11px] text-muted-foreground">
                {setting.description}
                {resolved ? ` · ${resolved.inherited ? "inherited" : "session override"}` : ""}
              </span>
            </label>
          );
        })}
        {editable.length === 0 && (
          <p className="text-xs text-muted-foreground">
            This harness has no user-overridable start settings.
          </p>
        )}
        {enforced.length > 0 && (
          <div className="space-y-2 border-t border-border-muted pt-3">
            <div className="text-xs font-medium">Enforced platform policy</div>
            {enforced.map((setting) => (
              <div key={setting.key} className="flex items-start justify-between gap-3 text-xs">
                <span className="text-muted-foreground">{setting.label}</span>
                <span className="max-w-[9rem] text-right font-mono text-foreground">
                  {String(effective?.[setting.key]?.value ?? setting.defaultValue)}
                </span>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
