import { resolveAppName } from "@open-inspect/shared/app-name";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import type { SourceControlCapabilities } from "@open-inspect/shared/types/source-control";
import { getGitHubAppConfig } from "../auth/github-app";
import {
  ScmConnectionCredentialStore,
  ScmConnectionStore,
  type CreateScmConnectionInput,
  type ScmConnectionRecord,
} from "../db/scm-connections";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { resolveScmProviderFromEnv } from "./config";
import { SourceControlProviderError } from "./errors";
import { createSourceControlProvider } from "./providers";
import type { SourceControlProvider } from "./types";

export const GITHUB_CAPABILITIES: SourceControlCapabilities = {
  listRepositories: true,
  listBranches: true,
  createPullRequest: true,
  draftPullRequest: true,
  userOAuth: true,
  webhooks: true,
  commitSigning: true,
  repositoryById: true,
};

export const GITEA_CAPABILITIES: SourceControlCapabilities = {
  listRepositories: true,
  listBranches: true,
  createPullRequest: true,
  draftPullRequest: false,
  userOAuth: false,
  webhooks: false,
  commitSigning: false,
  repositoryById: true,
};

export const GITLAB_CAPABILITIES: SourceControlCapabilities = {
  listRepositories: true,
  listBranches: true,
  createPullRequest: true,
  draftPullRequest: true,
  userOAuth: false,
  webhooks: false,
  commitSigning: false,
  repositoryById: true,
};

export interface ResolvedSourceControlConnection {
  connection: ScmConnectionRecord;
  provider: SourceControlProvider;
}

export class ScmConnectionNotFoundError extends Error {
  constructor(id: string) {
    super(`SCM connection '${id}' was not found`);
    this.name = "ScmConnectionNotFoundError";
  }
}

export class ScmConnectionDisabledError extends Error {
  constructor(id: string) {
    super(`SCM connection '${id}' is disabled`);
    this.name = "ScmConnectionDisabledError";
  }
}

interface RegistryDependencies {
  db?: SqlDatabase;
  connections?: ScmConnectionStore;
  credentials?: ScmConnectionCredentialStore;
}

/**
 * Resolves a durable connection record into a provider instance. Provider
 * instances are cached only for one connection revision, so credential/config
 * replacement invalidates them without persisting decrypted secrets.
 */
export class SourceControlConnectionRegistry {
  private readonly connections: ScmConnectionStore;
  private readonly credentials: ScmConnectionCredentialStore;
  private readonly cache = new Map<string, { revision: number; provider: SourceControlProvider }>();

  constructor(
    private readonly env: Env,
    dependencies: RegistryDependencies = {}
  ) {
    if (!dependencies.db && (!dependencies.connections || !dependencies.credentials)) {
      throw new Error("SourceControlConnectionRegistry requires an injected database or stores");
    }
    this.connections = dependencies.connections ?? new ScmConnectionStore(dependencies.db!);
    this.credentials =
      dependencies.credentials ??
      new ScmConnectionCredentialStore(dependencies.db!, env.TOKEN_ENCRYPTION_KEY);
  }

  async getConnection(id: string): Promise<ResolvedSourceControlConnection> {
    const connection = await this.connections.get(id);
    if (!connection) throw new ScmConnectionNotFoundError(id);
    if (!connection.enabled) throw new ScmConnectionDisabledError(id);
    return { connection, provider: await this.providerFor(connection) };
  }

  async getDefaultConnection(): Promise<ResolvedSourceControlConnection> {
    const connection =
      (await this.connections.getDefault()) ?? (await this.bootstrapLegacyDefault());
    if (!connection) {
      throw new SourceControlProviderError(
        "No enabled default source-control connection is configured.",
        "permanent"
      );
    }
    return { connection, provider: await this.providerFor(connection) };
  }

  private async providerFor(connection: ScmConnectionRecord): Promise<SourceControlProvider> {
    const cached = this.cache.get(connection.id);
    if (cached?.revision === connection.revision) return cached.provider;

    const userAgent = resolveAppName(this.env);
    let provider: SourceControlProvider;
    switch (connection.provider) {
      case "github": {
        const appConfig = getGitHubAppConfig(this.env);
        provider = createSourceControlProvider({
          provider: "github",
          github: {
            appConfig: appConfig ?? undefined,
            cacheStore: createKvCacheStore(this.env.REPOS_CACHE),
            userAgent,
          },
        });
        break;
      }
      case "gitea": {
        const accessToken = await this.readServiceToken(connection);
        if (!connection.username) {
          throw new SourceControlProviderError(
            `Gitea connection '${connection.id}' has no service username.`,
            "permanent"
          );
        }
        provider = createSourceControlProvider({
          provider: "gitea",
          gitea: {
            baseUrl: connection.baseUrl,
            apiBaseUrl: connection.apiBaseUrl,
            accessToken,
            username: connection.username,
            userAgent,
          },
        });
        break;
      }
      case "gitlab": {
        provider = createSourceControlProvider({
          provider: "gitlab",
          gitlab: {
            accessToken: await this.readServiceToken(connection),
            userAgent,
          },
        });
        break;
      }
      case "bitbucket":
        provider = createSourceControlProvider({ provider: "bitbucket" });
        break;
      default: {
        const exhaustive: never = connection.provider;
        throw new SourceControlProviderError(
          `Unsupported source-control connection provider: ${String(exhaustive)}`,
          "permanent"
        );
      }
    }

    this.cache.set(connection.id, { revision: connection.revision, provider });
    return provider;
  }

