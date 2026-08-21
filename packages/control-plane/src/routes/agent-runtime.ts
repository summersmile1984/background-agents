import {
  agentRuntimePreferencesSchema,
  harnessCredentialKindSchema,
  type HarnessCredentialKind,
} from "@open-inspect/shared/types/agent-runtime";
import { resolveRuntimeLaunchDraftRequestSchema } from "@open-inspect/shared/types/runtime-launch";
import { agentHarnessSchema, type AgentHarness } from "@open-inspect/shared/types/agent-harness";
import { buildAgentRuntimeReadiness } from "../agent-runtime/readiness";
import {
  buildRuntimeHarnessOptions,
  RUNTIME_CAPABILITY_CATALOG_VERSION,
} from "../agent-runtime/capabilities";
import {
  ModelRelayAdminClient,
  ModelRelayAdminError,
  unavailableHostRelayStatus,
} from "../agent-runtime/model-relay-admin-client";
import { resolveRuntimeLaunchDraft, RuntimeLaunchResolutionError } from "../agent-runtime/resolver";
import { isDeploymentAdmin } from "../auth/deployment-admin";
import {
  AgentRuntimePreferencesStore,
  AgentRuntimePreferencesValidationError,
} from "../db/agent-runtime-preferences";
import {
  HarnessCredentialStore,
  HarnessCredentialValidationError,
} from "../db/harness-credentials";
import { GlobalSecretsStore } from "../db/global-secrets";
import { getEffectiveEnabledModels } from "../db/model-preferences";
import { SecretsValidationError } from "../db/secrets-validation";
import type { Env } from "../types";
import {
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  defineRoutes,
  error,
  json,
  parseJsonBody,
  parsePattern,
  type Route,
  type UserRouteContext,
} from "./shared";

function encryptionKey(env: Env): string | Response {
  return env.REPO_SECRETS_ENCRYPTION_KEY ?? error("Secrets encryption is not configured", 503);
}

function relayAdminClient(env: Env): ModelRelayAdminClient | null {
  return env.MODEL_RELAY_ADMIN_URL && env.MODEL_RELAY_ADMIN_AUTH_SECRET
    ? new ModelRelayAdminClient(env.MODEL_RELAY_ADMIN_URL, env.MODEL_RELAY_ADMIN_AUTH_SECRET)
    : null;
}

async function requireAdmin(env: Env, ctx: UserRouteContext): Promise<Response | null> {
  return (await isDeploymentAdmin(ctx.db, env, ctx.principal.userId))
    ? null
    : error("Deployment administrator access is required", 403);
}

function parseCredentialKind(match: RegExpMatchArray): HarnessCredentialKind | Response {
  const parsed = harnessCredentialKindSchema.safeParse(match.groups?.kind);
  return parsed.success ? parsed.data : error("Unknown harness credential kind", 404);
}

function runtimeHarnesses(env: Env): AgentHarness[] | undefined {
  if (!env.SANDBOX_RUNTIME_HARNESSES?.trim()) return undefined;
  return env.SANDBOX_RUNTIME_HARNESSES.split(",").flatMap((value) => {
    const parsed = agentHarnessSchema.safeParse(value.trim());
    return parsed.success ? [parsed.data] : [];
  });
}

async function getPreferences(env: Env, ctx: UserRouteContext): Promise<Response> {
  const [preferences, canManage] = await Promise.all([
    new AgentRuntimePreferencesStore(ctx.db).getEffective(env.DEFAULT_AGENT_HARNESS),
    isDeploymentAdmin(ctx.db, env, ctx.principal.userId),
  ]);
  return json({ ...preferences, canManage });
}

async function setPreferences(
  request: Request,
  env: Env,
  ctx: UserRouteContext
): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  const parsed = agentRuntimePreferencesSchema.safeParse(body);
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid preferences", 400);
  try {
    const preferences = await new AgentRuntimePreferencesStore(ctx.db).set(parsed.data);
    return json({ status: "updated", ...preferences, canManage: true });
  } catch (cause) {
    if (cause instanceof AgentRuntimePreferencesValidationError) return error(cause.message, 400);
    throw cause;
  }
}

async function listCredentials(env: Env, ctx: UserRouteContext): Promise<Response> {
  const key = encryptionKey(env);
  if (key instanceof Response) return key;
  const [credentials, canManage] = await Promise.all([
    new HarnessCredentialStore(ctx.db, key).listMetadata(),
    isDeploymentAdmin(ctx.db, env, ctx.principal.userId),
  ]);
  return json({ credentials, canManage });
}

async function setCredential(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  const kind = parseCredentialKind(match);
  if (kind instanceof Response) return kind;
  const key = encryptionKey(env);
  if (key instanceof Response) return key;
  const body = await parseJsonBody<{ value?: unknown; expiresAt?: unknown }>(request);
  if (body instanceof Response) return body;
  if (typeof body?.value !== "string") return error("Credential value is required", 400);
  if (
    body.expiresAt !== undefined &&
    body.expiresAt !== null &&
    typeof body.expiresAt !== "string"
  ) {
    return error("expiresAt must be a string or null", 400);
  }
  try {
    const credential = await new HarnessCredentialStore(ctx.db, key).set(
      kind,
      body.value,
      body.expiresAt as string | null | undefined
    );
    return json({ status: "updated", credential });
  } catch (cause) {
    if (
      cause instanceof HarnessCredentialValidationError ||
      cause instanceof SecretsValidationError
    ) {
      return error(cause.message, 400);
    }
    throw cause;
  }
}

