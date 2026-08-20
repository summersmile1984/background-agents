"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  encodeRepositoryPathSegments,
  parseRepositoryFullName,
} from "@open-inspect/shared/types/repositories";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import type { IntegrationId, IntegrationEntry } from "@open-inspect/shared/types/integrations";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { Button } from "@/components/ui/button";
import { RadioCard } from "@/components/ui/form-controls";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface EnablementSettings {
  enabled?: boolean;
}

type EnablementGlobalConfig = IntegrationEntry<EnablementSettings>["global"];

interface EnablementIntegrationCopy {
  id: Extract<IntegrationId, "code-server" | "vnc">;
  title: string;
  intro: string;
  overrideDescription: string;
  enableLabel: string;
  enableDescription: string;
  scopeDescription: string;
  allRepositoriesDescription: string;
  selectedRepositoriesDescription: string;
  emptySelectionWarning: string;
  emptyOverrides: string;
  resetDescription: string;
}

interface GlobalResponse {
  settings: EnablementGlobalConfig | null;
}

interface RepoSettingsEntry {
  repositoryId?: string;
  repo: string;
  settings: EnablementSettings;
}

interface RepoListResponse {
  repos: RepoSettingsEntry[];
}

interface ReposResponse {
  repos: EnrichedRepository[];
}

