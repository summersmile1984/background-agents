"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import type {
  SourceControlConnectionDetails,
  SourceControlConnectionProbe,
} from "@open-inspect/shared/types/source-control";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const CONNECTIONS_API = "/api/scm/connections" as const;
const MIGRATION_PREFLIGHT_API = "/api/scm/migration/preflight" as const;

interface ConnectionsResponse {
  connections: SourceControlConnectionDetails[];
  canManage: boolean;
}

interface MigrationPreflight {
  legacyRepositoryLocations: number;
  unresolvedActiveRepositories: number;
  mixedSessionAggregates: number;
  mixedEnvironmentAggregates: number;
  mixedAutomationAggregates: number;
  orphanRepositoryReferences: number;
  readyForSecondConnection: boolean;
  job: {
    status: "pending" | "running" | "complete" | "failed";
    processedRows: number;
    unresolvedRows: number;
    lastErrorCode: string | null;
  } | null;
}

interface MigrationResponse {
  defaultConnectionId: string;
  preflight: MigrationPreflight;
}

function errorMessage(value: unknown, fallback: string): string {
  return value && typeof value === "object" && "error" in value && typeof value.error === "string"
    ? value.error
    : fallback;
}

function healthClass(health: SourceControlConnectionDetails["health"]): string {
  if (health === "healthy") return "bg-emerald-500";
  if (health === "disabled") return "bg-muted-foreground";
  return "bg-amber-500";
}

