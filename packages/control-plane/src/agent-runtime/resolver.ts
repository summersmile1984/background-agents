import {
  DEFAULT_MODEL,
  isValidModel,
  normalizeModelId,
  type ValidModel,
} from "@open-inspect/shared/models";
import type { AgentHarness } from "@open-inspect/shared/types/agent-harness";
import type {
  HarnessCredentialKind,
  HarnessCredentialMetadata,
  HarnessReadinessCode,
} from "@open-inspect/shared/types/agent-runtime";
import type {
  ResolveRuntimeLaunchDraftRequest,
  ResolveRuntimeLaunchDraftResponse,
  ResolvedRuntimeTargetSnapshot,
  ResolvedRuntimeValue,
  RuntimeEffortOption,
  RuntimeConfigFragment,
  RuntimeConfigurationScope,
  RuntimeHarnessOption,
  RuntimeLaunchTarget,
  RuntimeModelOption,
  RuntimeSettingDefinition,
  RuntimeSelectionIssue,
  RuntimeSelectionIssueCode,
} from "@open-inspect/shared/types/runtime-launch";
import { AgentRuntimePreferencesStore } from "../db/agent-runtime-preferences";
import { EnvironmentStore, type EnvironmentRow } from "../db/environments";
import { getEffectiveEnabledModels } from "../db/model-preferences";
import { ScmConnectionStore } from "../db/scm-connections";
import { ScmRepositoryStore, type ScmRepositoryRecord } from "../db/scm-repositories";
import { RuntimeConfigurationStore } from "../db/runtime-configurations";
import { IntegrationSettingsStore } from "../db/integration-settings";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { buildAgentRuntimeReadiness } from "./readiness";
import { loadEffectiveAgentRuntimeSecrets } from "./selection";
import {
  buildRuntimeHarnessOptions,
  RUNTIME_CAPABILITY_CATALOG_VERSION,
  RUNTIME_RESOLVER_VERSION,
} from "./capabilities";
import { buildRuntimeCommandOptions } from "./commands";

export class RuntimeLaunchResolutionError extends Error {
  constructor(
    readonly code: RuntimeSelectionIssueCode,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "RuntimeLaunchResolutionError";
  }
}

function runtimeHarnesses(env: Env): AgentHarness[] | undefined {
  const configured = env.SANDBOX_RUNTIME_HARNESSES?.split(",")
    .map((value) => value.trim())
    .filter(
      (value): value is AgentHarness =>
        value === "opencode" || value === "codex" || value === "claude" || value === "deepseek"
    );
  return configured?.length ? configured : undefined;
}

function credentialMetadataFromSecrets(
  secrets: Record<string, string>
): HarnessCredentialMetadata[] {
  const descriptors: Array<{
    kind: HarnessCredentialKind;
    key: string;
    expiryKey?: string;
  }> = [
    {
      kind: "codex-auth-json",
      key: "CODEX_AUTH_JSON",
      expiryKey: "CODEX_ACCESS_TOKEN_EXPIRES_AT",
    },
    {
      kind: "codex-access-token",
      key: "CODEX_ACCESS_TOKEN",
      expiryKey: "CODEX_ACCESS_TOKEN_EXPIRES_AT",
    },
    {
      kind: "claude-setup-token",
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      expiryKey: "CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT",
    },
  ];
  return descriptors.map(({ kind, key, expiryKey }) => ({
    kind,
    configured: Boolean(secrets[key]?.trim()),
    updatedAt: null,
    expiresAt: expiryKey ? secrets[expiryKey]?.trim() || null : null,
    fingerprint: null,
  }));
}

function requiredRepository(
  record: ScmRepositoryRecord,
  repositoryKey: string
): ScmRepositoryRecord {
  if (
    record.resolutionStatus !== "resolved" ||
    record.removedAt != null ||
    !record.externalId ||
    !record.defaultBranch ||
    !record.webUrl ||
    !record.cloneUrl
  ) {
    throw new RuntimeLaunchResolutionError(
      "TARGET_UNAVAILABLE",
      409,
      `Repository is not launchable: ${repositoryKey}`
    );
  }
  return record;
}

