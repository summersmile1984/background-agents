import { extractProviderAndModel } from "@open-inspect/shared/models";
import type { AgentHarness } from "@open-inspect/shared/types/agent-harness";
import type { HarnessReadinessCode } from "@open-inspect/shared/types/agent-runtime";
import { AgentRuntimePreferencesStore } from "../db/agent-runtime-preferences";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import { mergeSecretSources, type SecretSource } from "../db/secrets-validation";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";

const PROVIDERS_BY_HARNESS: Partial<Record<AgentHarness, readonly string[]>> = {
  codex: ["openai", "deepseek"],
  claude: ["anthropic", "deepseek"],
  deepseek: ["deepseek"],
};

export class AgentRuntimeSelectionError extends Error {
  constructor(
    readonly code: HarnessReadinessCode,
    message: string
  ) {
    super(message);
    this.name = "AgentRuntimeSelectionError";
  }
}

function configuredRuntimeHarnesses(env: Env): Set<AgentHarness> | null {
  if (!env.SANDBOX_RUNTIME_HARNESSES?.trim()) return null;
  return new Set(
    env.SANDBOX_RUNTIME_HARNESSES.split(",")
      .map((value) => value.trim())
      .filter(
        (value): value is AgentHarness =>
          value === "opencode" || value === "codex" || value === "claude" || value === "deepseek"
      )
  );
}

function unexpired(expiresAt: string | undefined): boolean {
  if (!expiresAt?.trim()) return true;
  const raw = expiresAt.trim();
  let timestamp = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (Number.isFinite(timestamp) && timestamp < 10_000_000_000) timestamp *= 1000;
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

export interface AgentRuntimeSecretTarget {
  environmentId: string | null;
  /** Repositories in session order (primary first). */
  repositories?: readonly { repoId: number }[];
  /** Scalar repository fallback when repositories is absent. */
  repoId?: number | null;
}

async function loadEffectiveSecrets(input: {
  db: SqlDatabase;
  encryptionKey: string;
  target?: AgentRuntimeSecretTarget;
}): Promise<Record<string, string>> {
  const globalSecrets = await new GlobalSecretsStore(
    input.db,
    input.encryptionKey
  ).getDecryptedSecrets();
  const sources: SecretSource[] = [{ label: "global", secrets: globalSecrets }];
  const target = input.target;
  if (!target) return globalSecrets;

  if (target.environmentId) {
    const environmentSecrets = await new EnvironmentSecretsStore(
      input.db,
      input.encryptionKey
    ).getDecryptedSecrets(target.environmentId);
    if (Object.keys(environmentSecrets).length > 0) {
      sources.push({ label: "environment", secrets: environmentSecrets });
    }
    return mergeSecretSources(sources).merged;
  }

  const repositoryIds =
    target.repositories?.map(({ repoId }) => repoId) ??
    (target.repoId != null ? [target.repoId] : []);
  const repoStore = new RepoSecretsStore(input.db, input.encryptionKey);
  // Match the sandbox fold: secondary repositories merge first and the
  // primary repository (position zero) wins collisions.
  for (const repoId of [...repositoryIds].reverse()) {
    const repoSecrets = await repoStore.getDecryptedSecrets(repoId);
    if (Object.keys(repoSecrets).length > 0) {
      sources.push({ label: `repo:${repoId}`, secrets: repoSecrets });
    }
  }
  return mergeSecretSources(sources).merged;
}

export async function assertAgentRuntimeSelection(input: {
  db: SqlDatabase;
  env: Env;
  harness: AgentHarness;
  model: string;
  /** Already-resolved sandbox secrets, used by live session prompt checks. */
  effectiveSecrets?: Record<string, string>;
  /** Session target used to resolve scoped secrets during session creation. */
  target?: AgentRuntimeSecretTarget;
}): Promise<void> {
  const preferences = await new AgentRuntimePreferencesStore(input.db).getEffective(
    input.env.DEFAULT_AGENT_HARNESS
  );
  if (!preferences.enabledHarnesses.includes(input.harness)) {
    throw new AgentRuntimeSelectionError(
      "HARNESS_DISABLED",
      `Harness "${input.harness}" is disabled`
    );
  }
  const runtimeHarnesses = configuredRuntimeHarnesses(input.env);
  if (runtimeHarnesses && !runtimeHarnesses.has(input.harness)) {
    throw new AgentRuntimeSelectionError(
      "RUNTIME_UNAVAILABLE",
      `Harness "${input.harness}" is not available in the sandbox runtime`
    );
  }

  const { provider } = extractProviderAndModel(input.model);
  const supportedProviders = PROVIDERS_BY_HARNESS[input.harness];
  if (supportedProviders && !supportedProviders.includes(provider)) {
    throw new AgentRuntimeSelectionError(
      "MODEL_INCOMPATIBLE",
      `Model "${input.model}" is not compatible with harness "${input.harness}"`
    );
  }

  if (!input.env.REPO_SECRETS_ENCRYPTION_KEY) {
    // Existing deployments without managed secrets retain their historical
    // behavior for non-relayed models. Credential-aware preflight becomes
    // available as soon as the encryption key is configured.
    if (provider === "deepseek") {
      throw new AgentRuntimeSelectionError(
        "RELAY_UNAVAILABLE",
        "DeepSeek requires managed secrets and the Host model relay"
      );
    }
    return;
  }

  const secrets =
    input.effectiveSecrets ??
    (await loadEffectiveSecrets({
      db: input.db,
      encryptionKey: input.env.REPO_SECRETS_ENCRYPTION_KEY,
      target: input.target,
    }));

  if (provider === "deepseek") {
    const relayUrl =
      input.env.MODEL_RELAY_PUBLIC_URL ||
      secrets.DEEPSEEK_RELAY_BASE_URL ||
      secrets.CODEX_OPENAI_BASE_URL;
    if (!relayUrl) {
      throw new AgentRuntimeSelectionError(
        "RELAY_UNAVAILABLE",
        "The Host model relay is not configured"
      );
    }
    return;
  }

  if (input.harness !== "codex" && input.harness !== "claude") return;

  if (input.harness === "codex" && provider === "openai") {
    const configured = Boolean(secrets.CODEX_AUTH_JSON || secrets.CODEX_ACCESS_TOKEN);
    if (
      secrets.OPENAI_API_KEY ||
      (configured && unexpired(secrets.CODEX_ACCESS_TOKEN_EXPIRES_AT))
    ) {
      return;
    }
    throw new AgentRuntimeSelectionError(
      configured ? "CREDENTIAL_EXPIRED" : "CREDENTIAL_MISSING",
      configured ? "The Codex credential has expired" : "A Codex credential is required"
    );
  }

  if (input.harness === "claude" && provider === "anthropic") {
    const configured = Boolean(secrets.CLAUDE_CODE_OAUTH_TOKEN);
    if (
      input.env.ANTHROPIC_API_KEY ||
      secrets.ANTHROPIC_API_KEY ||
      (configured && unexpired(secrets.CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT))
    ) {
      return;
    }
    throw new AgentRuntimeSelectionError(
      configured ? "CREDENTIAL_EXPIRED" : "CREDENTIAL_MISSING",
      configured ? "The Claude credential has expired" : "A Claude credential is required"
    );
  }
}
