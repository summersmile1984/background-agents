/**
 * E2B sandbox provider — calls the E2B REST API directly.
 *
 * Stop is a resumable pause (like Daytona's stop), so the shared lifecycle
 * manager's persistent-resume path drives idle-pause and resume with no
 * E2B-specific plumbing. Sandboxes are created with auto-pause (a lapsed TTL pauses
 * recoverably rather than killing) and secure envd access; provider-side auto-resume is
 * disabled so resume stays control-plane-driven (connectSandbox) and stray traffic can't
 * wake a paused box. Per-session env is delivered via an envd file write because the
 * template's start command runs at build time.
 */

import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { createLogger } from "../../logger";
import {
  buildSandboxEnvVars,
  deriveCodeServerPassword,
  deriveVncPassword,
  prepareE2BCreateTimeEnv,
  scmCloneIdentityForConfig,
} from "../sandbox-env";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";
import type { SourceControlProviderName } from "../../source-control";
import type { E2BRestClient, E2BSandboxCreated, E2BSandboxDetail } from "../e2b-rest-client";
import { E2BApiError, E2BConflictError, E2BNotFoundError } from "../e2b-rest-client";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  createVncAccess,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
} from "../provider";

const log = createLogger("e2b-provider");

/** Sandbox TTL default. Hobby plans (~1h cap) should lower this via config. */
export const DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS = DEFAULT_SANDBOX_TIMEOUT_SECONDS;
/** Default to a recoverable stop: pause on TTL (not kill), so it stays resumable. */
export const DEFAULT_E2B_AUTO_PAUSE = true;
/** Cube's create response can precede an early shim exit; observe it past that window. */
export const DEFAULT_E2B_CREATE_TIME_ENV_VERIFY_DELAY_MS = 8_000;
/** One transparent replacement makes an intermittent Cube restore failure self-healing. */
export const DEFAULT_E2B_CREATE_TIME_ENV_MAX_ATTEMPTS = 2;

const CUBE_TERMINAL_LIFECYCLE_MARKERS = [
  /wait container[\s\S]{0,256}?exit code\s*[:=]?\s*\d+/i,
  /taskexit(?: event)?/i,
  /destroy sandbox/i,
  /shutdown sandbox/i,
];

class E2BRuntimeStartupError extends Error {
  constructor(
    message: string,
    readonly definitive: boolean,
    cause?: Error
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "E2BRuntimeStartupError";
  }
}

