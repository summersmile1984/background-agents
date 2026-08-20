import { z } from "zod";
import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import { normalizeSourceControlBaseUrl } from "../connection-config";
import { SourceControlProviderError, parseProviderResponse } from "../errors";
import type {
  BuildGitPushSpecConfig,
  BuildManualPullRequestUrlConfig,
  CreatePullRequestConfig,
  CreatePullRequestResult,
  CredentialHelperAuth,
  GetPullRequestConfig,
  GetRepositoryConfig,
  GitPushAuthContext,
  GitPushSpec,
  PullRequestSnapshot,
  RepositoryAccessResult,
  RepositoryInfo,
  ServerOnlyGitAuth,
  ServerSideGitAuthProvider,
  SourceControlAuthContext,
  SourceControlProvider,
} from "../types";
import { USER_AGENT } from "./constants";
import type { GiteaProviderConfig } from "./types";

const GITEA_FETCH_TIMEOUT_MS = 15_000;
const GITEA_PAGE_SIZE = 50;
const MAX_GITEA_PAGES = 100;

const giteaOwnerSchema = z.object({ login: z.string().min(1) });
const giteaRepositorySchema = z.object({
  id: z.number().int().nonnegative(),
  owner: giteaOwnerSchema,
  name: z.string().min(1),
  full_name: z.string().min(1),
  description: z.string().nullable().optional(),
  private: z.boolean(),
  default_branch: z.string().nullable().optional(),
  archived: z.boolean().default(false),
  html_url: z.string().url(),
  clone_url: z.string().url(),
});
const giteaSearchResponseSchema = z.object({
  ok: z.boolean().optional(),
  data: z.array(giteaRepositorySchema),
});
const giteaCurrentUserSchema = z.object({
  id: z.number().int().nonnegative(),
  login: z.string().min(1),
});
const giteaBranchSchema = z.object({
  name: z.string().min(1),
  commit: z.object({ id: z.string().min(1) }),
});
const giteaPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().default(false),
  draft: z.boolean().default(false),
  head: z.object({ ref: z.string(), sha: z.string().nullable().optional() }),
  base: z.object({
    ref: z.string(),
    sha: z.string().nullable().optional(),
    repo: z.object({ id: z.number().int().nonnegative() }).optional(),
  }),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  merged_at: z.string().nullable().optional(),
});
const giteaVersionSchema = z.object({ version: z.string().min(1) });

function parseTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function encodeOwner(owner: string): string {
  return owner
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function encodeRepositoryPath(owner: string, name: string): string {
  return `${encodeOwner(owner)}/${encodeURIComponent(name)}`;
}

function hasNextPage(response: Response, pageItemCount: number, page: number): boolean {
  const link = response.headers.get("Link");
  if (link) return /rel="next"/.test(link);
  const totalRaw = response.headers.get("x-total-count");
  if (totalRaw) {
    const total = Number(totalRaw);
    if (Number.isFinite(total)) return page * GITEA_PAGE_SIZE < total;
  }
  return pageItemCount === GITEA_PAGE_SIZE;
}

export interface GiteaConnectionProbe {
  version: string;
  userId: string;
  login: string;
  visibleRepositoryCount: number;
}

/**
 * Gitea REST provider. The service PAT is used only inside the control plane.
 * Legacy direct-push/helper methods fail closed so a long-lived PAT can never
 * be returned to the sandbox by accident.
 */
export class GiteaSourceControlProvider
  implements SourceControlProvider, ServerSideGitAuthProvider
{
  readonly name = "gitea" as const;

  private readonly baseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly accessToken: string;
  private readonly username: string;
  private readonly userAgent: string;

  constructor(config: GiteaProviderConfig) {
    this.baseUrl = normalizeSourceControlBaseUrl(config.baseUrl);
    this.apiBaseUrl = normalizeSourceControlBaseUrl(config.apiBaseUrl ?? `${this.baseUrl}/api/v1`);
    if (new URL(this.baseUrl).origin !== new URL(this.apiBaseUrl).origin) {
      throw new SourceControlProviderError(
        "Gitea API URL must use the connection origin.",
        "permanent"
      );
    }
    this.accessToken = config.accessToken.trim();
    this.username = config.username.trim();
    this.userAgent = config.userAgent?.trim() || USER_AGENT;
    if (!this.accessToken || !this.username) {
      throw new SourceControlProviderError(
        "Gitea service username and access token are required.",
        "permanent"
      );
    }
  }

  private headers(token: string = this.accessToken, oauth = false): Record<string, string> {
    return {
      Accept: "application/json",
      Authorization: `${oauth ? "Bearer" : "token"} ${token}`,
      "User-Agent": this.userAgent,
    };
  }

  private repositoryUrl(value: string, label: string): string {
    const normalized = normalizeSourceControlBaseUrl(value.replace(/\.git$/, ""));
    const base = new URL(this.baseUrl);
    const candidate = new URL(normalized);
    const basePath = base.pathname.replace(/\/+$/, "");
    if (
      candidate.origin !== base.origin ||
      (basePath &&
        candidate.pathname !== basePath &&
        !candidate.pathname.startsWith(`${basePath}/`))
    ) {
      throw new SourceControlProviderError(
        `Gitea ${label} URL is outside the configured connection base.`,
        "permanent"
      );
    }
    return value;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITEA_FETCH_TIMEOUT_MS);
    try {
      return await fetch(`${this.apiBaseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(), ...init.headers },
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async probe(): Promise<GiteaConnectionProbe> {
    const [versionResponse, userResponse] = await Promise.all([
      this.request("/version"),
      this.request("/user"),
    ]);
    if (!versionResponse.ok || !userResponse.ok) {
      throw new SourceControlProviderError(
        `Gitea connection probe failed (${versionResponse.status}/${userResponse.status}).`,
        versionResponse.status >= 500 || userResponse.status >= 500 ? "transient" : "permanent"
      );
    }
    const [version, user] = await Promise.all([
      parseProviderResponse(versionResponse, giteaVersionSchema, "Invalid Gitea version response"),
      parseProviderResponse(userResponse, giteaCurrentUserSchema, "Invalid Gitea user response"),
    ]);
    const params = new URLSearchParams({
      uid: String(user.id),
      private: "true",
      exclusive: "false",
      page: "1",
      limit: "1",
    });
    const repositoriesResponse = await this.request(`/repos/search?${params}`);
    if (!repositoriesResponse.ok) {
      throw SourceControlProviderError.fromFetchError(
        `Gitea repository-scope probe failed (${repositoriesResponse.status}).`,
        new Error("Gitea repository-scope probe failed"),
        repositoriesResponse.status
      );
    }
    const repositories = await parseProviderResponse(
      repositoriesResponse,
      giteaSearchResponseSchema,
      "Invalid Gitea repository search response"
    );
    const total = Number(repositoriesResponse.headers.get("x-total-count"));
    return {
      version: version.version,
      userId: String(user.id),
      login: user.login,
      visibleRepositoryCount: Number.isFinite(total) ? total : repositories.data.length,
    };
  }

  async getRepository(
    auth: SourceControlAuthContext,
    config: GetRepositoryConfig
  ): Promise<RepositoryInfo> {
    const response = await this.request(
      `/repos/${encodeRepositoryPath(config.owner, config.name)}`,
      { headers: this.headers(auth.token, auth.authType === "oauth") }
    );
    if (!response.ok) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to get Gitea repository (${response.status}).`,
        new Error("Gitea repository request failed"),
        response.status
      );
    }
    const repository = await parseProviderResponse(
      response,
      giteaRepositorySchema,
      "Invalid Gitea repository response"
    );
    if (!repository.default_branch) {
      throw new SourceControlProviderError(
        "Gitea repository has no readable default branch.",
        "permanent"
      );
    }
    return {
      owner: repository.owner.login,
      name: repository.name,
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
      isPrivate: repository.private,
      providerRepoId: repository.id,
    };
  }

  async createPullRequest(
    auth: SourceControlAuthContext,
    config: CreatePullRequestConfig
  ): Promise<CreatePullRequestResult> {
    const response = await this.request(
      `/repos/${encodeRepositoryPath(config.repository.owner, config.repository.name)}/pulls`,
      {
        method: "POST",
        headers: {
          ...this.headers(auth.token, auth.authType === "oauth"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: config.title,
          body: config.body,
          head: config.sourceBranch,
          base: config.targetBranch,
        }),
      }
    );
    if (!response.ok) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to create Gitea pull request (${response.status}).`,
        new Error("Gitea pull-request creation failed"),
        response.status
      );
    }
    const pullRequest = await parseProviderResponse(
      response,
      giteaPullRequestSchema,
      "Invalid Gitea create pull request response"
    );
    return {
      id: pullRequest.number,
      webUrl: pullRequest.html_url,
      apiUrl: pullRequest.url,
      lifecycleState: pullRequest.merged
        ? "merged"
        : pullRequest.state === "open"
          ? "open"
          : "closed",
      isDraft: pullRequest.state === "open" && pullRequest.draft,
      sourceBranch: pullRequest.head.ref,
      targetBranch: pullRequest.base.ref,
      headSha: pullRequest.head.sha ?? undefined,
      repositoryExternalId: pullRequest.base.repo?.id
        ? String(pullRequest.base.repo.id)
        : String(config.repository.providerRepoId),
      providerUpdatedAt: parseTimestamp(pullRequest.updated_at),
    };
  }

  async checkRepositoryAccess(config: GetRepositoryConfig): Promise<RepositoryAccessResult | null> {
    const response = await this.request(
      `/repos/${encodeRepositoryPath(config.owner, config.name)}`
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to check Gitea repository access (${response.status}).`,
        new Error("Gitea repository access request failed"),
        response.status
      );
    }
    const repository = await parseProviderResponse(
      response,
      giteaRepositorySchema,
      "Invalid Gitea repository access response"
    );
    if (repository.archived || !repository.default_branch) return null;
    return {
      repoId: repository.id,
      repoOwner: repository.owner.login.toLowerCase(),
      repoName: repository.name.toLowerCase(),
      defaultBranch: repository.default_branch,
    };
  }

  async listRepositories(): Promise<InstallationRepository[]> {
    const userResponse = await this.request("/user");
    if (!userResponse.ok) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to read Gitea service user (${userResponse.status}).`,
        new Error("Gitea service-user request failed"),
        userResponse.status
      );
    }
    const user = await parseProviderResponse(
      userResponse,
      giteaCurrentUserSchema,
      "Invalid Gitea user response"
    );

    const repositories: InstallationRepository[] = [];
    for (let page = 1; page <= MAX_GITEA_PAGES; page += 1) {
      const params = new URLSearchParams({
        uid: String(user.id),
        private: "true",
        exclusive: "false",
        page: String(page),
        limit: String(GITEA_PAGE_SIZE),
      });
      const response = await this.request(`/repos/search?${params}`);
      if (!response.ok) {
        throw SourceControlProviderError.fromFetchError(
          `Failed to list Gitea repositories (${response.status}).`,
          new Error("Gitea repository catalog request failed"),
          response.status
        );
      }
      const result = await parseProviderResponse(
        response,
        giteaSearchResponseSchema,
        "Invalid Gitea repository search response"
      );
      repositories.push(
        ...result.data
          .filter((repository) => !repository.archived && Boolean(repository.default_branch))
          .map((repository) => ({
            id: repository.id,
            owner: repository.owner.login,
            name: repository.name,
            fullName: repository.full_name,
            description: repository.description ?? null,
            private: repository.private,
            defaultBranch: repository.default_branch!,
            archived: repository.archived,
            webUrl: this.repositoryUrl(repository.html_url, "web"),
            cloneUrl: this.repositoryUrl(repository.clone_url, "clone"),
          }))
      );
      if (!hasNextPage(response, result.data.length, page)) return repositories;
    }

    throw new SourceControlProviderError(
      `Gitea repository catalog exceeded ${MAX_GITEA_PAGES} pages.`,
      "permanent"
    );
  }

  async listBranches(config: GetRepositoryConfig): Promise<{ name: string }[]> {
    const branches: { name: string }[] = [];
    for (let page = 1; page <= MAX_GITEA_PAGES; page += 1) {
      const response = await this.request(
        `/repos/${encodeRepositoryPath(config.owner, config.name)}/branches?page=${page}&limit=${GITEA_PAGE_SIZE}`
      );
      if (!response.ok) {
        throw SourceControlProviderError.fromFetchError(
          `Failed to list Gitea branches (${response.status}).`,
          new Error("Gitea branch catalog request failed"),
          response.status
        );
      }
      const pageBranches = await parseProviderResponse(
        response,
        z.array(giteaBranchSchema),
        "Invalid Gitea branch list response"
      );
      branches.push(...pageBranches.map((branch) => ({ name: branch.name })));
      if (!hasNextPage(response, pageBranches.length, page)) return branches;
    }
    throw new SourceControlProviderError(
      `Gitea branch catalog exceeded ${MAX_GITEA_PAGES} pages.`,
      "permanent"
    );
  }

  async getBranchHead(config: GetRepositoryConfig & { branch: string }): Promise<string | null> {
    const response = await this.request(
      `/repos/${encodeRepositoryPath(config.owner, config.name)}/branches/${encodeURIComponent(config.branch)}`
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to resolve Gitea branch head (${response.status}).`,
        new Error("Gitea branch request failed"),
        response.status
      );
    }
    const branch = await parseProviderResponse(
      response,
      giteaBranchSchema,
      "Invalid Gitea branch response"
    );
    return branch.commit.id;
  }

  async getPullRequest(config: GetPullRequestConfig): Promise<PullRequestSnapshot> {
    let owner = config.owner;
    let name = config.name;
    let response = await this.request(
      `/repos/${encodeRepositoryPath(owner, name)}/pulls/${config.number}`
    );
    if (response.status === 404 && config.repositoryExternalId) {
      const repositoryResponse = await this.request(
        `/repositories/${encodeURIComponent(config.repositoryExternalId)}`
      );
      if (repositoryResponse.ok) {
        const repository = await parseProviderResponse(
          repositoryResponse,
          giteaRepositorySchema,
          "Invalid Gitea repository-by-id response"
        );
        owner = repository.owner.login;
        name = repository.name;
        response = await this.request(
          `/repos/${encodeRepositoryPath(owner, name)}/pulls/${config.number}`
        );
      }
    }
    if (!response.ok) {
      throw SourceControlProviderError.fromFetchError(
        `Failed to get Gitea pull request (${response.status}).`,
        new Error("Gitea pull-request request failed"),
        response.status
      );
    }
    const pullRequest = await parseProviderResponse(
      response,
      giteaPullRequestSchema,
      "Invalid Gitea pull request response"
    );
    const lifecycleState = pullRequest.merged
      ? "merged"
      : pullRequest.state === "open"
        ? "open"
        : "closed";
    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      lifecycleState,
      isDraft: lifecycleState === "open" && pullRequest.draft,
      headBranch: pullRequest.head.ref,
      baseBranch: pullRequest.base.ref,
      headSha: pullRequest.head.sha ?? undefined,
      repoOwner: owner,
      repoName: name,
      repositoryExternalId: pullRequest.base.repo?.id
        ? String(pullRequest.base.repo.id)
        : config.repositoryExternalId,
      providerCreatedAt: parseTimestamp(pullRequest.created_at),
      providerUpdatedAt: parseTimestamp(pullRequest.updated_at),
      mergedAt: parseTimestamp(pullRequest.merged_at),
      closedAt: parseTimestamp(pullRequest.closed_at),
    };
  }

  async getUpstreamGitAuthorization(_operation: "read" | "write"): Promise<ServerOnlyGitAuth> {
    return { username: this.username, password: this.accessToken };
  }

  async getServiceApiAuthorization(): Promise<SourceControlAuthContext> {
    return { authType: "pat", token: this.accessToken };
  }

  async generatePushAuth(): Promise<GitPushAuthContext> {
    throw new SourceControlProviderError(
      "Gitea Git operations require the server-side Git proxy.",
      "permanent"
    );
  }

  async generateCredentialHelperAuth(): Promise<CredentialHelperAuth> {
    throw new SourceControlProviderError(
      "Gitea PATs cannot be released through the sandbox credential helper.",
      "permanent"
    );
  }

  buildManualPullRequestUrl(config: BuildManualPullRequestUrlConfig): string {
    const repositoryPath = encodeRepositoryPath(config.owner, config.name);
    return `${this.baseUrl}/${repositoryPath}/compare/${encodeURIComponent(
      config.targetBranch
    )}...${encodeURIComponent(config.sourceBranch)}`;
  }

  buildGitPushSpec(_config: BuildGitPushSpecConfig): GitPushSpec {
    throw new SourceControlProviderError(
      "Gitea push specifications are built by the server-side Git proxy.",
      "permanent"
    );
  }
}

export function createGiteaProvider(config: GiteaProviderConfig): GiteaSourceControlProvider {
  return new GiteaSourceControlProvider(config);
}
