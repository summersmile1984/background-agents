import { resolveBuildTimeoutSeconds } from "@open-inspect/shared/types/integrations";
import { createLogger, type CorrelationContext } from "../logger";
import { createSourceControlProviderFromEnv, resolveScmProviderFromEnv } from "../source-control";
import { scmCloneIdentity } from "../sandbox/sandbox-env";
import {
  prepareManagedProviderEnv,
  stripHarnessCredentialsForImageBuild,
} from "../sandbox/managed-provider-env";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import {
  generateImageBuildCallbackToken,
  hashImageBuildCallbackToken,
  IMAGE_BUILD_CALLBACK_TOKEN_TTL_MS,
} from "./callback-auth";
import type { ImageBuildScope } from "./model";
import {
  loadScopeBuildSecrets,
  resolveScopeSandboxSettings,
  resolveScopeTarget,
  type ResolvedImageBuildTarget,
} from "./scope";
import type { ImageBuildCloneAuth, ImageBuildPlan } from "./types";
import { ScmGitCapabilityStore } from "../db/scm-git-capabilities";

const logger = createLogger("image-builds:planner");
const MS_PER_SECOND = 1000;
const IMAGE_BUILD_GIT_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1000;

/** The single-use callback token every build authenticates with (planner mints, workflow verifies). */
export interface PlannedCallbackAuth {
  token: string;
  tokenHash: string;
  expiresAt: number;
}

export type { ResolvedImageBuildTarget } from "./scope";

/**
 * Resolves a trigger request into a concrete provider build plan.
 *
 * The planner is the only image-build layer that loads secrets, and it leans
 * on scope.ts for everything kind-specific. Split deliberately: resolveTarget
 * and createCallbackAuth run BEFORE the build row is registered (cheap D1
 * read + pure crypto), while planBuild — which decrypts secrets — runs AFTER,
 * so a concurrent secret change always sees a row to supersede and the
 * build's now-stale secrets can never reach a still-selectable image.
 * Build-time secrets are the same set the scope's sessions get, and the build
 * timeout honors the primary repository's sandbox settings with the scope's
 * own overrides layered on top.
 */
export class ImageBuildPlanner {
  constructor(
    private readonly env: Env,
    private readonly db: SqlDatabase
  ) {}

  async resolveTarget(scope: ImageBuildScope): Promise<ResolvedImageBuildTarget> {
    return resolveScopeTarget(this.env, this.db, scope);
  }

  async createCallbackAuth(): Promise<PlannedCallbackAuth> {
    const token = generateImageBuildCallbackToken();
    return {
      token,
      tokenHash: await hashImageBuildCallbackToken(token, this.env),
      expiresAt: Date.now() + IMAGE_BUILD_CALLBACK_TOKEN_TTL_MS,
    };
  }

  async planBuild(params: {
    buildId: string;
    scope: ImageBuildScope;
    callbackUrl: string;
    failureCallbackUrl: string;
    correlation: CorrelationContext;
    target: ResolvedImageBuildTarget;
    callbackAuth: PlannedCallbackAuth;
  }): Promise<ImageBuildPlan> {
    const { repositories, repositoriesFingerprint } = params.target;
    const primary = repositories[0];

    const [sandboxSettings, userEnvVars, cloneAuth] = await Promise.all([
      resolveScopeSandboxSettings(this.db, params.scope, primary),
      loadScopeBuildSecrets(this.env, this.db, params.scope, params.target),
      this.resolveCloneAuth(params.buildId, params.scope, params.target),
    ]);

    const basePlan = {
      buildId: params.buildId,
      scope: params.scope,
      repositories,
      repositoriesFingerprint,
      callbackUrl: params.callbackUrl,
      failureCallbackUrl: params.failureCallbackUrl,
      buildTimeoutMs: resolveBuildTimeoutSeconds(sandboxSettings) * MS_PER_SECOND,
      userEnvVars: userEnvVars
        ? stripHarnessCredentialsForImageBuild(
            prepareManagedProviderEnv({ exposedSecrets: userEnvVars, brokerSecrets: userEnvVars })
          )
        : undefined,
      correlation: {
        trace_id: params.correlation.trace_id,
        request_id: params.correlation.request_id,
      },
    };

    return {
      ...basePlan,
      callbackToken: params.callbackAuth.token,
      cloneAuth,
    };
  }

  private async resolveCloneAuth(
    buildId: string,
    scope: ImageBuildScope,
    target: ResolvedImageBuildTarget
  ): Promise<ImageBuildCloneAuth> {
    try {
      const stable = target.repositories.filter(
        (repository) => repository.repositoryKey && repository.connectionId
      );
      if (stable.length > 0) {
        if (stable.length !== target.repositories.length) {
          throw new Error("Image build target has incomplete source-control identity");
        }
        const connectionIds = new Set(stable.map((repository) => repository.connectionId!));
        if (connectionIds.size !== 1) {
          throw new Error("Image build target mixes source-control connections");
        }
        if (!this.env.WORKER_URL) throw new Error("WORKER_URL is required for SCM build proxy");
        const cloneBaseUrl = `${this.env.WORKER_URL.replace(/\/+$/, "")}/git/build/${encodeURIComponent(buildId)}`;
        const capability = await new ScmGitCapabilityStore(this.db).issue({
          audience: "image_build_git",
          subjectId: buildId,
          connectionId: [...connectionIds][0],
          repositoryIds: stable.map((repository) => repository.repositoryKey!),
          allowedOperation: "read",
          expiresAt: Date.now() + IMAGE_BUILD_GIT_CAPABILITY_TTL_MS,
        });
        return {
          type: "credential_helper",
          host: new URL(cloneBaseUrl).host,
          username: capability,
          token: capability,
          cloneBaseUrl,
        };
      }
      const provider = createSourceControlProviderFromEnv(this.env);
      const auth = await provider.generateCredentialHelperAuth();
      return {
        type: "credential_helper",
        host: scmCloneIdentity(resolveScmProviderFromEnv(this.env.SCM_PROVIDER)).host,
        username: auth.username,
        token: auth.password,
      };
    } catch (e) {
      logger.warn("image_build.clone_token_failed", {
        error: e instanceof Error ? e.message : String(e),
        scope_kind: scope.kind,
        scope_id: scope.id,
      });
      return { type: "unavailable" };
    }
  }
}