  private async readServiceToken(connection: ScmConnectionRecord): Promise<string> {
    if (connection.credentialSource === "encrypted_d1") {
      const credential = await this.credentials.get(connection.id, "service_token");
      if (
        !credential?.secret ||
        (credential.expiresAt != null && credential.expiresAt <= Date.now())
      ) {
        throw new SourceControlProviderError(
          `SCM connection '${connection.id}' has no usable service credential.`,
          "permanent"
        );
      }
      return credential.secret;
    }

    switch (connection.credentialRef) {
      case "gitea_access_token":
        if (this.env.GITEA_ACCESS_TOKEN) return this.env.GITEA_ACCESS_TOKEN;
        break;
      case "gitlab_access_token":
        if (this.env.GITLAB_ACCESS_TOKEN) return this.env.GITLAB_ACCESS_TOKEN;
        break;
    }
    throw new SourceControlProviderError(
      `SCM connection '${connection.id}' references an unavailable worker credential.`,
      "permanent"
    );
  }

  /**
   * Compatibility bootstrap for a pre-connection deployment. It runs only
   * while the connection table is empty; an operator-created connection set
   * without a default is never guessed or mutated.
   */
  private async bootstrapLegacyDefault(): Promise<ScmConnectionRecord | null> {
    const existing = await this.connections.list({ includeDisabled: true });
    if (existing.length > 0) return null;

    const provider = resolveScmProviderFromEnv(this.env.SCM_PROVIDER);
    const common = {
      id: `scm_${provider}_default`,
      provider,
      displayName: provider === "github" ? "GitHub" : provider === "gitea" ? "Gitea" : "GitLab",
      enabled: true,
      isDefault: true,
      createdBy: "system:legacy-bootstrap",
    } as const;
    let input: CreateScmConnectionInput;

    switch (provider) {
      case "github":
        input = {
          ...common,
          baseUrl: "https://github.com",
          apiBaseUrl: "https://api.github.com",
          cloneBaseUrl: "https://github.com",
          authMode: "github_app",
          credentialSource: "worker_binding",
          credentialRef: "github_app",
          username: "x-access-token",
          capabilities: GITHUB_CAPABILITIES,
        };
        break;
      case "gitea": {
        if (!this.env.GITEA_BASE_URL || !this.env.GITEA_ACCESS_TOKEN || !this.env.GITEA_USERNAME) {
          throw new SourceControlProviderError(
            "Legacy Gitea deployment requires GITEA_BASE_URL, GITEA_ACCESS_TOKEN, and GITEA_USERNAME.",
            "permanent"
          );
        }
        const baseUrl = this.env.GITEA_BASE_URL.replace(/\/+$/, "");
        input = {
          ...common,
          baseUrl,
          apiBaseUrl: `${baseUrl}/api/v1`,
          cloneBaseUrl: baseUrl,
          authMode: "pat",
          credentialSource: "worker_binding",
          credentialRef: "gitea_access_token",
          username: this.env.GITEA_USERNAME,
          capabilities: GITEA_CAPABILITIES,
        };
        break;
      }
      case "gitlab":
        if (!this.env.GITLAB_ACCESS_TOKEN) {
          throw new SourceControlProviderError(
            "Legacy GitLab deployment requires GITLAB_ACCESS_TOKEN.",
            "permanent"
          );
        }
        input = {
          ...common,
          baseUrl: "https://gitlab.com",
          apiBaseUrl: "https://gitlab.com/api/v4",
          cloneBaseUrl: "https://gitlab.com",
          authMode: "pat",
          credentialSource: "worker_binding",
          credentialRef: "gitlab_access_token",
          username: "oauth2",
          capabilities: GITLAB_CAPABILITIES,
        };
        break;
      case "bitbucket":
        throw new SourceControlProviderError(
          "SCM provider 'bitbucket' is configured but not implemented.",
          "permanent"
        );
      default: {
        const exhaustive: never = provider;
        throw new SourceControlProviderError(
          `Unsupported legacy SCM provider: ${String(exhaustive)}`,
          "permanent"
        );
      }
    }

    try {
      return await this.connections.create(input);
    } catch (error) {
      // Another isolate may have won the bootstrap insert. Re-read the
      // authority instead of relying on provider-specific SQL error strings.
      const raced = await this.connections.getDefault();
      if (raced) return raced;
      throw error;
    }
  }
}
