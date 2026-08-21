"use client";

import { useEffect, useMemo, useState } from "react";
import { mutate } from "swr";
import { toast } from "sonner";
import { AGENT_HARNESSES, type AgentHarness } from "@open-inspect/shared/types/agent-harness";
import type {
  HarnessCredentialKind,
  HarnessCredentialMetadata,
  HarnessProviderReadiness,
  HarnessReadiness,
} from "@open-inspect/shared/types/agent-runtime";
import type {
  RuntimeConfigFragment,
  RuntimeHarnessOption,
} from "@open-inspect/shared/types/runtime-launch";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteHarnessCredential,
  updateHarnessCredential,
  updateUserRuntimeConfiguration,
  useAgentRuntimeReadiness,
  useUserRuntimeConfiguration,
} from "@/hooks/use-agent-runtime";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { RuntimeConfigurationEditor } from "./runtime-configuration-editor";

const HARNESS_INFO: Record<AgentHarness, { name: string; description: string }> = {
  opencode: {
    name: "OpenCode",
    description: "Upstream-compatible general provider harness",
  },
  codex: {
    name: "Codex",
    description: "Native Codex app-server with subscription login support",
  },
  claude: {
    name: "Claude Code",
    description: "Claude Agent SDK with setup-token session resume",
  },
  deepseek: {
    name: "DeepSeek Harness",
    description: "Native CodeWhale app-server through the Host model relay",
  },
};

const PROVIDER_LABELS: Record<HarnessProviderReadiness["provider"], string> = {
  any: "Configured model providers",
  openai: "OpenAI / ChatGPT",
  anthropic: "Anthropic",
  deepseek: "DeepSeek relay",
};

function responseError(data: unknown, fallback: string): string {
  return data && typeof data === "object" && "error" in data && typeof data.error === "string"
    ? data.error
    : fallback;
}