export interface E2BProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Secret used for domain-separated sandbox access password derivation. */
  sandboxAccessPasswordSecret: string;
  sandboxTimeoutSeconds: number;
  /**
   * Pause (not kill) when the sandbox TTL expires, so it stays resumable. Resume is
   * control-plane-driven (connectSandbox); provider-side auto-resume is not used.
   */
  autoPause: boolean;
  /**
   * Inject per-session env through POST /sandboxes for compatible self-hosted
   * backends such as CubeSandbox, whose launcher starts fresh on each create.
   */
  useCreateTimeEnv?: boolean;
  /** Internal/test override for Cube's post-create observation window. */
  createTimeEnvVerifyDelayMs?: number;
  /** Internal/test override for bounded Cube startup replacement attempts. */
  createTimeEnvMaxAttempts?: number;
  /**
   * Optional trusted HTTPS gateway used for user-facing service previews.
   * The gateway must route `/sandbox/:providerObjectId/:port/` to the
   * corresponding E2B-compatible sandbox service.
   */
  previewBaseUrl?: string;
  /** Provider-level LLM environment vars merged into every sandbox (e.g. API keys). */
  llmEnvVars?: Record<string, string | undefined>;
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b";

  /**
   * Stop reasons after which the provider object cannot be resumed, including
   * replacement by a newly-created sandbox.
   */
  private static readonly TERMINAL_STOP_REASONS = new Set([
    "connecting_timeout",
    "pending_dispatch_timeout",
    "prompt_dispatch_send_failed",
    "runtime_failure",
    "stop_confirmation_timeout",
    "stop_send_failed",
    "respawn",
    // Session-end reasons: an ended session can never resume, so pausing would
    // leak a provider-side object indefinitely.
    "archived",
    "cancelled",
    "failed",
  ]);

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: true,
    supportsSnapshots: false,
    supportsRestore: false,
    // Stop is a resumable pause; the manager treats it as provider-managed state.
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: E2BRestClient,
    private readonly providerConfig: E2BProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    const useCreateTimeEnv = this.providerConfig.useCreateTimeEnv ?? false;
    const maxAttempts = useCreateTimeEnv
      ? Math.max(
          1,
          this.providerConfig.createTimeEnvMaxAttempts ?? DEFAULT_E2B_CREATE_TIME_ENV_MAX_ATTEMPTS
        )
      : 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.createSandboxAttempt(config, useCreateTimeEnv);
      } catch (error) {
        lastError = error;
        if (!(error instanceof E2BRuntimeStartupError) || attempt >= maxAttempts) break;
        log.warn("e2b.create_time_runtime_retry", {
          attempt,
          max_attempts: maxAttempts,
          session_id: config.sessionId,
          // The error is intentionally summarized; lifecycle logs may contain secrets.
          reason: error.message,
        });
      }
    }

    throw this.classifyError("Failed to create E2B sandbox", lastError, "create");
  }

  private async createSandboxAttempt(
    config: CreateSandboxConfig,
    useCreateTimeEnv: boolean
  ): Promise<CreateSandboxResult> {
    try {
      const codeServerPassword = config.codeServerEnabled
        ? await deriveCodeServerPassword(
            config.sandboxId,
            this.providerConfig.sandboxAccessPasswordSecret
          )
        : undefined;
      const vncPassword = config.vncEnabled
        ? await deriveVncPassword(config.sandboxId, this.providerConfig.sandboxAccessPasswordSecret)
        : undefined;
      const timeoutSeconds = config.timeoutSeconds ?? this.providerConfig.sandboxTimeoutSeconds;
      const envVars = buildSandboxEnvVars(
        { ...config, timeoutSeconds },
        {
          scmIdentity: scmCloneIdentityForConfig(
            this.providerConfig.scmProvider,
            config.scmGitProxyBaseUrl
          ),
          codeServerPassword,
          vncPassword,
        }
      );
      for (const [key, value] of Object.entries(this.providerConfig.llmEnvVars ?? {})) {
        if (value) envVars[key] = value;
      }
      // E2B sandboxes run as a non-root user and /run is a root-owned tmpfs, so
      // the git credential helper can't create its default cache dir (/run/oi)
      // and fails before brokering a token. Point it at a user-writable path.
      envVars.OI_SCM_CRED_CACHE_DIR = "/tmp/oi";
      if (useCreateTimeEnv) {
        envVars.OI_USE_CREATE_TIME_ENV = "1";
        if (this.providerConfig.scmProvider === "github" && !config.scmGitProxyBaseUrl) {
          envVars.VCS_CLONE_BASE_URL = `${config.controlPlaneUrl.replace(/\/+$/, "")}/git/${encodeURIComponent(config.sessionId)}`;
        }
      }
      // CubeSandbox enforces a per-value limit on its create-time `envs`
      // payload. Split oversized secrets (notably Codex auth.json) into
      // reserved chunks that the template launcher reassembles before exec.
      const createTimeEnvVars = useCreateTimeEnv ? prepareE2BCreateTimeEnv(envVars) : undefined;
      const metadata = this.buildMetadata(config);
      const sandbox = await this.client.createSandbox({
        templateID: this.client.config.templateId,
        ...(useCreateTimeEnv ? { envVars: createTimeEnvVars, envVarsField: "envs" as const } : {}),
        metadata,
        timeoutSeconds,
        autoPause: this.providerConfig.autoPause,
        // Require secure envd access: the per-session env we upload carries
        // SANDBOX_AUTH_TOKEN + user secrets, so envd must reject writes lacking the
        // returned access token (otherwise the upload is anonymous over the public host).
        secure: true,
        // Deliberately NOT auto-resume: resume is control-plane-driven (resumeSandbox →
        // connectSandbox). Provider-side auto-resume would wake a paused sandbox from
        // stray inbound traffic, outside the DO state machine.
        autoResume: false,
      });

      try {
        if (useCreateTimeEnv) {
          // CubeSandbox creates a fresh launcher process with these variables.
          // No envd endpoint is exposed publicly and no anonymous secret write
          // is needed when its E2B compatibility response omits an access token.
          await this.verifyCreateTimeRuntime(sandbox.sandboxID);
          return this.createResult(config, sandbox, codeServerPassword, vncPassword);
        }
        // Deliver per-session env to the supervisor. E2B's template start command
        // runs once at build and never sees create-time env vars, so the launcher
        // (oi-launch.py) waits for this file and execs the supervisor with it.
        const envdAccessToken = sandbox.envdAccessToken;
        if (!envdAccessToken) {
          // secure:true always returns a token, so a missing one is systemic (secure
          // unsupported / API change), not intermittent — classify permanent to trip the
          // circuit breaker rather than looping create→kill. Fail closed: the env write
          // (SANDBOX_AUTH_TOKEN + secrets) never happens; the catch below kills the sandbox.
          throw new SandboxProviderError(
            "E2B create did not return an envd access token (secure access required)",
            "permanent"
          );
        }
        await this.client.writeSessionEnv(sandbox.sandboxID, envVars, {
          domain: sandbox.domain,
          envdAccessToken,
        });
      } catch (error) {
        // The sandbox exists but will never get its session env — kill it rather
        // than leak a running launcher-only sandbox until its TTL.
        try {
          await this.client.killSandbox(sandbox.sandboxID);
        } catch (killError) {
          log.warn("e2b.cleanup_kill_failed", {
            sandbox_id: sandbox.sandboxID,
            error: killError instanceof Error ? killError.message : String(killError),
          });
        }
        throw error;
      }

      return this.createResult(config, sandbox, codeServerPassword, vncPassword);
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error("E2B create failed with a non-Error value");
    }
  }

  /**
   * Cube may acknowledge POST /sandboxes and keep reporting `running` after
   * its restored foreground task has already exited. Wait through the observed
   * early-exit window, then combine the advertised state with the shim log.
   * This remains create-time-env-only so standard E2B behaviour is unchanged.
   */
  private async verifyCreateTimeRuntime(
    sandboxId: string,
    options: { checkLifecycleLogs?: boolean } = {}
  ): Promise<void> {
    const delayMs = Math.max(
      0,
      this.providerConfig.createTimeEnvVerifyDelayMs ?? DEFAULT_E2B_CREATE_TIME_ENV_VERIFY_DELAY_MS
    );
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

    try {
      const sandbox = await this.client.getSandbox(sandboxId);
      if (sandbox.state !== "running") {
        throw new E2BRuntimeStartupError(
          `Cube runtime left running state during startup (${sandbox.state})`,
          true
        );
      }

      // A resumed sandbox's lifecycle log accumulates the pause-time TaskExit:
      // Cube's checkpoint stops the container, which records a containerd
      // TaskExit event. Re-checking those markers on resume misclassifies a
      // healthy restore as a dead runtime and forces a fresh spawn. Skip the
      // log probe on resume — the state check above plus the authenticated
      // Bridge reconnect (see the lifecycle manager) are the authoritative
      // health signal for a restarted sandbox.
      if (options.checkLifecycleLogs === false) return;

      const lifecycleLogs = await this.client.getSandboxLogs(sandboxId);
      if (CUBE_TERMINAL_LIFECYCLE_MARKERS.some((marker) => marker.test(lifecycleLogs))) {
        throw new E2BRuntimeStartupError("Cube runtime exited during startup", true);
      }
    } catch (error) {
      if (error instanceof E2BRuntimeStartupError) throw error;
      throw new E2BRuntimeStartupError(
        "Cube runtime readiness could not be verified",
        false,
        error instanceof Error ? error : undefined
      );
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      let sandbox: E2BSandboxDetail;
      try {
        sandbox = await this.client.getSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof E2BNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in E2B",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      const timeoutSeconds = config.timeoutSeconds ?? this.providerConfig.sandboxTimeoutSeconds;
      try {
        if (sandbox.state === "paused") {
          await this.client.connectSandbox(config.providerObjectId, timeoutSeconds);
        } else if (sandbox.state === "running") {
          await this.client.setSandboxTimeout(config.providerObjectId, timeoutSeconds);
        } else {
          return {
            success: false,
            error: `Sandbox in non-resumable state: ${sandbox.state}`,
            shouldSpawnFresh: true,
          };
        }
      } catch (error) {
        // The sandbox can disappear between the GET above and this call — treat a
        // late 404 the same as an initial one so the manager spawns fresh.
        if (error instanceof E2BNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in E2B",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      if (this.providerConfig.useCreateTimeEnv) {
        try {
          // Cube may report a paused/running object whose restored foreground
          // task has since exited. Reuse the create-time shim probe so the
          // lifecycle manager replaces the dead object immediately instead of
          // spending the full connecting watchdog on it. The log-marker check
          // is disabled here: a paused sandbox's lifecycle log records the
          // checkpoint TaskExit, which would misclassify every healthy restore
          // as dead and force a fresh spawn.
          await this.verifyCreateTimeRuntime(config.providerObjectId, {
            checkLifecycleLogs: false,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Cube runtime readiness could not be verified";
          if (error instanceof E2BRuntimeStartupError && !error.definitive) {
            // A control-plane/log API outage is not evidence that the paused
            // workspace died. Preserve it and let the authenticated Bridge or
            // the connecting watchdog make the authoritative decision.
            log.warn("e2b.resume_runtime_probe_unavailable", {
              sandbox_id: config.providerObjectId,
              session_id: config.sessionId,
              reason: message,
            });
          } else {
            log.warn("e2b.resume_runtime_unhealthy", {
              sandbox_id: config.providerObjectId,
              session_id: config.sessionId,
              reason: message,
            });
            return {
              success: false,
              error: message,
              shouldSpawnFresh: true,
            };
          }
        }
      }

      const codeServerPassword = config.codeServerEnabled
        ? await deriveCodeServerPassword(
            config.sandboxId,
            this.providerConfig.sandboxAccessPasswordSecret
          )
        : undefined;
      const vncPassword = config.vncEnabled
        ? await deriveVncPassword(config.sandboxId, this.providerConfig.sandboxAccessPasswordSecret)
        : undefined;
      const { codeServerUrl, vncUrl, tunnelUrls } = this.buildTunnelUrls(
        config.providerObjectId,
        config.codeServerEnabled,
        config.vncEnabled,
        config.sandboxSettings,
        sandbox.domain
      );

      return {
        success: true,
        providerObjectId: sandbox.sandboxID,
        codeServerUrl,
        codeServerPassword,
        vncAccess: createVncAccess(vncUrl, vncPassword),
        tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to resume E2B sandbox", error, "resume");
    }
  }

  /**
   * Idle/heartbeat stops are a resumable PAUSE (the manager routes them here via
   * supportsPersistentResume, and resumeSandbox brings the sandbox back).
   * Terminal stops (a sandbox that never connected) instead KILL: the manager
   * marks that session `failed` and won't resume it, so pausing would orphan a
   * sandbox E2B retains indefinitely.
   */
  async stopSandbox(config: StopConfig): Promise<StopResult> {
    const terminal = E2BSandboxProvider.TERMINAL_STOP_REASONS.has(config.reason);
    try {
      if (terminal) {
        await this.killSandboxWithRetry(config);
      } else {
        try {
          await this.client.pauseSandbox(config.providerObjectId);
        } catch (error) {
          // Already gone or already paused — nothing to do.
          if (error instanceof E2BNotFoundError || error instanceof E2BConflictError) {
            return { success: true };
          }
          throw error;
        }
      }
      return { success: true };
    } catch (error) {
      throw this.classifyError(
        `Failed to stop (${terminal ? "kill" : "pause"}) E2B sandbox`,
        error,
        "stop"
      );
    }
  }

  /**
   * Cube may reject DELETE on a paused/pausing sandbox and ask the client to
   * retry ("is pausing; retry DELETE after 2 seconds", or "could not be resumed
   * before delete; retry DELETE after 5 seconds"). Treating those 409/408
   * responses as success would silently leak the provider object, so retry a
   * bounded number of times while honouring the caller's deadline.
   */
  private async killSandboxWithRetry(config: StopConfig): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.client.killSandbox(
          config.providerObjectId,
          ...(config.signal ? [config.signal] : [])
        );
        return;
      } catch (error) {
        const retryable =
          error instanceof E2BConflictError ||
          (error instanceof E2BApiError && error.status === 408);
        if (!retryable || attempt >= maxAttempts || config.signal?.aborted) throw error;

        const delayMs = error instanceof E2BApiError && error.status === 408 ? 5000 : 2000;
        log.warn("e2b.kill_retry", {
          sandbox_id: config.providerObjectId,
          attempt,
          delay_ms: delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private buildMetadata(config: CreateSandboxConfig): Record<string, string> {
    const metadata: Record<string, string> = {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_expected_sandbox_id: config.sandboxId,
    };
    // Repo-less (environment/multi-repo) sessions have no single repo to label.
    if (config.repoOwner && config.repoName) {
      metadata.openinspect_repo = `${config.repoOwner}/${config.repoName}`;
    }
    return metadata;
  }

  private createResult(
    config: CreateSandboxConfig,
    sandbox: E2BSandboxCreated,
    codeServerPassword?: string,
    vncPassword?: string
  ): CreateSandboxResult {
    const { codeServerUrl, vncUrl, tunnelUrls } = this.buildTunnelUrls(
      sandbox.sandboxID,
      config.codeServerEnabled,
      config.vncEnabled,
      config.sandboxSettings,
      sandbox.domain
    );
    return {
      sandboxId: config.sandboxId,
      providerObjectId: sandbox.sandboxID,
      status: "running",
      createdAt: Date.now(),
      codeServerUrl,
      codeServerPassword,
      vncAccess: createVncAccess(vncUrl, vncPassword),
      tunnelUrls,
    };
  }

  private buildTunnelUrls(
    e2bSandboxId: string,
    codeServerEnabled: boolean | undefined,
    vncEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined,
    domain?: string | null
  ) {
    let tunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts);
    let codeServerUrl: string | undefined;
    let vncUrl: string | undefined;

    if (codeServerEnabled) {
      const { codeServerPort } = resolveServicePorts(sandboxSettings);
      codeServerUrl = this.client.getHostnameForPort(e2bSandboxId, codeServerPort, domain);
      tunnelPorts = tunnelPorts.filter((p) => p !== codeServerPort);
    }

    if (vncEnabled) {
      const { vncPort } = resolveServicePorts(sandboxSettings);
      vncUrl = this.client.getHostnameForPort(e2bSandboxId, vncPort, domain);
      tunnelPorts = tunnelPorts.filter((p) => p !== vncPort);
    }

    const tunnelUrls =
      tunnelPorts.length > 0
        ? Object.fromEntries(
            tunnelPorts.map((p) => [
              String(p),
              this.providerConfig.previewBaseUrl
                ? `${this.providerConfig.previewBaseUrl}/sandbox/${encodeURIComponent(e2bSandboxId)}/${p}/`
                : this.client.getHostnameForPort(e2bSandboxId, p, domain),
            ])
          )
        : undefined;

    return { codeServerUrl, vncUrl, tunnelUrls };
  }

  private classifyError(
    message: string,
    error: unknown,
    operation: "create" | "resume" | "stop"
  ): SandboxProviderError {
    // Already classified (e.g. the secure-access guard) — don't double-wrap and lose its message.
    if (error instanceof SandboxProviderError) return error;
    if (error instanceof E2BRuntimeStartupError) {
      return new SandboxProviderError(`${message}: ${error.message}`, "transient", error);
    }
    if (error instanceof E2BApiError) {
      if (error.status === 429) {
        // Rate limiting is temporary — classify transient so it isn't counted
        // toward the sandbox circuit breaker (a permanent error would open the
        // breaker and block later spawns for minutes).
        return new SandboxProviderError(
          `${message} (rate-limited during ${operation})`,
          "transient",
          error
        );
      }
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

export function createE2BProvider(
  client: E2BRestClient,
  providerConfig: E2BProviderConfig
): E2BSandboxProvider {
  return new E2BSandboxProvider(client, providerConfig);
}
