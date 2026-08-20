"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import type { ImageBuildRecordView } from "@open-inspect/shared/types/image-builds";
import { useRepos } from "@/hooks/use-repos";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBanner } from "@/components/ui/error-banner";
import { RefreshIcon } from "@/components/ui/icons";
import {
  IMAGE_BUILDS_KEY,
  formatReadyDetails,
  parsePrimaryBuildSha,
  type ImageBuildsFeed,
  repoImageBuildScopeIdFor,
} from "@/lib/image-builds";
import { supportsRepoImages } from "@/lib/sandbox-provider";
import { ImageBuildStatus } from "./image-build-status";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export function ImagesSettings() {
  const repoImagesSupported = supportsRepoImages();
  const { repos, loading: reposLoading } = useRepos();
  const { data, isLoading: imagesLoading } = useSWR<ImageBuildsFeed>(
    repoImagesSupported ? IMAGE_BUILDS_KEY : null
  );
  const [togglingRepos, setTogglingRepos] = useState<Set<string>>(new Set());
  const [triggeringRepos, setTriggeringRepos] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  if (!repoImagesSupported) {
    return (
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">Pre-Built Images</h2>
        <p className="text-sm text-muted-foreground">
          Pre-built images are only available when <code>SANDBOX_PROVIDER=modal</code>,{" "}
          <code>SANDBOX_PROVIDER=vercel</code>, or <code>SANDBOX_PROVIDER=opencomputer</code>.
        </p>
      </div>
    );
  }

  const loading = reposLoading || imagesLoading;

  // Toggle state reads the persisted flags, not `units` — the units feed
  // resolves scopes through source control and can transiently drop a repo.
  const enabledRepos = new Set(
    (data?.enabledRepos ?? []).map((repo) =>
      repo.repositoryKey
        ? `repo:${repo.repositoryKey}`
        : `${repo.repoOwner}/${repo.repoName}`.toLowerCase()
    )
  );

  // Repo scope_ids are lowercase `owner/name` pairs.
  const getLatestImage = (repo: (typeof repos)[number]): ImageBuildRecordView | undefined => {
    const key = repoImageBuildScopeIdFor(repo);
    return data?.images.find((img) => img.scope_kind === "repo" && img.scope_id === key);
  };

  const handleToggle = async (repo: (typeof repos)[number], enabled: boolean) => {
    const repoKey = repoImageBuildScopeIdFor(repo);
    setTogglingRepos((prev) => new Set(prev).add(repoKey));
    setError("");

    try {
      const res = await browserApiFetch(
        repo.repositoryKey
          ? `/api/image-builds/repository/${encodeURIComponent(repo.repositoryKey)}/toggle`
          : `/api/image-builds/repo/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/toggle`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }
      );

      if (!res.ok) {
        const errBody = await res.json();
        setError(errBody.error || "Failed to toggle image build");
      } else {
        mutate(IMAGE_BUILDS_KEY);
      }
    } catch {
      setError("Failed to toggle image build");
    } finally {
      setTogglingRepos((prev) => {
        const next = new Set(prev);
        next.delete(repoKey);
        return next;
      });
    }
  };

  const handleTrigger = async (repo: (typeof repos)[number]) => {
    const repoKey = repoImageBuildScopeIdFor(repo);
    setTriggeringRepos((prev) => new Set(prev).add(repoKey));
    setError("");

    try {
      const res = await browserApiFetch(
        repo.repositoryKey
          ? `/api/image-builds/repository/${encodeURIComponent(repo.repositoryKey)}/trigger`
          : `/api/image-builds/repo/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/trigger`,
        { method: "POST" }
      );

      if (!res.ok) {
        const errBody = await res.json();
        setError(errBody.error || "Failed to trigger build");
      } else {
        mutate(IMAGE_BUILDS_KEY);
      }
    } catch {
      setError("Failed to trigger build");
    } finally {
      setTriggeringRepos((prev) => {
        const next = new Set(prev);
        next.delete(repoKey);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        Loading image settings...
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">Pre-Built Images</h2>
        <p className="text-sm text-muted-foreground mb-6">
          Enable pre-built images to speed up sandbox creation. Images are rebuilt automatically
          when the default branch changes.
        </p>

        {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

        <div className="space-y-2">
          {repos.map((repo) => {
            const repoKey = repoImageBuildScopeIdFor(repo);
            const isEnabled = enabledRepos.has(repoKey);
            const isToggling = togglingRepos.has(repoKey);
            const isTriggering = triggeringRepos.has(repoKey);
            const image = getLatestImage(repo);

            return (
              <div
                key={repo.id}
                className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={(checked) => handleToggle(repo, checked)}
                    disabled={isToggling}
                    aria-label={`Toggle pre-built images for ${repo.owner}/${repo.name}`}
                  />
                  <span className="text-sm font-medium text-foreground truncate">
                    {repo.owner}/{repo.name}
                  </span>
                </div>

                <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                  <ImageBuildStatus
                    isEnabled={isEnabled}
                    image={
                      image && {
                        status: image.status,
                        createdAt: image.created_at,
                        readyDetails: formatReadyDetails(
                          parsePrimaryBuildSha(image.repository_shas),
                          image.build_duration_seconds
                        ),
                        errorMessage: image.error_message,
                      }
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleTrigger(repo)}
                    disabled={!isEnabled || isTriggering || image?.status === "building"}
                    title="Rebuild image"
                  >
                    <RefreshIcon className={`w-4 h-4 ${isTriggering ? "animate-spin" : ""}`} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {repos.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No repositories found. Add or authorize a source-control connection to get started.
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