async function repositoryRecords(
  store: ScmRepositoryStore,
  keys: readonly string[]
): Promise<ScmRepositoryRecord[]> {
  const records = await Promise.all(keys.map((key) => store.get(key)));
  return records.map((record, index) => {
    if (!record) {
      throw new RuntimeLaunchResolutionError(
        "TARGET_UNAVAILABLE",
        404,
        `Repository was not found: ${keys[index]}`
      );
    }
    return requiredRepository(record, keys[index]);
  });
}

async function resolveTarget(
  db: SqlDatabase,
  target: RuntimeLaunchTarget
): Promise<{ snapshot: ResolvedRuntimeTargetSnapshot; environment: EnvironmentRow | null }> {
  if (target.kind === "none") {
    return {
      snapshot: {
        kind: "none",
        connectionId: null,
        provider: null,
        environmentId: null,
        repositories: [],
      },
      environment: null,
    };
  }

  const repositoryStore = new ScmRepositoryStore(db);
  const environmentStore = new EnvironmentStore(db);
  let environment: EnvironmentRow | null = null;
  let keys: string[];
  let branches: Array<string | undefined>;

  if (target.kind === "environment") {
    environment = await environmentStore.getById(target.environmentId);
    if (!environment) {
      throw new RuntimeLaunchResolutionError(
        "TARGET_UNAVAILABLE",
        404,
        `Environment was not found: ${target.environmentId}`
      );
    }
    const members = await environmentStore.getRepositoriesForEnvironment(target.environmentId);
    if (members.length === 0 || members.some((member) => !member.repository_id)) {
      throw new RuntimeLaunchResolutionError(
        "TARGET_UNAVAILABLE",
        409,
        `Environment requires repository identity migration: ${target.environmentId}`
      );
    }
    keys = members.map((member) => member.repository_id!);
    branches = members.map((member) => member.base_branch);
  } else if (target.kind === "repository-set") {
    keys = [...target.repositoryKeys];
    branches = keys.map(() => undefined);
  } else {
    if (target.environmentId) {
      environment = await environmentStore.getById(target.environmentId);
      if (!environment) {
        throw new RuntimeLaunchResolutionError(
          "TARGET_UNAVAILABLE",
          404,
          `Environment was not found: ${target.environmentId}`
        );
      }
      const environmentRepositories = await environmentStore.getRepositoriesForEnvironment(
        target.environmentId
      );
      if (
        !environmentRepositories.some((member) => member.repository_id === target.repositoryKey)
      ) {
        throw new RuntimeLaunchResolutionError(
          "TARGET_UNAVAILABLE",
          409,
          "The child repository is not a member of the inherited environment"
        );
      }
    }
    keys = [target.repositoryKey];
    branches = [target.branch];
  }

  const records = await repositoryRecords(repositoryStore, keys);
  const connectionIds = new Set(records.map((record) => record.connectionId));
  if (connectionIds.size !== 1) {
    throw new RuntimeLaunchResolutionError(
      "SCM_CONNECTION_MISMATCH",
      409,
      "All repositories in one session must use one source-control connection"
    );
  }
  const connectionId = records[0].connectionId;
  if (environment?.scm_connection_id && environment.scm_connection_id !== connectionId) {
    throw new RuntimeLaunchResolutionError(
      "SCM_CONNECTION_MISMATCH",
      409,
      "Environment repositories do not match its source-control connection"
    );
  }
  const connection = await new ScmConnectionStore(db).get(connectionId);
  if (!connection?.enabled) {
    throw new RuntimeLaunchResolutionError(
      "TARGET_UNAVAILABLE",
      409,
      "The selected source-control connection is disabled or unavailable"
    );
  }

  const checkoutNames = new Set<string>();
  const repositories = records.map((record, position) => {
    const checkoutName = record.name.toLowerCase();
    if (checkoutNames.has(checkoutName)) {
      throw new RuntimeLaunchResolutionError(
        "TARGET_UNAVAILABLE",
        409,
        `Repositories resolve to the same checkout path: ${record.name}`
      );
    }
    checkoutNames.add(checkoutName);
    return {
      repositoryKey: record.id,
      connectionId,
      externalRepositoryId: record.externalId!,
      owner: record.owner,
      name: record.name,
      branch: branches[position]?.trim() || record.defaultBranch!,
      position,
      webUrl: record.webUrl!,
      cloneUrl: record.cloneUrl!,
    };
  });

  return {
    snapshot: {
      kind: target.kind,
      connectionId,
      provider: connection.provider,
      environmentId: environment?.id ?? null,
      repositories,
    },
    environment,
  };
}

