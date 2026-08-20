"use client";

import { RepositoryMultiSelect } from "@/components/repository-multi-select";
import { Combobox } from "@/components/ui/combobox";
import {
  BranchIcon,
  ChevronDownIcon,
  ErrorIcon,
  RefreshIcon,
  RepoIcon,
} from "@/components/ui/icons";
import { type SessionTargetPickerProps } from "@/hooks/use-session-target-picker";
import { repoSelectionValue } from "@/lib/repository-selection";
import { sourceControlConnectionLabel, sourceControlHostname } from "@/lib/scm-presentation";

/**
 * The new-session target controls: the unified environment/repository
 * selector, the ad-hoc repository set editor, and the branch selector.
 * State and option building live in useSessionTargetPicker.
 */
export function SessionTargetPicker({
  sessionTarget,
  targetSelectValue,
  targetOptions,
  displayTargetName,
  onTargetSelectValueChange,
  onMultiSelectionChange,
  selectedBranch,
  setSelectedBranch,
  branches,
  loadingBranches,
  repos,
  loadingRepos,
  sourceConnections,
  selectedSourceConnectionId,
  onSourceConnectionChange,
  connectionErrors,
  onRefreshRepositories,
  selectionNotice,
  repositoryLoadFailed,
  catalogCachedAt,
  disabled,
}: SessionTargetPickerProps & { disabled: boolean }) {
  const selectedSource = sourceConnections.find(
    (connection) => connection.id === selectedSourceConnectionId
  );
  const selectedSourceError = connectionErrors.find(
    (entry) => entry.connectionId === selectedSourceConnectionId
  );
  const sourceOptions = sourceConnections.map((connection) => {
    const unavailable = connectionErrors.some((entry) => entry.connectionId === connection.id);
    const host = sourceControlHostname(connection.baseUrl);
    return {
      value: connection.id,
      label: sourceControlConnectionLabel(connection),
      description: `${host}${unavailable ? " · catalog unavailable" : ""}`,
    };
  });
  const cachedCatalogLabel = (() => {
    if (!catalogCachedAt) return null;
    const parsed = Date.parse(catalogCachedAt);
    if (!Number.isFinite(parsed)) return "Cached catalog";
    const minutes = Math.max(0, Math.floor((Date.now() - parsed) / 60_000));
    return minutes < 1 ? "Cached catalog · just now" : `Cached catalog · ${minutes}m ago`;
  })();

  return (
    <>
      {/* Source selector is explicit whenever several forges are configured. */}
      {sourceConnections.length > 1 ? (
        <Combobox
          value={selectedSourceConnectionId}
          onChange={onSourceConnectionChange}
          items={sourceOptions}
          direction="up"
          dropdownWidth="w-72"
          disabled={disabled || loadingRepos}
          triggerClassName="flex max-w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          <span className="text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
            Source
          </span>
          <span className="truncate max-w-[12rem]">
            {selectedSource ? sourceControlConnectionLabel(selectedSource) : "Choose source"}
          </span>
          <ChevronDownIcon className="w-3 h-3" />
        </Combobox>
      ) : selectedSource ? (
        <span
          className="flex max-w-full items-center gap-1.5 text-sm text-muted-foreground"
          title={selectedSource.baseUrl}
        >
          <span className="text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
            Source
          </span>
          <span className="truncate max-w-[12rem]">
            {sourceControlConnectionLabel(selectedSource)}
          </span>
        </span>
      ) : null}

      {/* Target selector */}
      <Combobox
        value={targetSelectValue}
        onChange={(value) => onTargetSelectValueChange(value)}
        items={targetOptions}
        searchable
        searchPlaceholder="Search environments and repositories..."
        filterFn={(option, query) =>
          option.label.toLowerCase().includes(query) ||
          (option.description?.toLowerCase().includes(query) ?? false) ||
          String(option.value).toLowerCase().includes(query)
        }
        direction="up"
        dropdownWidth="w-72"
        disabled={disabled || loadingRepos || Boolean(selectedSourceError)}
        triggerClassName="flex max-w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        <RepoIcon className="w-4 h-4" />
        <span className="truncate max-w-[12rem] sm:max-w-none">
          {loadingRepos ? "Loading..." : displayTargetName}
        </span>
        <ChevronDownIcon className="w-3 h-3" />
      </Combobox>

      {selectedSourceError ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-destructive hover:underline disabled:opacity-50"
          disabled={disabled || loadingRepos}
          onClick={onRefreshRepositories}
          title={selectedSourceError.code}
        >
          <ErrorIcon className="h-3.5 w-3.5" />
          Catalog unavailable
          <RefreshIcon className="h-3.5 w-3.5" />
        </button>
      ) : null}

      {repositoryLoadFailed && !selectedSourceError ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-destructive hover:underline disabled:opacity-50"
          disabled={disabled || loadingRepos}
          onClick={onRefreshRepositories}
        >
          <ErrorIcon className="h-3.5 w-3.5" />
          Sources unavailable
          <RefreshIcon className="h-3.5 w-3.5" />
        </button>
      ) : null}

      {cachedCatalogLabel ? (
        <span className="text-[11px] text-muted-foreground" title={catalogCachedAt ?? undefined}>
          {cachedCatalogLabel}
        </span>
      ) : null}

      {selectionNotice ? (
        <span className="text-xs text-amber-600 dark:text-amber-400">{selectionNotice}</span>
      ) : null}

      {/* Ad-hoc repository set editor */}
      {sessionTarget?.kind === "repos" && (
        <RepositoryMultiSelect
          repos={repos}
          loadingRepos={loadingRepos}
          selected={sessionTarget.repoFullNames}
          onChange={onMultiSelectionChange}
          disabled={disabled || loadingRepos}
          triggerLabel={
            sessionTarget.repoFullNames.length === 0
              ? "Choose repositories"
              : sessionTarget.repoFullNames
                  .map(
                    (value) =>
                      repos.find((repo) => repoSelectionValue(repo) === value)?.fullName ?? value
                  )
                  .join(", ")
          }
          triggerClassName="max-w-[16rem] border-0 bg-transparent px-0 py-0 text-sm text-muted-foreground hover:text-foreground"
        />
      )}

      {/* Branch selector */}
      {sessionTarget?.kind === "repo" && (
        <Combobox
          value={selectedBranch}
          onChange={(value) => setSelectedBranch(value)}
          items={branches.map((b) => ({
            value: b.name,
            label: b.name,
          }))}
          searchable
          searchPlaceholder="Search branches..."
          filterFn={(option, query) => option.label.toLowerCase().includes(query)}
          direction="up"
          dropdownWidth="w-56"
          disabled={disabled || loadingBranches}
          triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          <BranchIcon className="w-3.5 h-3.5" />
          <span className="truncate max-w-[9rem] sm:max-w-none">
            {loadingBranches ? "Loading..." : selectedBranch || "branch"}
          </span>
          <ChevronDownIcon className="w-3 h-3" />
        </Combobox>
      )}
    </>
  );
}
