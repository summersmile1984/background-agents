"use client";

import { useEffect, useMemo, useState } from "react";
import { MAX_TARGET_REPOSITORIES } from "@open-inspect/shared/types/repositories";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RepoIcon, FolderIcon, SearchIcon, ChevronDownIcon } from "@/components/ui/icons";
import type { Repo } from "@/hooks/use-repos";
import { repoSelectionValue } from "@/lib/repository-selection";
import { sourceControlConnectionLabel, sourceControlHostname } from "@/lib/scm-presentation";
import { cn } from "@/lib/utils";

/**
 * Ordered multi-select of repositories behind a searchable popover (the
 * automation form's selector pattern) — selection order is list order, so
 * `selected[0]` is the primary. Enforces the session/environment list rules
 * client-side: at most MAX_TARGET_REPOSITORIES entries, and no duplicate
 * repository *name* across owners (checkout paths are /workspace/{repoName}).
 */
export function RepositoryMultiSelect({
  repos,
  loadingRepos,
  selected,
  onChange,
  disabled = false,
  triggerId,
  triggerLabel,
  triggerClassName,
}: {
  repos: Repo[];
  loadingRepos: boolean;
  /** Ordered lowercase "owner/name" keys; [0] is the primary. */
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  triggerId?: string;
  triggerLabel: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredRepos = useMemo(
    () =>
      normalizedQuery
        ? repos.filter(
            (repo) =>
              repo.fullName.toLowerCase().includes(normalizedQuery) ||
              repo.connection?.displayName.toLowerCase().includes(normalizedQuery) ||
              repo.connection?.provider.toLowerCase().includes(normalizedQuery) ||
              sourceControlHostname(repo.connection?.baseUrl ?? "")
                .toLowerCase()
                .includes(normalizedQuery)
          )
        : repos,
    [repos, normalizedQuery]
  );

  const selectedNamesByKey = useMemo(() => {
    const names = new Map<string, string>();
    for (const key of selected) {
      const name = repos.find((repo) => repoSelectionValue(repo) === key)?.name.toLowerCase();
      if (name) names.set(name, key);
    }
    return names;
  }, [repos, selected]);
  const selectedConnectionIds = useMemo(
    () =>
      new Set(
        selected
          .map((key) => repos.find((repo) => repoSelectionValue(repo) === key)?.connectionId)
          .filter((id): id is string => Boolean(id))
      ),
    [repos, selected]
  );
  const lockedConnection = useMemo(() => {
    const first = selected
      .map((key) => repos.find((repo) => repoSelectionValue(repo) === key))
      .find((repo): repo is Repo => Boolean(repo?.connection));
    return first?.connection ?? null;
  }, [repos, selected]);

  const handleToggle = (repo: Repo) => {
    const key = repoSelectionValue(repo);
    if (selected.includes(key)) {
      onChange(selected.filter((entry) => entry !== key));
      return;
    }
    if (selected.length >= MAX_TARGET_REPOSITORIES) return;
    onChange([...selected, key]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={triggerId}
          type="button"
          disabled={disabled}
          className={cn(
            "flex items-center gap-2 rounded-sm border border-border bg-input px-3 py-2 text-sm text-foreground transition hover:border-foreground/20 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
            triggerClassName
          )}
          aria-label="Repository selection"
        >
          <RepoIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left">
            {loadingRepos && selected.length === 0 ? "Loading..." : triggerLabel}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {selected.length}/{MAX_TARGET_REPOSITORIES}
          </span>
          <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(34rem,calc(100vw-2rem))] p-0 sm:w-[var(--radix-popover-trigger-width)]"
      >
        <div className="border-b border-border-muted p-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={loadingRepos ? "Loading repositories..." : "Search repositories"}
              disabled={loadingRepos}
              autoFocus
              className="pl-8"
            />
          </div>
          {lockedConnection ? (
            <p className="mt-2 px-0.5 text-xs text-muted-foreground">
              Source locked to {sourceControlConnectionLabel(lockedConnection)}. One session cannot
              mix repositories from different source-control connections.
            </p>
          ) : null}
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {filteredRepos.map((repo) => {
            const key = repoSelectionValue(repo);
            const checked = selected.includes(key);
            const atCap = !checked && selected.length >= MAX_TARGET_REPOSITORIES;
            const nameCollision =
              !checked && selectedNamesByKey.get(repo.name.toLowerCase()) !== undefined;
            const connectionMismatch =
              !checked &&
              selectedConnectionIds.size > 0 &&
              Boolean(repo.connectionId) &&
              !selectedConnectionIds.has(repo.connectionId!);
            const itemDisabled = atCap || nameCollision || connectionMismatch;

            return (
              <label
                key={key}
                title={
                  nameCollision
                    ? `Another selected repository is also named "${repo.name}" — checkout paths would collide`
                    : connectionMismatch
                      ? "All repositories in one session must use the same source-control connection"
                      : undefined
                }
                className={cn(
                  "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
                  checked ? "bg-muted text-foreground" : "hover:bg-muted/60",
                  itemDisabled && "cursor-not-allowed opacity-50"
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={itemDisabled}
                  onChange={() => handleToggle(repo)}
                  className="h-4 w-4 rounded border-border accent-accent"
                />
                <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {repo.owner}/{repo.name}
                  {connectionMismatch ? (
                    <span className="ml-2 text-[11px] text-amber-600 dark:text-amber-400">
                      different source
                    </span>
                  ) : null}
                </span>
                {repo.connection?.displayName ? (
                  <span className="text-xs text-muted-foreground">
                    {sourceControlConnectionLabel(repo.connection)}
                  </span>
                ) : null}
                {repo.private && <span className="text-xs text-muted-foreground">private</span>}
              </label>
            );
          })}
          {filteredRepos.length === 0 && (
            <div className="px-3 py-3 text-sm text-muted-foreground">No repositories found</div>
          )}
        </div>
        <div className="flex justify-end border-t border-border-muted px-3 py-2">
          <Button type="button" variant="outline" size="xs" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