async function deleteCredential(
  env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  const kind = parseCredentialKind(match);
  if (kind instanceof Response) return kind;
  const key = encryptionKey(env);
  if (key instanceof Response) return key;
  const deleted = await new HarnessCredentialStore(ctx.db, key).delete(kind);
  return deleted ? json({ status: "deleted", kind }) : error("Credential not found", 404);
}

async function getReadiness(env: Env, ctx: UserRouteContext): Promise<Response> {
  const key = encryptionKey(env);
  if (key instanceof Response) return key;
  const preferencesStore = new AgentRuntimePreferencesStore(ctx.db);
  const credentialsStore = new HarnessCredentialStore(ctx.db, key);
  const globalSecretsStore = new GlobalSecretsStore(ctx.db, key);
  const adminClient = relayAdminClient(env);
  const [preferences, credentials, secrets, canManage, hostRelay, enabledModels] =
    await Promise.all([
      preferencesStore.getEffective(env.DEFAULT_AGENT_HARNESS),
      credentialsStore.listMetadata(),
      globalSecretsStore.getDecryptedSecrets(),
      isDeploymentAdmin(ctx.db, env, ctx.principal.userId),
      adminClient ? adminClient.status() : unavailableHostRelayStatus(),
      getEffectiveEnabledModels(ctx.db),
    ]);
  const relayUrl =
    env.MODEL_RELAY_PUBLIC_URL || secrets.DEEPSEEK_RELAY_BASE_URL || secrets.CODEX_OPENAI_BASE_URL;
  const readiness = buildAgentRuntimeReadiness({
    preferences,
    credentials,
    relayReady: adminClient
      ? hostRelay.connected && hostRelay.deepseek.configured
      : Boolean(relayUrl),
    openAiApiKeyConfigured: Boolean(secrets.OPENAI_API_KEY),
    anthropicApiKeyConfigured: Boolean(secrets.ANTHROPIC_API_KEY),
    runtimeHarnesses: runtimeHarnesses(env),
  });
  return json({
    ...readiness,
    capabilityCatalogVersion: RUNTIME_CAPABILITY_CATALOG_VERSION,
    catalog: buildRuntimeHarnessOptions({
      readiness: readiness.harnesses,
      enabledModels,
    }),
    hostRelay,
    canManage,
  });
}

async function getCatalog(env: Env, ctx: { db: UserRouteContext["db"] }): Promise<Response> {
  const preferencesStore = new AgentRuntimePreferencesStore(ctx.db);
  const key = env.REPO_SECRETS_ENCRYPTION_KEY;
  const adminClient = relayAdminClient(env);
  const [preferences, credentials, secrets, hostRelay, enabledModels] = await Promise.all([
    preferencesStore.getEffective(env.DEFAULT_AGENT_HARNESS),
    key ? new HarnessCredentialStore(ctx.db, key).listMetadata() : Promise.resolve([]),
    key
      ? new GlobalSecretsStore(ctx.db, key).getDecryptedSecrets()
      : Promise.resolve<Record<string, string>>({}),
    adminClient ? adminClient.status() : unavailableHostRelayStatus(),
    getEffectiveEnabledModels(ctx.db),
  ]);
  const readiness = buildAgentRuntimeReadiness({
    preferences,
    credentials,
    relayReady:
      (hostRelay.connected && hostRelay.deepseek.configured) ||
      Boolean(
        env.MODEL_RELAY_PUBLIC_URL ||
        secrets.DEEPSEEK_RELAY_BASE_URL ||
        secrets.CODEX_OPENAI_BASE_URL
      ),
    openAiApiKeyConfigured: Boolean(secrets.OPENAI_API_KEY),
    anthropicApiKeyConfigured: Boolean(env.ANTHROPIC_API_KEY || secrets.ANTHROPIC_API_KEY),
    runtimeHarnesses: runtimeHarnesses(env),
  });
  return json({
    capabilityCatalogVersion: RUNTIME_CAPABILITY_CATALOG_VERSION,
    catalog: buildRuntimeHarnessOptions({
      readiness: readiness.harnesses,
      enabledModels,
    }),
  });
}

async function getHostRelay(env: Env, ctx: UserRouteContext): Promise<Response> {
  const client = relayAdminClient(env);
  const [status, canManage] = await Promise.all([
    client ? client.status() : unavailableHostRelayStatus(),
    isDeploymentAdmin(ctx.db, env, ctx.principal.userId),
  ]);
  return json({ ...status, canManage });
}