function StatusDot({ ready }: { ready: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${ready ? "bg-emerald-500" : "bg-amber-500"}`}
      aria-hidden="true"
    />
  );
}

function RouteStatus({ route }: { route: HarnessProviderReadiness }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border-muted py-2 first:border-t-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm text-foreground">
          <StatusDot ready={route.ready} />
          <span>{PROVIDER_LABELS[route.provider]}</span>
        </div>
        {!route.ready && route.message ? (
          <p className="mt-1 pl-4 text-xs text-muted-foreground">{route.message}</p>
        ) : null}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {route.ready ? "Ready" : route.code.replaceAll("_", " ").toLowerCase()}
      </span>
    </div>
  );
}

function HarnessCard({
  readiness,
  enabled,
  canManage,
  onToggle,
}: {
  readiness: HarnessReadiness;
  enabled: boolean;
  canManage: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const info = HARNESS_INFO[readiness.harness];
  return (
    <section className="border border-border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{info.name}</h3>
            <span className="text-xs text-muted-foreground">
              {readiness.runtimeAvailable ? "Runtime available" : "Runtime missing"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{info.description}</p>
        </div>
        <Switch
          aria-label={`Enable ${info.name}`}
          checked={enabled}
          disabled={!canManage}
          onCheckedChange={onToggle}
        />
      </div>
      <div className="mt-3">
        {readiness.routes.map((route) => (
          <RouteStatus key={route.provider} route={route} />
        ))}
      </div>
    </section>
  );
}

function CredentialEditor({
  kind,
  title,
  description,
  metadata,
  canManage,
  multiline = false,
  allowFile = false,
  onChanged,
}: {
  kind: HarnessCredentialKind;
  title: string;
  description: string;
  metadata?: HarnessCredentialMetadata;
  canManage: boolean;
  multiline?: boolean;
  allowFile?: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [value, setValue] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!value.trim()) {
      toast.error("Enter a credential value first.");
      return;
    }
    setSaving(true);
    try {
      const response = await updateHarnessCredential({
        kind,
        value,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(data, "Failed to save credential"));
      setValue("");
      setExpiresAt("");
      await onChanged();
      toast.success(`${title} saved.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save credential");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${title}? New sessions may stop working.`)) return;
    setSaving(true);
    try {
      const response = await deleteHarnessCredential(kind);
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(data, "Failed to remove credential"));
      await onChanged();
      toast.success(`${title} removed.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove credential");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border border-border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <StatusDot ready={Boolean(metadata?.configured)} />
          {metadata?.configured ? "Configured" : "Not configured"}
        </div>
      </div>

      {metadata?.configured ? (
        <div className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
          <span>Fingerprint: {metadata.fingerprint}</span>
          <span>
            Expires:{" "}
            {metadata.expiresAt ? new Date(metadata.expiresAt).toLocaleString() : "Unknown"}
          </span>
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        <div>
          <Label htmlFor={`${kind}-value`}>New credential</Label>
          {multiline ? (
            <Textarea
              id={`${kind}-value`}
              value={value}
              disabled={!canManage || saving}
              placeholder="Paste the credential. The stored value is never returned to the browser."
              rows={5}
              className="mt-1.5 font-mono text-xs"
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <Input
              id={`${kind}-value`}
              type="password"
              value={value}
              disabled={!canManage || saving}
              placeholder="Paste token"
              className="mt-1.5"
              autoComplete="new-password"
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </div>

        {allowFile ? (
          <div>
            <Label htmlFor={`${kind}-file`}>Or load auth.json</Label>
            <Input
              id={`${kind}-file`}
              type="file"
              accept="application/json,.json"
              disabled={!canManage || saving}
              className="mt-1.5"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (file) setValue(await file.text());
              }}
            />
          </div>
        ) : null}

        <div>
          <Label htmlFor={`${kind}-expiry`}>Expiry (optional)</Label>
          <Input
            id={`${kind}-expiry`}
            type="datetime-local"
            value={expiresAt}
            disabled={!canManage || saving}
            className="mt-1.5 max-w-xs"
            onChange={(event) => setExpiresAt(event.target.value)}
          />
        </div>

        <div className="flex gap-2">
          <Button disabled={!canManage || saving || !value.trim()} onClick={save}>
            {saving ? "Saving..." : metadata?.configured ? "Replace" : "Save"}
          </Button>
          {metadata?.configured ? (
            <Button variant="outline" disabled={!canManage || saving} onClick={remove}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function PersonalRuntimeDefaults({ catalog }: { catalog: RuntimeHarnessOption[] }) {
  const { data, loading, refresh } = useUserRuntimeConfiguration();
  const [draft, setDraft] = useState<RuntimeConfigFragment>({});
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (loading || initialized) return;
    setDraft(data?.configuration?.config ?? {});
    setInitialized(true);
  }, [data?.configuration?.config, initialized, loading]);

  const harness = draft.harness && draft.harness !== "inherit" ? draft.harness : null;
  const eligibleHarnesses = catalog.filter((option) => option.ready);
  const modelOptions = Array.from(
    new Map(
      eligibleHarnesses
        .filter((option) => !harness || option.harness === harness)
        .flatMap((option) => option.routes.flatMap((route) => route.models))
        .filter((model) => model.ready)
        .map((model) => [model.model, model] as const)
    ).values()
  );
  const selectedModel =
    draft.model && draft.model !== "inherit"
      ? modelOptions.find((model) => model.model === draft.model)
      : undefined;
  const settingsHarness = harness
    ? catalog.find((option) => option.harness === harness)
    : undefined;

  async function save() {
    setSaving(true);
    try {
      const response = await updateUserRuntimeConfiguration(draft);
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(result, "Failed to save personal defaults"));
      await refresh();
      toast.success("Personal runtime defaults saved.");
    } catch (saveError) {
      toast.error(
        saveError instanceof Error ? saveError.message : "Failed to save personal defaults"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-6 border border-border p-4">
      <h3 className="text-sm font-semibold text-foreground">My runtime defaults</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Applied by the control-plane resolver after installation defaults and before repository or
        environment defaults. Credentials are never stored here.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div>
          <Label>Harness</Label>
          <Combobox
            value={draft.harness ?? "inherit"}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                harness: value as RuntimeConfigFragment["harness"],
                routeId: undefined,
                model: "inherit",
                effort: "inherit",
                settings: undefined,
              }))
            }
            items={[
              { value: "inherit", label: "Installation default" },
              ...eligibleHarnesses.map((option) => ({
                value: option.harness,
                label: option.displayName,
              })),
            ]}
            dropdownWidth="w-full"
            triggerClassName="mt-1.5 flex w-full items-center justify-between border border-border bg-input px-3 py-2 text-sm"
          >
            <span>
              {harness
                ? (catalog.find((option) => option.harness === harness)?.displayName ?? harness)
                : "Installation default"}
            </span>
            <span aria-hidden="true">⌄</span>
          </Combobox>
        </div>
        <div>
          <Label>Model</Label>
          <Combobox
            value={draft.model ?? "inherit"}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                model: value,
                effort: "inherit",
              }))
            }
            items={[
              { value: "inherit", label: "Inherited model" },
              ...modelOptions.map((model) => ({ value: model.model, label: model.displayName })),
            ]}
            dropdownWidth="w-full"
            triggerClassName="mt-1.5 flex w-full items-center justify-between border border-border bg-input px-3 py-2 text-sm"
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
            onChange={(value) => setDraft((current) => ({ ...current, effort: value }))}
            items={[
              { value: "inherit", label: "Model default" },
              ...(selectedModel?.efforts.map((effort) => ({
                value: effort.value,
                label: effort.label,
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
      {settingsHarness?.settings
        .filter(
          (setting) => setting.visibility === "user" && setting.allowedScopes.includes("user")
        )
        .map((setting) => (
          <div key={setting.key} className="mt-4 max-w-2xl">
            <Label htmlFor={`personal-${setting.key}`}>{setting.label}</Label>
            {setting.type === "string" ? (
              <Textarea
                id={`personal-${setting.key}`}
                className="mt-1.5"
                rows={3}
                value={String(draft.settings?.[setting.key] ?? "")}
                maxLength={
                  typeof setting.constraints?.maxLength === "number"
                    ? setting.constraints.maxLength
                    : undefined
                }
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    settings: { ...current.settings, [setting.key]: event.target.value },
                  }))
                }
              />
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">{setting.description}</p>
          </div>
        ))}
      <div className="mt-4">
        <Button disabled={saving || loading} onClick={() => void save()}>
          {saving ? "Saving..." : "Save my defaults"}
        </Button>
      </div>
    </section>
  );
}

export function HarnessesSettings() {
  const { data, error, loading, refresh } = useAgentRuntimeReadiness();
  const [enabledHarnesses, setEnabledHarnesses] = useState<Set<AgentHarness>>(new Set());
  const [defaultHarness, setDefaultHarness] = useState<AgentHarness>("opencode");
  const [initializedAt, setInitializedAt] = useState<number | null>(null);
  const [preferencesDirty, setPreferencesDirty] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [deepSeekKey, setDeepSeekKey] = useState("");
  const [hostAction, setHostAction] = useState<"save" | "delete" | "test" | null>(null);

  useEffect(() => {
    if (!data || initializedAt === data.checkedAt || preferencesDirty) return;
    setEnabledHarnesses(new Set(data.preferences.enabledHarnesses));
    setDefaultHarness(data.preferences.defaultAgentHarness);
    setInitializedAt(data.checkedAt);
  }, [data, initializedAt, preferencesDirty]);

  const credentials = useMemo(
    () => new Map(data?.credentials.map((credential) => [credential.kind, credential]) ?? []),
    [data?.credentials]
  );

  if (loading && !data) {
    return <div className="text-sm text-muted-foreground">Loading agent runtime settings...</div>;
  }
  if (error || !data) {
    return <div className="text-sm text-destructive">Agent runtime settings are unavailable.</div>;
  }

  function toggleHarness(harness: AgentHarness, enabled: boolean) {
    setPreferencesDirty(true);
    setEnabledHarnesses((current) => {
      const next = new Set(current);
      if (enabled) next.add(harness);
      else if (next.size > 1) next.delete(harness);
      if (!next.has(defaultHarness))
        setDefaultHarness(AGENT_HARNESSES.find((item) => next.has(item))!);
      return next;
    });
  }

  async function savePreferences() {
    setSavingPreferences(true);
    try {
      const response = await browserApiFetch("/api/agent-runtime/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultAgentHarness: defaultHarness,
          enabledHarnesses: AGENT_HARNESSES.filter((harness) => enabledHarnesses.has(harness)),
        }),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(result, "Failed to save preferences"));
      setPreferencesDirty(false);
      await refresh();
      toast.success("Harness preferences saved. New sessions will use the updated default.");
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : "Failed to save preferences");
    } finally {
      setSavingPreferences(false);
    }
  }

  async function refreshAll() {
    await Promise.all([refresh(), mutate("/api/agent-runtime/credentials")]);
  }

  async function runHostAction(action: "save" | "delete" | "test") {
    if (action === "save" && !deepSeekKey.trim()) {
      toast.error("Enter a DeepSeek API key first.");
      return;
    }
    if (
      action === "delete" &&
      !window.confirm("Remove the DeepSeek key from the Host? New DeepSeek sessions will fail.")
    ) {
      return;
    }
    setHostAction(action);
    try {
      const path =
        action === "test"
          ? "/api/agent-runtime/host-relay/deepseek-test"
          : "/api/agent-runtime/host-relay/deepseek-key";
      const response = await browserApiFetch(path, {
        method: action === "save" ? "PUT" : action === "delete" ? "DELETE" : "POST",
        headers: action === "save" ? { "Content-Type": "application/json" } : undefined,
        body: action === "save" ? JSON.stringify({ apiKey: deepSeekKey }) : undefined,
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(result, "Host relay operation failed"));
      if (action === "save") setDeepSeekKey("");
      await refresh();
      toast.success(
        action === "save"
          ? "DeepSeek key validated and rotated on the Host."
          : action === "delete"
            ? "DeepSeek key removed from the Host."
            : "DeepSeek inference test succeeded."
      );
    } catch (hostError) {
      toast.error(hostError instanceof Error ? hostError.message : "Host relay operation failed");
    } finally {
      setHostAction(null);
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Agent Harnesses</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure agent runtimes, native login credentials, and model-provider readiness.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          Refresh status
        </Button>
      </div>

      {!data.canManage ? (
        <div className="mt-5 border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
          You can inspect readiness and choose a Harness for sessions, but only a deployment
          administrator can change shared credentials or defaults.
        </div>
      ) : null}

      {data.catalog ? <PersonalRuntimeDefaults catalog={data.catalog} /> : null}

      {data.canManage && data.catalog ? (
        <div className="mt-6">
          <RuntimeConfigurationEditor
            scope="installation"
            scopeId="global"
            title="Installation runtime fragment"
            description="Canonical deployment-wide Harness, model, effort, and typed defaults. Personal, repository, environment, and integration fragments inherit from this layer."
          />
        </div>
      ) : null}

      <section className="mt-6 border border-border p-4">
        <h3 className="text-sm font-semibold text-foreground">New session defaults</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Environment and Automation overrides still take precedence. Existing sessions remain
          locked to their current Harness.
        </p>
        <div className="mt-4 max-w-sm">
          <Label id="default-harness-label" htmlFor="default-harness">
            Default Harness
          </Label>
          <Combobox
            id="default-harness"
            labelId="default-harness-label"
            value={defaultHarness}
            onChange={(harness) => {
              setDefaultHarness(harness);
              setPreferencesDirty(true);
            }}
            disabled={!data.canManage}
            items={AGENT_HARNESSES.filter((harness) => enabledHarnesses.has(harness)).map(
              (harness) => ({ value: harness, label: HARNESS_INFO[harness].name })
            )}
            dropdownWidth="w-full"
            triggerClassName="mt-1.5 flex w-full items-center justify-between border border-border bg-input px-3 py-2 text-sm text-foreground"
          >
            <span>{HARNESS_INFO[defaultHarness].name}</span>
            <span aria-hidden="true">⌄</span>
          </Combobox>
        </div>
      </section>

      <div className="mt-4 grid gap-3">
        {data.harnesses.map((readiness) => (
          <HarnessCard
            key={readiness.harness}
            readiness={readiness}
            enabled={enabledHarnesses.has(readiness.harness)}
            canManage={data.canManage}
            onToggle={(enabled) => toggleHarness(readiness.harness, enabled)}
          />
        ))}
      </div>

      {data.catalog ? (
        <section className="mt-8 border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Runtime capability manifest</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Exact routes and typed settings accepted by the deployed sandbox image. Policy
                settings are shown read-only; session settings appear in the new-session form.
              </p>
            </div>
            <span className="font-mono text-xs text-muted-foreground">
              {data.capabilityCatalogVersion}
            </span>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {data.catalog.map((harness) => (
              <div key={harness.harness} className="border border-border-muted p-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium text-foreground">{harness.displayName}</h4>
                  <span className={`text-xs ${harness.ready ? "text-success" : "text-warning"}`}>
                    {harness.ready ? "Ready" : "Needs setup"}
                  </span>
                </div>
                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {harness.routes.map((route) => (
                    <div key={route.routeId} className="flex justify-between gap-3">
                      <code className="min-w-0 truncate">{route.routeId}</code>
                      <span>
                        {route.ready
                          ? `${route.models.filter((model) => model.ready).length} models`
                          : route.code}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 border-t border-border-muted pt-3">
                  <p className="text-xs font-medium text-foreground">
                    Settings schema v{harness.settingsSchemaVersion}
                  </p>
                  <div className="mt-2 space-y-2">
                    {harness.settings.map((setting) => (
                      <div key={setting.key} className="text-xs">
                        <div className="flex flex-wrap justify-between gap-2 text-foreground">
                          <span>{setting.label}</span>
                          <code>{JSON.stringify(setting.defaultValue)}</code>
                        </div>
                        <p className="text-muted-foreground">
                          {setting.visibility === "read-only"
                            ? "Platform policy"
                            : "Session configurable"}{" "}
                          · {setting.mutability}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="mt-4">
        <Button
          disabled={!data.canManage || savingPreferences || !preferencesDirty}
          onClick={savePreferences}
        >
          {savingPreferences ? "Saving..." : "Save Harness preferences"}
        </Button>
      </div>

      <div className="mt-10">
        <h2 className="text-lg font-semibold text-foreground">Native Harness credentials</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Deployment-wide values are encrypted at rest and never returned to the browser. Existing
          repository and environment overrides remain available under Secrets. DeepSeek sessions use
          the Host relay instead of receiving the provider key.
        </p>
        <div className="mt-4 space-y-3">
          <CredentialEditor
            kind="codex-auth-json"
            title="Codex auth.json"
            description="ChatGPT subscription login material loaded by the native Codex app-server."
            metadata={credentials.get("codex-auth-json")}
            canManage={data.canManage}
            multiline
            allowFile
            onChanged={refreshAll}
          />
          <CredentialEditor
            kind="codex-access-token"
            title="Codex enterprise access token"
            description="Alternative to auth.json. Saving this removes the configured auth.json credential."
            metadata={credentials.get("codex-access-token")}
            canManage={data.canManage}
            onChanged={refreshAll}
          />
          <CredentialEditor
            kind="claude-setup-token"
            title="Claude Code setup-token"
            description="Long-lived token produced by claude setup-token for native Anthropic sessions."
            metadata={credentials.get("claude-setup-token")}
            canManage={data.canManage}
            onChanged={refreshAll}
          />
        </div>
      </div>

      <section className="mt-10 border border-border p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Host model relay</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              DeepSeek API credentials stay on the Host and are never stored in D1 or injected into
              a sandbox.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <StatusDot ready={Boolean(data.hostRelay?.connected)} />
            {data.hostRelay?.connected
              ? "Host connected"
              : data.hostRelay?.relay === "not-configured"
                ? "Management not configured"
                : "Host unavailable"}
          </div>
        </div>
        <div className="mt-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-2">
          <span>
            Provider key: {data.hostRelay?.deepseek.configured ? "Configured" : "Not configured"}
          </span>
          <span>Fingerprint: {data.hostRelay?.deepseek.fingerprint ?? "—"}</span>
        </div>
        <div className="mt-4">
          <Label htmlFor="deepseek-host-key">New DeepSeek API key</Label>
          <Input
            id="deepseek-host-key"
            type="password"
            value={deepSeekKey}
            disabled={!data.canManage || !data.hostRelay?.connected || hostAction !== null}
            autoComplete="new-password"
            placeholder="Validated before the Host atomically activates it"
            className="mt-1.5"
            onChange={(event) => setDeepSeekKey(event.target.value)}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={
              !data.canManage ||
              !data.hostRelay?.connected ||
              hostAction !== null ||
              !deepSeekKey.trim()
            }
            onClick={() => void runHostAction("save")}
          >
            {hostAction === "save" ? "Validating..." : "Validate and rotate"}
          </Button>
          <Button
            variant="outline"
            disabled={
              !data.canManage ||
              !data.hostRelay?.connected ||
              !data.hostRelay?.deepseek.configured ||
              hostAction !== null
            }
            onClick={() => void runHostAction("test")}
          >
            {hostAction === "test" ? "Testing inference..." : "Test inference"}
          </Button>
          {data.hostRelay?.deepseek.configured ? (
            <Button
              variant="outline"
              disabled={!data.canManage || !data.hostRelay.connected || hostAction !== null}
              onClick={() => void runHostAction("delete")}
            >
              {hostAction === "delete" ? "Removing..." : "Remove key"}
            </Button>
          ) : null}
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          The per-session SANDBOX_AUTH_TOKEN is generated automatically and is intentionally not
          editable here. The Host management HMAC secret is a deployment bootstrap credential and
          must remain in Cloudflare and the Host service manager.
        </p>
      </section>
    </div>
  );
}
