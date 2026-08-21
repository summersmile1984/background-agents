"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import type {
  PersistedRuntimeConfigurationScope,
  RuntimeConfigFragment,
  RuntimeConfigurationRecord,
  RuntimeSettingDefinition,
} from "@open-inspect/shared/types/runtime-launch";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import type { BrowserApiPath } from "@/lib/browser-api-fetch";
import { useAgentRuntimeReadiness } from "@/hooks/use-agent-runtime";
import { useRuntimeLaunchDraft } from "@/hooks/use-runtime-launch-draft";

type EditableScope = Exclude<PersistedRuntimeConfigurationScope, "user">;

function apiPath(scope: EditableScope, scopeId: string): BrowserApiPath {
  return `/api/agent-runtime/configurations/${scope}/${encodeURIComponent(scopeId)}`;
}

function errorMessage(value: unknown, fallback: string): string {
  return value && typeof value === "object" && "error" in value && typeof value.error === "string"
    ? value.error
    : fallback;
}

function settingValue(
  setting: RuntimeSettingDefinition,
  value: unknown,
  onChange: (value: unknown) => void
) {
  if (setting.type === "boolean") {
    const isEnabled = value === true;
    return (
      <div className="mt-1.5 flex items-center gap-2">
        <Switch checked={isEnabled} onCheckedChange={onChange} />
        <span className="text-xs text-muted-foreground">{isEnabled ? "Enabled" : "Disabled"}</span>
      </div>
    );
  }
  if (setting.type === "integer") {
    const min = typeof setting.constraints?.min === "number" ? setting.constraints.min : undefined;
    const max = typeof setting.constraints?.max === "number" ? setting.constraints.max : undefined;
    return (
      <Input
        className="mt-1.5"
        type="number"
        value={typeof value === "number" ? value : ""}
        min={min}
        max={max}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : Number(event.target.value))
        }
      />
    );
  }
  if (setting.type === "enum" && setting.enumOptions?.length) {
    return (
      <Combobox
        value={typeof value === "string" ? value : "__inherit__"}
        onChange={(next) => onChange(next === "__inherit__" ? undefined : next)}
        items={[
          { value: "__inherit__", label: "Inherited value" },
          ...setting.enumOptions.map((entry) => ({ value: entry.value, label: entry.label })),
        ]}
        dropdownWidth="w-full"
        triggerClassName="mt-1.5 flex w-full items-center justify-between border border-border bg-input px-3 py-2 text-sm"
      >
        <span>{typeof value === "string" ? value : "Inherited value"}</span>
        <span aria-hidden="true">⌄</span>
      </Combobox>
    );
  }
  if (setting.type === "string-list") {
    return (
      <Textarea
        className="mt-1.5 font-mono text-xs"
        rows={4}
        value={
          Array.isArray(value) ? value.filter((entry) => typeof entry === "string").join("\n") : ""
        }
        onChange={(event) => {
          const entries = event.target.value
            .split("\n")
            .map((entry) => entry.trim())
            .filter(Boolean);
          onChange(entries.length ? entries : undefined);
        }}
      />
    );
  }
  return (
    <Textarea
      className="mt-1.5"
      rows={3}
      value={typeof value === "string" ? value : ""}
      maxLength={
        typeof setting.constraints?.maxLength === "number"
          ? setting.constraints.maxLength
          : undefined
      }
      onChange={(event) => onChange(event.target.value || undefined)}
    />
  );
}

