/**
 * Source control provider module.
 *
 * Provides a pluggable abstraction for source control platforms
 * (GitHub, GitLab, Bitbucket) enabling unit testing and future provider support.
 */

// Types
export type {
  SourceControlProvider,
  SourceControlProviderName,
  SourceControlAuthContext,
  GitPushAuthContext,
  BuildManualPullRequestUrlConfig,
  BuildGitPushSpecConfig,
  GitPushSpec,
  RepositoryInfo,
  GetRepositoryConfig,
  CreatePullRequestConfig,
  CreatePullRequestResult,
  PullRequestSnapshot,
  RepositoryAccessResult,
  ServerOnlyGitAuth,
  ServerSideGitAuthProvider,
  ServerSideApiAuthProvider,
} from "./types";
export { supportsServerSideApiAuth, supportsServerSideGitAuth } from "./types";

// Errors
export type { SourceControlErrorType } from "./errors";
export { SourceControlProviderError } from "./errors";
export { DEFAULT_SCM_PROVIDER, resolveScmProviderFromEnv } from "./config";
export { createSourceControlProviderFromEnv } from "./provider-from-env";

// Providers
export {
  GitHubSourceControlProvider,
  createGitHubProvider,
  GiteaSourceControlProvider,
  createGiteaProvider,
  createSourceControlProvider,
  type GiteaProviderConfig,
  type GitHubProviderConfig,
  type SourceControlProviderFactoryConfig,
} from "./providers";