function ConnectionCard({
  connection,
  canManage,
  onEdit,
}: {
  connection: SourceControlConnectionDetails;
  canManage: boolean;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function act(kind: "test" | "disable") {
    if (kind === "disable" && !window.confirm(`Disable ${connection.displayName}?`)) return;
    setBusy(true);
    try {
      const path =
        kind === "test"
          ? (`/api/scm/connections/${connection.id}/test` as const)
          : (`/api/scm/connections/${connection.id}` as const);
      const response = await browserApiFetch(path, { method: kind === "test" ? "POST" : "DELETE" });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(data, `Failed to ${kind} connection`));
      if (kind === "test") {
        const probe = (data as { probe?: SourceControlConnectionProbe }).probe;
        toast.success(
          probe?.version
            ? `Connected as ${probe.serviceUser ?? "service user"} · Gitea ${probe.version}`
            : "Connection is healthy."
        );
      } else {
        toast.success("Connection disabled.");
      }
      await mutate(CONNECTIONS_API);
      await mutate("/api/repos");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Source-control operation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{connection.displayName}</h3>
            <span className="text-xs uppercase text-muted-foreground">{connection.provider}</span>
            {connection.isDefault ? (
              <span className="border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                Default
              </span>
            ) : null}
          </div>
          <p className="mt-1 break-all text-xs text-muted-foreground">{connection.baseUrl}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${healthClass(connection.health)}`} />
              {connection.health}
            </span>
            <span>{connection.version ? `Gitea ${connection.version}` : "Version unknown"}</span>
            <span>
              {connection.credentialConfigured ? "Credential stored" : "Credential missing"}
            </span>
          </div>
          {connection.lastErrorCode ? (
            <p className="mt-2 text-xs text-destructive">{connection.lastErrorCode}</p>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex shrink-0 gap-2">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void act("test")}>
              Test
            </Button>
            <Button size="xs" variant="outline" disabled={busy} onClick={onEdit}>
              Edit
            </Button>
            {connection.enabled ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void act("disable")}
              >
                Disable
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ConnectionForm({
  existing,
  onDone,
}: {
  existing: SourceControlConnectionDetails | null;
  onDone: () => void;
}) {
  const [displayName, setDisplayName] = useState(existing?.displayName ?? "Gitea");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [accessToken, setAccessToken] = useState("");
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!displayName.trim() || !baseUrl.trim() || !username.trim()) {
      toast.error("Name, base URL, and service username are required.");
      return;
    }
    if (!existing && !accessToken) {
      toast.error("A personal access token is required for a new connection.");
      return;
    }
    setSaving(true);
    try {
      const path = existing ? (`/api/scm/connections/${existing.id}` as const) : CONNECTIONS_API;
      const body = existing
        ? {
            expectedRevision: existing.revision,
            displayName,
            baseUrl,
            username,
            enabled,
            ...(accessToken ? { accessToken } : {}),
            ...(isDefault ? { isDefault: true as const } : {}),
          }
        : {
            provider: "gitea" as const,
            displayName,
            baseUrl,
            username,
            accessToken,
            isDefault,
          };
      const response = await browserApiFetch(path, {
        method: existing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(data, "Failed to save connection"));
      setAccessToken("");
      await mutate(CONNECTIONS_API);
      await mutate("/api/repos");
      toast.success(existing ? "Connection updated." : "Connection created and tested.");
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save connection");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border border-border p-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {existing ? `Edit ${existing.displayName}` : "Add Gitea connection"}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          The PAT is encrypted by the control plane and is never returned to the browser or sandbox.
        </p>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="scm-display-name">Display name</Label>
          <Input
            id="scm-display-name"
            className="mt-1.5"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            disabled={saving}
          />
        </div>
        <div>
          <Label htmlFor="scm-username">Service username</Label>
          <Input
            id="scm-username"
            className="mt-1.5"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={saving}
            autoComplete="off"
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="scm-base-url">Gitea base URL</Label>
          <Input
            id="scm-base-url"
            className="mt-1.5"
            type="url"
            placeholder="https://gitea.example.com"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            disabled={saving}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="scm-token">
            {existing ? "Replacement PAT (optional)" : "Personal access token"}
          </Label>
          <Input
            id="scm-token"
            className="mt-1.5 font-mono"
            type="password"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
            disabled={saving}
            autoComplete="new-password"
            placeholder={existing ? "Leave blank to keep the stored token" : "Paste PAT"}
          />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-5">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Switch
            checked={isDefault}
            onCheckedChange={setIsDefault}
            disabled={saving || existing?.isDefault}
          />
          Default connection
        </label>
        {existing ? (
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={enabled} onCheckedChange={setEnabled} disabled={saving} />
            Enabled
          </label>
        ) : null}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "Testing…" : "Test and save"}
        </Button>
      </div>
    </section>
  );
}

export function SourceControlSettings() {
  const { data, error, isLoading } = useSWR<ConnectionsResponse>(CONNECTIONS_API);
  const { data: migrationData, mutate: mutateMigration } = useSWR<MigrationResponse>(
    data?.canManage ? MIGRATION_PREFLIGHT_API : null
  );
  const [editing, setEditing] = useState<SourceControlConnectionDetails | "new" | null>(null);
  const [backfillBusy, setBackfillBusy] = useState(false);

  async function runBackfill() {
    setBackfillBusy(true);
    try {
      const response = await browserApiFetch("/api/scm/migration/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchSize: 25 }),
      });
      const result = (await response.json()) as {
        error?: string;
        processed?: number;
        hasMore?: boolean;
        preflight?: MigrationPreflight;
      };
      if (!response.ok) throw new Error(result.error ?? "Repository migration failed");
      await mutateMigration();
      toast.success(
        result.preflight?.readyForSecondConnection
          ? "Repository migration is complete."
          : `Migrated ${result.processed ?? 0} repositories${result.hasMore ? "; run the next batch" : ""}.`
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Repository migration failed");
    } finally {
      setBackfillBusy(false);
    }
  }

  if (isLoading)
    return <div className="text-sm text-muted-foreground">Loading source-control connections…</div>;
  if (error || !data)
    return (
      <div className="text-sm text-destructive">Failed to load source-control connections.</div>
    );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Source Control</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage GitHub and self-hosted Gitea connections. Sessions stay pinned to the selected
            connection.
          </p>
        </div>
        {data.canManage && !editing ? (
          <Button
            onClick={() => setEditing("new")}
            disabled={migrationData?.preflight.readyForSecondConnection !== true}
          >
            Add Gitea
          </Button>
        ) : null}
      </div>

      {data.canManage && migrationData && !migrationData.preflight.readyForSecondConnection ? (
        <section className="border border-amber-500/40 bg-amber-500/5 p-4">
          <h3 className="text-sm font-semibold text-foreground">Repository migration required</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Existing source-control records must receive stable repository IDs before another forge
            can be added. The migration is idempotent and runs in bounded batches.
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{migrationData.preflight.legacyRepositoryLocations} legacy locations</span>
            <span>
              {migrationData.preflight.unresolvedActiveRepositories} unresolved active repositories
            </span>
            <span>{migrationData.preflight.orphanRepositoryReferences} orphan references</span>
          </div>
          {migrationData.preflight.job?.lastErrorCode ? (
            <p className="mt-2 text-xs text-destructive">
              {migrationData.preflight.job.lastErrorCode}
            </p>
          ) : null}
          <Button
            className="mt-3"
            size="sm"
            disabled={backfillBusy}
            onClick={() => void runBackfill()}
          >
            {backfillBusy ? "Migrating…" : "Migrate next batch"}
          </Button>
        </section>
      ) : null}

      {editing ? (
        <ConnectionForm
          existing={editing === "new" ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : null}

      <div className="space-y-3">
        {data.connections.map((connection) => (
          <ConnectionCard
            key={connection.id}
            connection={connection}
            canManage={data.canManage}
            onEdit={() => setEditing(connection)}
          />
        ))}
        {data.connections.length === 0 ? (
          <p className="border border-dashed border-border p-4 text-sm text-muted-foreground">
            No source-control connection is configured.
          </p>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        Self-hosted hosts must also be present in the deployment allowlist. Enterprise Gitea
        versions require an exact operator-confirmed security backport before they can be enabled.
      </p>
    </div>
  );
}