function sourceValue<T>(
  value: T,
  source: ResolvedRuntimeValue<T>["source"],
  inherited: boolean
): ResolvedRuntimeValue<T> {
  return { value, source, inherited };
}

interface RuntimeConfigurationLayer {
  scope: RuntimeConfigurationScope;
  id: string | null;
  config: RuntimeConfigFragment;
}

const LEGACY_RUNTIME_INTEGRATIONS = new Set(["slack", "github", "linear"] as const);

async function legacyIntegrationRuntimeFragment(input: {
  db: SqlDatabase;
  integrationId: string | undefined;
  target: ResolvedRuntimeTargetSnapshot;
}): Promise<RuntimeConfigFragment | null> {
  if (
    !input.integrationId ||
    !LEGACY_RUNTIME_INTEGRATIONS.has(input.integrationId as "slack" | "github" | "linear")
  ) {
    return null;
  }
  const integrationId = input.integrationId as "slack" | "github" | "linear";
  const primary = input.target.repositories[0];
  const store = new IntegrationSettingsStore(input.db);
  const settings = primary
    ? (
        await store.getResolvedConfig(
          integrationId,
          `${primary.owner}/${primary.name}`,
          input.target.environmentId,
          primary.repositoryKey
        )
      ).settings
    : ((await store.getGlobal(integrationId))?.defaults ?? {});
  const legacySettings = settings as Record<string, unknown>;
  const model = typeof legacySettings.model === "string" ? legacySettings.model : undefined;
  const effort =
    typeof legacySettings.reasoningEffort === "string" ? legacySettings.reasoningEffort : undefined;
  return model || effort ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } : null;
}

function configuredValue(
  layers: readonly RuntimeConfigurationLayer[],
  key: "harness" | "routeId" | "model" | "effort"
): { value: string; source: ResolvedRuntimeValue<string>["source"]; inherited: boolean } | null {
  for (const layer of [...layers].reverse()) {
    const value = layer.config[key];
    if (
      typeof value === "string" &&
      value !== "inherit" &&
      (key !== "routeId" || value !== "auto")
    ) {
      return {
        value,
        source: { scope: layer.scope, id: layer.id },
        inherited: layer.scope !== "session",
      };
    }
  }
  return null;
}

function readinessIssueCode(code: HarnessReadinessCode): RuntimeSelectionIssueCode {
  if (code === "READY") return "ROUTE_NOT_READY";
  return code === "MODEL_INCOMPATIBLE" ? "MODEL_INCOMPATIBLE" : code;
}

function firstReadyModel(harness: RuntimeHarnessOption): RuntimeModelOption | null {
  const models = harness.routes.flatMap((route) => route.models.filter((model) => model.ready));
  return models.find((model) => model.model === DEFAULT_MODEL) ?? models[0] ?? null;
}

