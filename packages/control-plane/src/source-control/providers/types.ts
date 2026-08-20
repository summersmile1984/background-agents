/**
 * Provider-specific types.
 */

import type { GitHubAppConfig } from "../../auth/github-app";
import type { CacheStore } from "@open-inspect/shared/cache-store";

/**
 * Configuration for GitHubSourceControlProvider.
 */
export interface GitHubProviderConfig {
  /** GitHub App configuration (required for push auth) */
  appConfig?: GitHubAppConfig;
  /** Cache store for caching installation tokens */
  cacheStore?: CacheStore;
  /** User-Agent value sent on outbound GitHub API requests */
  userAgent?: string;
}

/**
 * Configuration for GitLabSourceControlProvider.
 */
export interface GitLabProviderConfig {
  /** Personal access token for GitLab API access */
  accessToken: string;
  /** GitLab group namespace to scope repository listing (optional) */
  namespace?: string;
  /** User-Agent value sent on outbound GitLab API requests */
  userAgent?: string;
}

/** Configuration for one self-hosted Gitea connection. */
export interface GiteaProviderConfig {
  /** Normalized Gitea root URL, including an optional reverse-proxy path. */
  baseUrl: string;
  /** API root. Defaults to `${baseUrl}/api/v1`. */
  apiBaseUrl?: string;
  /** Dedicated service-account PAT. */
  accessToken: string;
  /** Service account login used as the Git HTTP username. */
  username: string;
  /** User-Agent value sent on outbound Gitea API requests. */
  userAgent?: string;
}