async function resolveLaunchDraft(
  request: Request,
  env: Env,
  ctx: UserRouteContext
): Promise<Response> {
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  const parsed = resolveRuntimeLaunchDraftRequestSchema.safeParse(body);
  if (!parsed.success) {
    return error(parsed.error.issues[0]?.message ?? "Invalid runtime launch draft", 400);
  }
  const client = relayAdminClient(env);
  const hostRelay = client ? await client.status() : unavailableHostRelayStatus();
  try {
    return json(
      await resolveRuntimeLaunchDraft({
        db: ctx.db,
        env,
        request: parsed.data,
        relayReady: hostRelay.connected && hostRelay.deepseek.configured,
        configurationOwners: [{ scope: "user", id: ctx.principal.userId }],
      })
    );
  } catch (cause) {
    if (cause instanceof RuntimeLaunchResolutionError) {
      return json({ error: cause.message, code: cause.code }, cause.status);
    }
    throw cause;
  }
}

function requireRelayAdminClient(env: Env): ModelRelayAdminClient | Response {
  return (
    relayAdminClient(env) ??
    error("Host model relay management is not configured for this deployment", 503)
  );
}

function relayAdminError(cause: unknown): Response {
  if (cause instanceof ModelRelayAdminError) {
    const status = cause.status >= 400 && cause.status < 500 ? cause.status : 502;
    return error(cause.message, status);
  }
  return error("Host model relay management is unavailable", 502);
}

async function setDeepSeekHostKey(
  request: Request,
  env: Env,
  ctx: UserRouteContext
): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  const client = requireRelayAdminClient(env);
  if (client instanceof Response) return client;
  const body = await parseJsonBody<{ apiKey?: unknown }>(request);
  if (body instanceof Response) return body;
  if (typeof body?.apiKey !== "string" || !body.apiKey.trim()) {
    return error("DeepSeek API key is required", 400);
  }
  try {
    const status = await client.replaceDeepSeekKey(body.apiKey.trim());
    return json({ status: "updated", hostRelay: status });
  } catch (cause) {
    return relayAdminError(cause);
  }
}

async function deleteDeepSeekHostKey(env: Env, ctx: UserRouteContext): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  const client = requireRelayAdminClient(env);
  if (client instanceof Response) return client;
  try {
    const status = await client.deleteDeepSeekKey();
    return json({ status: "deleted", hostRelay: status });
  } catch (cause) {
    return relayAdminError(cause);
  }
}

async function testDeepSeekHost(env: Env, ctx: UserRouteContext): Promise<Response> {
  const rejection = await requireAdmin(env, ctx);
  if (rejection) return rejection;
  const client = requireRelayAdminClient(env);
  if (client instanceof Response) return client;
  try {
    const status = await client.testDeepSeek();
    return json({ status: "ok", hostRelay: status });
  } catch (cause) {
    return relayAdminError(cause);
  }
}

export const agentRuntimeRoutes: Route[] = [
  ...defineRoutes(SCM_AGNOSTIC_HUMAN_USER_ROUTE, [
    {
      method: "GET",
      pattern: parsePattern("/agent-runtime/preferences"),
      handler: async (_request, env, _match, ctx) => getPreferences(env, ctx),
    },
    {
      method: "PUT",
      pattern: parsePattern("/agent-runtime/preferences"),
      handler: async (request, env, _match, ctx) => setPreferences(request, env, ctx),
    },
    {
      method: "GET",
      pattern: parsePattern("/agent-runtime/credentials"),
      handler: async (_request, env, _match, ctx) => listCredentials(env, ctx),
    },
    {
      method: "PUT",
      pattern: parsePattern("/agent-runtime/credentials/:kind"),
      handler: async (request, env, match, ctx) => setCredential(request, env, match, ctx),
    },
    {
      method: "DELETE",
      pattern: parsePattern("/agent-runtime/credentials/:kind"),
      handler: async (_request, env, match, ctx) => deleteCredential(env, match, ctx),
    },
    {
      method: "GET",
      pattern: parsePattern("/agent-runtime/readiness"),
      handler: async (_request, env, _match, ctx) => getReadiness(env, ctx),
    },
    {
      method: "POST",
      pattern: parsePattern("/agent-runtime/resolve-draft"),
      handler: async (request, env, _match, ctx) => resolveLaunchDraft(request, env, ctx),
    },
    {
      method: "GET",
      pattern: parsePattern("/agent-runtime/host-relay"),
      handler: async (_request, env, _match, ctx) => getHostRelay(env, ctx),
    },
    {
      method: "PUT",
      pattern: parsePattern("/agent-runtime/host-relay/deepseek-key"),
      handler: async (request, env, _match, ctx) => setDeepSeekHostKey(request, env, ctx),
    },
    {
      method: "DELETE",
      pattern: parsePattern("/agent-runtime/host-relay/deepseek-key"),
      handler: async (_request, env, _match, ctx) => deleteDeepSeekHostKey(env, ctx),
    },
    {
      method: "POST",
      pattern: parsePattern("/agent-runtime/host-relay/deepseek-test"),
      handler: async (_request, env, _match, ctx) => testDeepSeekHost(env, ctx),
    },
  ]),
  ...defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
    {
      method: "GET",
      pattern: parsePattern("/agent-runtime/catalog"),
      handler: async (_request, env, _match, ctx) => getCatalog(env, ctx),
    },
  ]),
];