function selectModel(input: {
  harness: RuntimeHarnessOption;
  requestedRoute?: string;
  requestedModel?: string;
  issues: RuntimeSelectionIssue[];
}): RuntimeModelOption | null {
  const rawRequestedModel =
    input.requestedModel && input.requestedModel !== "inherit" ? input.requestedModel : null;
  const normalizedRequestedModel = rawRequestedModel ? normalizeModelId(rawRequestedModel) : null;
  if (normalizedRequestedModel && !isValidModel(normalizedRequestedModel)) {
    input.issues.push({
      code: "MODEL_INCOMPATIBLE",
      field: "model",
      severity: "error",
      message: `Unknown model: ${rawRequestedModel}`,
    });
    return null;
  }
  const requestedModel = normalizedRequestedModel as ValidModel | null;
  const requestedRoute =
    input.requestedRoute && input.requestedRoute !== "auto" ? input.requestedRoute : null;
  const routeCandidates = requestedRoute
    ? input.harness.routes.filter((route) => route.routeId === requestedRoute)
    : input.harness.routes;

  if (requestedRoute && routeCandidates.length === 0) {
    input.issues.push({
      code: "ROUTE_NOT_READY",
      field: "route",
      severity: "error",
      message: `Route is not available for ${input.harness.displayName}: ${requestedRoute}`,
    });
    return null;
  }

  if (requestedModel) {
    const selected = routeCandidates
      .flatMap((route) => route.models)
      .find((model) => model.model === requestedModel);
    if (!selected) {
      input.issues.push({
        code: "MODEL_INCOMPATIBLE",
        field: "model",
        severity: "error",
        message: `Model ${requestedModel} is not compatible with ${input.harness.displayName}`,
      });
      return null;
    }
    if (!selected.ready) {
      const route = input.harness.routes.find(
        (candidate) => candidate.routeId === selected.routeId
      )!;
      input.issues.push({
        code: selected.enabled
          ? readinessIssueCode(route.code as HarnessReadinessCode)
          : "MODEL_DISABLED",
        field: "model",
        severity: "error",
        message: selected.disabledReason ?? `Model ${requestedModel} is not ready`,
        remediation: {
          kind: selected.enabled ? "choose-another-route" : "open-settings",
          ...(selected.enabled ? {} : { href: "/settings?tab=models" }),
        },
      });
    }
    return selected;
  }

  const readyModels = routeCandidates.flatMap((route) =>
    route.models.filter((model) => model.ready)
  );
  return (
    readyModels.find((model) => model.model === DEFAULT_MODEL) ??
    readyModels[0] ??
    firstReadyModel(input.harness)
  );
}

function selectEffort(input: {
  model: RuntimeModelOption | null;
  requestedEffort?: string;
  issues: RuntimeSelectionIssue[];
}): { effort: RuntimeEffortOption | null; explicit: boolean } {
  if (!input.model) return { effort: null, explicit: false };
  const requested =
    input.requestedEffort && input.requestedEffort !== "inherit" ? input.requestedEffort : null;
  if (requested) {
    const effort = input.model.efforts.find((candidate) => candidate.value === requested) ?? null;
    if (!effort) {
      input.issues.push({
        code: "EFFORT_UNSUPPORTED",
        field: "effort",
        severity: "error",
        message: `${requested} is not supported by ${input.model.displayName} on this harness route`,
      });
    }
    return { effort, explicit: true };
  }
  return {
    effort: input.model.efforts.find((candidate) => candidate.isDefault) ?? null,
    explicit: false,
  };
}

function validateSettingValue(definition: RuntimeSettingDefinition, value: unknown): string | null {
  if (definition.type === "string") {
    if (typeof value !== "string") return "must be a string";
    const maxLength = definition.constraints?.maxLength;
    if (typeof maxLength === "number" && value.length > maxLength) {
      return `must contain at most ${maxLength} characters`;
    }
    return null;
  }
  if (definition.type === "boolean") return typeof value === "boolean" ? null : "must be boolean";
  if (definition.type === "integer") {
    if (!Number.isInteger(value)) return "must be an integer";
    const numberValue = value as number;
    const minimum = definition.constraints?.minimum;
    const maximum = definition.constraints?.maximum;
    if (typeof minimum === "number" && numberValue < minimum) return `must be at least ${minimum}`;
    if (typeof maximum === "number" && numberValue > maximum) return `must be at most ${maximum}`;
    return null;
  }
  if (definition.type === "enum") {
    return typeof value === "string" &&
      definition.enumOptions?.some((option) => option.value === value)
      ? null
      : "must be one of the advertised values";
  }
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? null
    : "must be a list of strings";
}