export function EnablementIntegrationSettings({ copy }: { copy: EnablementIntegrationCopy }) {
  const globalSettingsKey = `/api/integration-settings/${copy.id}` as const;
  const repoSettingsKey = `/api/integration-settings/${copy.id}/repos` as const;
  const { data: globalData, isLoading: globalLoading } = useSWR<GlobalResponse>(globalSettingsKey);
  const { data: repoSettingsData, isLoading: repoSettingsLoading } =
    useSWR<RepoListResponse>(repoSettingsKey);
  const { data: reposData } = useSWR<ReposResponse>("/api/repos");

  if (globalLoading || repoSettingsLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  const settings = globalData?.settings;
  const repoOverrides = repoSettingsData?.repos ?? [];
  const availableRepos = reposData?.repos ?? [];

  return (
    <div>
      <h3 className="text-lg font-semibold text-foreground mb-1">{copy.title}</h3>
      <p className="text-sm text-muted-foreground mb-6">{copy.intro}</p>

      <GlobalSettingsSection
        settings={settings}
        availableRepos={availableRepos}
        settingsKey={globalSettingsKey}
        copy={copy}
      />

      <Section title="Repository Overrides" description={copy.overrideDescription}>
        <RepoOverridesSection
          overrides={repoOverrides}
          availableRepos={availableRepos}
          settingsKey={repoSettingsKey}
          copy={copy}
        />
      </Section>
    </div>
  );
}

function GlobalSettingsSection({
  settings,
  availableRepos,
  settingsKey,
  copy,
}: {
  settings: EnablementGlobalConfig | null | undefined;
  availableRepos: EnrichedRepository[];
  settingsKey: `/api/integration-settings/${string}`;
  copy: EnablementIntegrationCopy;
}) {
  const [enabled, setEnabled] = useState(settings?.defaults?.enabled ?? false);
  const [enabledRepos, setEnabledRepos] = useState<string[]>(
    settings?.enabledRepositoryIds ?? settings?.enabledRepos ?? []
  );
  const [repoScopeMode, setRepoScopeMode] = useState<"all" | "selected">(
    settings?.enabledRepositoryIds == null && settings?.enabledRepos == null ? "all" : "selected"
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !initialized) {
      if (settings) {
        setEnabled(settings.defaults?.enabled ?? false);
        setEnabledRepos(settings.enabledRepositoryIds ?? settings.enabledRepos ?? []);
        setRepoScopeMode(
          settings.enabledRepositoryIds == null && settings.enabledRepos == null
            ? "all"
            : "selected"
        );
      }
      setInitialized(true);
    }
  }, [settings, initialized]);

  const isConfigured = settings !== null && settings !== undefined;

  const handleConfirmReset = async () => {
    setSaving(true);

    try {
      const res = await browserApiFetch(settingsKey, { method: "DELETE" });

      if (res.ok) {
        mutate(settingsKey);
        setEnabled(false);
        setEnabledRepos([]);
        setRepoScopeMode("all");
        setDirty(false);
        toast.success("Settings reset to defaults.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to reset settings");
      }
    } catch {
      toast.error("Failed to reset settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);

    const defaults: EnablementSettings = { enabled };
    const body: EnablementGlobalConfig = { defaults };
    if (repoScopeMode === "selected") {
      const repositoryIds = enabledRepos.flatMap((selected) => {
        const byId = availableRepos.find((repo) => repo.repositoryKey === selected);
        if (byId?.repositoryKey) return [byId.repositoryKey];
        const byPath = availableRepos.find(
          (repo) => repo.fullName.toLowerCase() === selected.toLowerCase()
        );
        return byPath?.repositoryKey ? [byPath.repositoryKey] : [];
      });
      body.enabledRepositoryIds = [...new Set(repositoryIds)];
    }

    try {
      const res = await browserApiFetch(settingsKey, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: body }),
      });

      if (res.ok) {
        mutate(settingsKey);
        toast.success("Settings saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const toggleRepo = (repo: EnrichedRepository) => {
    const key = repo.repositoryKey ?? repo.fullName.toLowerCase();
    setEnabledRepos((prev) =>
      prev.includes(key) ? prev.filter((r) => r !== key) : [...prev, key]
    );
    setDirty(true);
  };

  return (
    <Section title="Defaults & Scope" description={copy.scopeDescription}>
      <div className="mb-4">
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <div>
            <span className="font-medium text-foreground">{copy.enableLabel}</span>
            <p className="text-xs text-muted-foreground mt-0.5">{copy.enableDescription}</p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={() => {
              setEnabled(!enabled);
              setDirty(true);
            }}
            className="rounded border-border"
          />
        </label>
      </div>

      <div className="mb-4">
        <p className="text-sm font-medium text-foreground mb-2">Repository Scope</p>
        <div className="grid sm:grid-cols-2 gap-2 mb-3">
          <RadioCard
            name={`${copy.id}-repo-scope`}
            checked={repoScopeMode === "all"}
            onChange={() => {
              setRepoScopeMode("all");
              setDirty(true);
            }}
            label="All repositories"
            description={copy.allRepositoriesDescription}
          />
          <RadioCard
            name={`${copy.id}-repo-scope`}
            checked={repoScopeMode === "selected"}
            onChange={() => {
              setRepoScopeMode("selected");
              setDirty(true);
            }}
            label="Selected repositories"
            description={copy.selectedRepositoriesDescription}
          />
        </div>

        {repoScopeMode === "selected" && (
          <>
            {availableRepos.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 py-3 border border-border rounded-sm">
                Repository filtering is unavailable because no repositories are accessible.
              </p>
            ) : (
              <div className="border border-border max-h-56 overflow-y-auto rounded-sm">
                {availableRepos.map((repo) => {
                  const stableKey = repo.repositoryKey ?? repo.fullName.toLowerCase();
                  const isChecked =
                    enabledRepos.includes(stableKey) ||
                    enabledRepos.includes(repo.fullName.toLowerCase());

                  return (
                    <label
                      key={stableKey}
                      className="flex items-center gap-2 px-4 py-2 hover:bg-muted/50 transition cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleRepo(repo)}
                        className="rounded border-border"
                      />
                      <span className="text-foreground">{repo.fullName}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {enabledRepos.length === 0 && availableRepos.length > 0 && (
              <p className="text-xs text-warning mt-1">{copy.emptySelectionWarning}</p>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>

        {isConfigured && (
          <Button variant="destructive" onClick={() => setShowResetDialog(true)} disabled={saving}>
            Reset to defaults
          </Button>
        )}
      </div>

      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to defaults</AlertDialogTitle>
            <AlertDialogDescription>{copy.resetDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmReset}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function RepoOverridesSection({
  overrides,
  availableRepos,
  settingsKey,
  copy,
}: {
  overrides: RepoSettingsEntry[];
  availableRepos: EnrichedRepository[];
  settingsKey: `/api/integration-settings/${string}/repos`;
  copy: EnablementIntegrationCopy;
}) {
  const [addingRepo, setAddingRepo] = useState("");

  const overriddenRepos = new Set(
    overrides.map((override) => override.repositoryId ?? override.repo.toLowerCase())
  );
  const availableForOverride = availableRepos.filter(
    (repo) => !overriddenRepos.has(repo.repositoryKey ?? repo.fullName.toLowerCase())
  );

  const handleAdd = async () => {
    if (!addingRepo) return;
    const selected = availableRepos.find(
      (repo) => (repo.repositoryKey ?? repo.fullName.toLowerCase()) === addingRepo
    );
    if (!selected) return;
    const endpoint: BrowserApiPath | null = selected.repositoryKey
      ? `/api/integration-settings/${copy.id}/repositories/${encodeURIComponent(selected.repositoryKey)}`
      : (() => {
          const repository = parseRepositoryFullName(selected.fullName);
          return repository ? `${settingsKey}/${encodeRepositoryPathSegments(repository)}` : null;
        })();
    if (!endpoint) return;

    try {
      const res = await browserApiFetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { enabled: true } }),
      });

      if (res.ok) {
        mutate(settingsKey);
        setAddingRepo("");
        toast.success("Override added.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to add override");
      }
    } catch {
      toast.error("Failed to add override");
    }
  };

  return (
    <div>
      {overrides.length > 0 ? (
        <div className="space-y-2 mb-4">
          {overrides.map((entry) => (
            <RepoOverrideRow
              key={entry.repositoryId ?? entry.repo}
              entry={entry}
              settingsKey={settingsKey}
              integrationId={copy.id}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">{copy.emptyOverrides}</p>
      )}

      <div className="flex items-center gap-2">
        <Select value={addingRepo} onValueChange={setAddingRepo}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Select a repository..." />
          </SelectTrigger>
          <SelectContent>
            {availableForOverride.map((repo) => (
              <SelectItem
                key={repo.repositoryKey ?? repo.fullName}
                value={repo.repositoryKey ?? repo.fullName.toLowerCase()}
              >
                {repo.fullName}
                {repo.connection?.displayName ? ` · ${repo.connection.displayName}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={handleAdd} disabled={!addingRepo}>
          Add Override
        </Button>
      </div>
    </div>
  );
}

function RepoOverrideRow({
  entry,
  settingsKey,
  integrationId,
}: {
  entry: RepoSettingsEntry;
  settingsKey: `/api/integration-settings/${string}/repos`;
  integrationId: EnablementIntegrationCopy["id"];
}) {
  const [enabled, setEnabled] = useState(entry.settings.enabled ?? false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const handleSave = async () => {
    const repository = parseRepositoryFullName(entry.repo);
    if (!entry.repositoryId && !repository) return;
    const endpoint: BrowserApiPath = entry.repositoryId
      ? `/api/integration-settings/${integrationId}/repositories/${encodeURIComponent(entry.repositoryId)}`
      : `${settingsKey}/${encodeRepositoryPathSegments(repository!)}`;
    setSaving(true);
    const settings: EnablementSettings = { enabled };

    try {
      const res = await browserApiFetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });

      if (res.ok) {
        mutate(settingsKey);
        setDirty(false);
        toast.success(`Override for ${entry.repo} saved.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save override");
      }
    } catch {
      toast.error("Failed to save override");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const repository = parseRepositoryFullName(entry.repo);
    if (!entry.repositoryId && !repository) return;
    const endpoint: BrowserApiPath = entry.repositoryId
      ? `/api/integration-settings/${integrationId}/repositories/${encodeURIComponent(entry.repositoryId)}`
      : `${settingsKey}/${encodeRepositoryPathSegments(repository!)}`;

    try {
      const res = await browserApiFetch(endpoint, {
        method: "DELETE",
      });

      if (res.ok) {
        mutate(settingsKey);
        toast.success(`Override for ${entry.repo} removed.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to delete override");
      }
    } catch {
      toast.error("Failed to delete override");
    }
  };

  return (
    <div
      role="group"
      aria-label={`${entry.repo} override`}
      className="flex items-center justify-between gap-2 px-4 py-3 border border-border rounded-sm"
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span className="text-sm font-medium text-foreground truncate">{entry.repo}</span>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={() => {
              setEnabled(!enabled);
              setDirty(true);
            }}
            className="rounded border-border"
          />
          <span className="text-muted-foreground">Enabled</span>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "..." : "Save"}
        </Button>
        <Button variant="destructive" size="sm" onClick={handleDelete}>
          Remove
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-border-muted rounded-md p-5 mb-5">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-foreground mb-1">
        {title}
      </h4>
      <p className="text-sm text-muted-foreground mb-4">{description}</p>
      {children}
    </section>
  );
}