export function RuntimeConfigurationEditor({
  scope,
  scopeId,
  title = "Runtime defaults",
  description = "Choose a Harness, exact ready model route, effort, and typed runtime settings.",
}: {
  scope: EditableScope;
  scopeId: string;
  title?: string;
  description?: string;
}) {
  const key = apiPath(scope, scopeId);
  const { data, error, isLoading, mutate } = useSWR<{
    configuration: RuntimeConfigurationRecord | null;
  }>(key);
  const { data: readiness, loading: catalogLoading } = useAgentRuntimeReadiness();
  const [draft, setDraft] = useState<RuntimeConfigFragment>({});
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const targetRequest =
    scope === "repository"
      ? { kind: "repository" as const, repositoryKey: scopeId }
      : scope === "environment"
        ? { kind: "environment" as const, environmentId: scopeId }
        : null;
  const targetDraft = useRuntimeLaunchDraft(
    targetRequest ? { target: targetRequest, runtime: draft } : null
  );

  useEffect(() => {
    if (!data || dirty) return;
    const revision = data.configuration?.updatedAt ?? 0;
    if (revision === loadedRevision) return;
    setDraft(data.configuration?.config ?? {});
    setLoadedRevision(revision);
  }, [data, dirty, loadedRevision]);

  const catalog = targetDraft.data?.options.harnesses ?? readiness?.catalog ?? [];
  const selectedHarness = draft.harness && draft.harness !== "inherit" ? draft.harness : undefined;
  const readyHarnesses = catalog.filter((entry) => entry.ready);
  const selectedHarnessOption = catalog.find((entry) => entry.harness === selectedHarness);
  const modelOptions = useMemo(
    () =>
      Array.from(
        new Map(
          readyHarnesses
            .filter((entry) => !selectedHarness || entry.harness === selectedHarness)
            .flatMap((entry) => entry.routes.flatMap((route) => route.models))
            .filter((model) => model.ready)
            .map((model) => [model.model, model] as const)
        ).values()
      ),
    [readyHarnesses, selectedHarness]
  );
  const selectedModel = modelOptions.find((entry) => entry.model === draft.model);
  const settings = (selectedHarnessOption?.settings ?? []).filter(
    (setting) => setting.visibility === "user" && setting.allowedScopes.includes(scope)
  );

  function update(patch: Partial<RuntimeConfigFragment>) {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const response = await browserApiFetch(key, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: draft }),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(result, "Failed to save runtime defaults"));
      setDirty(false);
      setLoadedRevision(null);
      await mutate();
      toast.success(`${title} saved.`);
    } catch (saveError) {
      toast.error(
        saveError instanceof Error ? saveError.message : "Failed to save runtime defaults"
      );
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!window.confirm(`Reset ${title.toLowerCase()} to inherited values?`)) return;
    setSaving(true);
    try {
      const response = await browserApiFetch(key, { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        const result: unknown = await response.json();
        throw new Error(errorMessage(result, "Failed to reset runtime defaults"));
      }
      setDraft({});
      setDirty(false);
      setLoadedRevision(null);
      await mutate({ configuration: null }, { revalidate: true });
      toast.success(`${title} reset.`);
    } catch (resetError) {
      toast.error(
        resetError instanceof Error ? resetError.message : "Failed to reset runtime defaults"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border border-border p-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      {error ? (
        <p className="mt-3 text-xs text-destructive">Unable to load runtime defaults.</p>
      ) : null}
      {targetDraft.data && !targetDraft.data.launchable ? (
        <div className="mt-3 border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground">
          {targetDraft.data.issues.find((issue) => issue.severity === "error")?.message ??
            "This target-specific configuration is not currently launchable."}
        </div>
      ) : null}
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div>
          <Label>Harness</Label>
          <Combobox
            value={draft.harness ?? "inherit"}
            disabled={isLoading || catalogLoading}
            onChange={(value) =>
              update({
                harness: value as RuntimeConfigFragment["harness"],
                routeId: undefined,
                model: "inherit",
                effort: "inherit",
                settings: undefined,
              })
            }
            items={[
              { value: "inherit", label: "Inherited Harness" },
              ...readyHarnesses.map((entry) => ({
                value: entry.harness,
                label: entry.displayName,
              })),
            ]}
            dropdownWidth="w-full"
            triggerClassName="mt-1.5 flex w-full items-center justify-between border border-border bg-input px-3 py-2 text-sm disabled:opacity-50"
          >
            <span>{selectedHarnessOption?.displayName ?? "Inherited Harness"}</span>
            <span aria-hidden="true">⌄</span>
          </Combobox>
        </div>
        <div>
          <Label>Model</Label>
          <Combobox
            value={draft.model ?? "inherit"}
            disabled={isLoading || catalogLoading}
            onChange={(value) => update({ model: value, effort: "inherit" })}
            items={[
              { value: "inherit", label: "Inherited model" },
              ...modelOptions.map((entry) => ({ value: entry.model, label: entry.displayName })),
            ]}
            dropdownWidth="w-full"
            triggerClassName="mt-1.5 flex w-full items-center justify-between border border-border bg-input px-3 py-2 text-sm disabled:opacity-50"
          >
            <span>{selectedModel?.displayName ?? "Inherited model"}</span>
            <span aria-hidden="true">⌄</span>
          </Combobox>
        </div>
        <div>
          <Label>Effort</Label>
          <Combobox
            value={draft.effort ?? "inherit"}
            disabled={!selectedModel}
            onChange={(value) => update({ effort: value })}
            items={[
              { value: "inherit", label: "Model default" },
              ...(selectedModel?.efforts.map((entry) => ({
                value: entry.value,
                label: entry.label,
              })) ?? []),
            ]}
            dropdownWidth="w-full"
            triggerClassName="mt-1.5 flex w-full items-center justify-between border border-border bg-input px-3 py-2 text-sm disabled:opacity-50"
          >
            <span>
              {draft.effort && draft.effort !== "inherit" ? draft.effort : "Model default"}
            </span>
            <span aria-hidden="true">⌄</span>
          </Combobox>
        </div>
      </div>
      {settings.map((setting) => (
        <div key={setting.key} className="mt-4 max-w-2xl">
          <Label>{setting.label}</Label>
          {settingValue(setting, draft.settings?.[setting.key], (value) =>
            update({ settings: { ...draft.settings, [setting.key]: value } })
          )}
          <p className="mt-1 text-xs text-muted-foreground">{setting.description}</p>
        </div>
      ))}
      <div className="mt-4 flex gap-2">
        <Button
          disabled={
            saving ||
            isLoading ||
            targetDraft.loading ||
            Boolean(targetDraft.data && !targetDraft.data.launchable) ||
            !dirty
          }
          onClick={() => void save()}
        >
          {saving ? "Saving..." : "Save runtime defaults"}
        </Button>
        {data?.configuration ? (
          <Button variant="outline" disabled={saving} onClick={() => void reset()}>
            Reset
          </Button>
        ) : null}
      </div>
    </section>
  );
}