function resolveSettings(input: {
  harness: RuntimeHarnessOption;
  layers: readonly RuntimeConfigurationLayer[];
  issues: RuntimeSelectionIssue[];
}): Record<string, ResolvedRuntimeValue<unknown>> {
  const definitions = new Map(
    input.harness.settings.map((definition) => [definition.key, definition])
  );
  const resolved: Record<string, ResolvedRuntimeValue<unknown>> = Object.fromEntries(
    input.harness.settings.map((definition) => [
      definition.key,
      sourceValue(definition.defaultValue, { scope: "installation", id: null }, true),
    ])
  );
  for (const layer of input.layers) {
    const layerHarness = layer.config.harness;
    if (layerHarness && layerHarness !== "inherit" && layerHarness !== input.harness.harness) {
      continue;
    }
    for (const [key, value] of Object.entries(layer.config.settings ?? {})) {
      const definition = definitions.get(key);
      if (!definition) {
        input.issues.push({
          code: "SETTING_INVALID",
          field: "settings",
          severity: "error",
          message: `Unknown ${input.harness.displayName} setting: ${key}`,
        });
        continue;
      }
      if (!definition.allowedScopes.includes(layer.scope)) {
        input.issues.push({
          code: "SETTING_INVALID",
          field: "settings",
          severity: "error",
          message: `${definition.label} cannot be configured at ${layer.scope} scope`,
        });
        continue;
      }
      if (definition.visibility !== "user" && layer.scope !== "installation") {
        input.issues.push({
          code: "SETTING_INVALID",
          field: "settings",
          severity: "error",
          message: `${definition.label} is enforced by installation policy`,
        });
        continue;
      }
      const invalid = validateSettingValue(definition, value);
      if (invalid) {
        input.issues.push({
          code: "SETTING_INVALID",
          field: "settings",
          severity: "error",
          message: `${definition.label} ${invalid}`,
        });
        continue;
      }
      resolved[key] = sourceValue(
        value,
        { scope: layer.scope, id: layer.id },
        layer.scope !== "session"
      );
    }
  }
  return resolved;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function resolveRuntimeLaunchDraft(input: {
  db: SqlDatabase;
  env: Env;
  request: ResolveRuntimeLaunchDraftRequest;
  relayReady: boolean;
  configurationOwners?: readonly {
    scope: "user" | "integration";
    id: string;
  }[];
}): Promise<ResolveRuntimeLaunchDraftResponse> {
  const { snapshot: target, environment } = await resolveTarget(input.db, input.request.target);
  const effectiveSecretsPromise: Promise<Record<string, string>> = input.env
    .REPO_SECRETS_ENCRYPTION_KEY
    ? loadEffectiveAgentRuntimeSecrets({
        db: input.db,
        encryptionKey: input.env.REPO_SECRETS_ENCRYPTION_KEY,
        target: {
          environmentId: target.environmentId,
          repositories: target.repositories.map((repository) => ({
            repositoryKey: repository.repositoryKey,
          })),
        },
      })
    : Promise.resolve({});
  const configurationScopes = [
    { scope: "installation" as const, scopeId: "global" },
    ...(input.configurationOwners ?? []).map(({ scope, id }) => ({ scope, scopeId: id })),
    ...(target.repositories[0]
      ? [{ scope: "repository" as const, scopeId: target.repositories[0].repositoryKey }]
      : []),
    ...(target.environmentId
      ? [{ scope: "environment" as const, scopeId: target.environmentId }]
      : []),
  ];
  const configurationStore = new RuntimeConfigurationStore(input.db);
  const integrationOwner = input.configurationOwners?.find(
    (owner) => owner.scope === "integration"
  );
  const [
    preferences,
    enabledModels,
    effectiveSecrets,
    storedConfigurations,
    legacyIntegrationConfiguration,
  ] = await Promise.all([
    new AgentRuntimePreferencesStore(input.db).getEffective(input.env.DEFAULT_AGENT_HARNESS),
    getEffectiveEnabledModels(input.db),
    effectiveSecretsPromise,
    configurationStore.getMany(configurationScopes),
    legacyIntegrationRuntimeFragment({
      db: input.db,
      integrationId: integrationOwner?.id,
      target,
    }),
  ]);
  const readiness = buildAgentRuntimeReadiness({
    preferences,
    credentials: credentialMetadataFromSecrets(effectiveSecrets),
    relayReady:
      input.relayReady ||
      Boolean(
        input.env.MODEL_RELAY_PUBLIC_URL ||
        effectiveSecrets.DEEPSEEK_RELAY_BASE_URL ||
        effectiveSecrets.CODEX_OPENAI_BASE_URL
      ),
    openAiApiKeyConfigured: Boolean(effectiveSecrets.OPENAI_API_KEY),
    anthropicApiKeyConfigured: Boolean(
      input.env.ANTHROPIC_API_KEY || effectiveSecrets.ANTHROPIC_API_KEY
    ),
    runtimeHarnesses: runtimeHarnesses(input.env),
  });
  const harnesses = buildRuntimeHarnessOptions({
    readiness: readiness.harnesses,
    enabledModels,
  });
  const issues: RuntimeSelectionIssue[] = [];
  const layers: RuntimeConfigurationLayer[] = storedConfigurations.flatMap(
    (configuration): RuntimeConfigurationLayer[] =>
      configuration
        ? [
            {
              scope: configuration.scope,
              id: configuration.scopeId,
              config: configuration.config,
            },
          ]
        : []
  );
  if (legacyIntegrationConfiguration && integrationOwner) {
    const canonicalIntegrationIndex = layers.findIndex(
      (layer) => layer.scope === "integration" && layer.id === integrationOwner.id
    );
    layers.splice(canonicalIntegrationIndex >= 0 ? canonicalIntegrationIndex : 1, 0, {
      scope: "integration",
      id: `${integrationOwner.id}:legacy`,
      config: legacyIntegrationConfiguration,
    });
  }
  if (environment?.default_agent_harness) {
    const legacyEnvironmentLayer: RuntimeConfigurationLayer = {
      scope: "environment",
      id: environment.id,
      config: { harness: environment.default_agent_harness },
    };
    const storedEnvironmentIndex = layers.findIndex((layer) => layer.scope === "environment");
    layers.splice(
      storedEnvironmentIndex >= 0 ? storedEnvironmentIndex : layers.length,
      0,
      legacyEnvironmentLayer
    );
  }
  layers.push({ scope: "session", id: null, config: input.request.runtime ?? {} });

  const configuredHarness = configuredValue(layers, "harness");
  const configuredRoute = configuredValue(layers, "routeId");
  const configuredModel = configuredValue(layers, "model");
  const configuredEffort = configuredValue(layers, "effort");
  let harnessValue = (configuredHarness?.value ?? preferences.defaultAgentHarness) as AgentHarness;
  let harnessSource = configuredHarness?.source ?? {
    scope: "installation" as const,
    id: null,
  };
  let harnessInherited = configuredHarness?.inherited ?? true;

  // An integration may carry a model preference but no harness preference.
  // Resolve that ambiguity once, here, by selecting a ready harness route for
  // the requested model. No client is allowed to maintain a provider→harness map.
  if (!configuredHarness && configuredModel) {
    const normalized = normalizeModelId(configuredModel.value);
    if (isValidModel(normalized)) {
      const readyForModel = (option: RuntimeHarnessOption) =>
        option.ready &&
        option.routes.some((route) =>
          route.models.some((candidate) => candidate.model === normalized && candidate.ready)
        );
      const compatible =
        harnesses.find(
          (option) => option.harness === preferences.defaultAgentHarness && readyForModel(option)
        ) ?? harnesses.find(readyForModel);
      if (compatible) {
        harnessValue = compatible.harness;
        harnessSource = configuredModel.source;
        harnessInherited = configuredModel.inherited;
      }
    }
  }
  const harness = harnesses.find((option) => option.harness === harnessValue)!;
  if (!harness.ready) {
    issues.push({
      code: !harness.enabled
        ? "HARNESS_DISABLED"
        : !harness.runtimeAvailable
          ? "RUNTIME_UNAVAILABLE"
          : "ROUTE_NOT_READY",
      field: "harness",
      severity: "error",
      message: harness.disabledReason ?? `${harness.displayName} is not ready`,
      remediation: { kind: "open-settings", href: "/settings?tab=harnesses" },
    });
  }

  const model = selectModel({
    harness,
    requestedRoute: configuredRoute?.value,
    requestedModel: configuredModel?.value,
    issues,
  });
  const selectedRoute = model
    ? (harness.routes.find((route) => route.routeId === model.routeId) ?? null)
    : null;
  const effortSelection = selectEffort({
    model,
    requestedEffort: configuredEffort?.value,
    issues,
  });
  const settings = resolveSettings({
    harness,
    layers,
    issues,
  });

  const resolvedHarness = sourceValue(harnessValue, harnessSource, harnessInherited);
  const resolvedRoute = selectedRoute
    ? sourceValue(
        selectedRoute.routeId,
        configuredRoute?.source ?? configuredModel?.source ?? harnessSource,
        configuredRoute?.inherited ?? configuredModel?.inherited ?? harnessInherited
      )
    : null;
  const resolvedModel = model
    ? sourceValue(
        model.model,
        configuredModel?.source ?? harnessSource,
        configuredModel?.inherited ?? harnessInherited
      )
    : null;
  const resolvedEffort = model
    ? sourceValue(
        effortSelection.effort?.value ?? null,
        configuredEffort?.source ?? configuredModel?.source ?? harnessSource,
        configuredEffort?.inherited ?? configuredModel?.inherited ?? harnessInherited
      )
    : null;

  const effective = {
    target,
    harness: resolvedHarness,
    routeId: resolvedRoute,
    model: resolvedModel,
    effort: resolvedEffort,
    nativeEffort: effortSelection.effort?.nativeValue ?? null,
    settings,
  };
  const draftDigest = await digest({
    target,
    runtime: {
      harness: resolvedHarness.value,
      routeId: resolvedRoute?.value ?? null,
      model: resolvedModel?.value ?? null,
      effort: resolvedEffort?.value ?? null,
      nativeEffort: effortSelection.effort?.nativeValue ?? null,
      settings: Object.fromEntries(
        Object.entries(settings).map(([key, entry]) => [key, entry.value])
      ),
    },
  });
  const readyModels = harness.routes.flatMap((route) =>
    route.models.filter((candidate) => candidate.ready)
  );
  return {
    resolverVersion: RUNTIME_RESOLVER_VERSION,
    capabilityCatalogVersion: RUNTIME_CAPABILITY_CATALOG_VERSION,
    checkedAt: readiness.checkedAt,
    draftDigest,
    launchable:
      issues.every((issue) => issue.severity !== "error") &&
      Boolean(resolvedRoute && resolvedModel),
    effective,
    options: {
      harnesses,
      models: readyModels,
      efforts: model?.efforts ?? [],
      commands: buildRuntimeCommandOptions({ context: "draft", harness: harnessValue }),
    },
    issues,
  };
}
