import { z } from "zod";
import { agentHarnessSchema, type AgentHarness } from "./agent-harness";
import { sourceControlProviderNameSchema, type SourceControlProviderName } from "./source-control";
import type { SessionSkillSelection } from "./skills";

export const RUNTIME_LAUNCH_SPEC_VERSION = 1 as const;

export const runtimeLaunchTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("repository"),
    repositoryKey: z.string().trim().min(1),
    branch: z.string().trim().min(1).optional(),
    /** Preserve environment-scoped defaults and secrets for a single-repository child session. */
    environmentId: z.string().trim().min(1).optional(),
  }),
  z.object({
    kind: z.literal("repository-set"),
    repositoryKeys: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(10)
      .refine((keys) => new Set(keys).size === keys.length, {
        message: "repositoryKeys must not contain duplicates",
      }),
  }),
  z.object({
    kind: z.literal("environment"),
    environmentId: z.string().trim().min(1),
  }),
]);

export type RuntimeLaunchTarget = z.infer<typeof runtimeLaunchTargetSchema>;

export const runtimeConfigFragmentSchema = z.object({
  harness: z.union([agentHarnessSchema, z.literal("inherit")]).optional(),
  routeId: z.union([z.string().trim().min(1), z.literal("auto")]).optional(),
  model: z.union([z.string().trim().min(1), z.literal("inherit")]).optional(),
  effort: z.union([z.string().trim().min(1), z.literal("inherit")]).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export type RuntimeConfigFragment = z.infer<typeof runtimeConfigFragmentSchema>;

export const resolveRuntimeLaunchDraftRequestSchema = z.object({
  target: runtimeLaunchTargetSchema,
  runtime: runtimeConfigFragmentSchema.optional(),
});

export type ResolveRuntimeLaunchDraftRequest = z.infer<
  typeof resolveRuntimeLaunchDraftRequestSchema
>;

export type RuntimeConfigurationScope =
  | "installation"
  | "user"
  | "integration"
  | "repository"
  | "environment"
  | "automation"
  | "session";

export const persistedRuntimeConfigurationScopeSchema = z.enum([
  "installation",
  "user",
  "integration",
  "repository",
  "environment",
]);

export type PersistedRuntimeConfigurationScope = z.infer<
  typeof persistedRuntimeConfigurationScopeSchema
>;

export const runtimeConfigurationRecordSchema = z.object({
  id: z.string().min(1),
  scope: persistedRuntimeConfigurationScopeSchema,
  scopeId: z.string().min(1),
  config: runtimeConfigFragmentSchema,
  schemaVersion: z.literal(1),
  createdBy: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type RuntimeConfigurationRecord = z.infer<typeof runtimeConfigurationRecordSchema>;

export interface ResolvedRuntimeValue<T> {
  value: T;
  source: {
    scope: RuntimeConfigurationScope;
    id: string | null;
  };
  inherited: boolean;
}

export type RuntimeSelectionField =
  | "target"
  | "harness"
  | "route"
  | "model"
  | "effort"
  | "settings"
  | "command";

export type RuntimeSelectionIssueCode =
  | "TARGET_REQUIRED"
  | "TARGET_UNAVAILABLE"
  | "SCM_CONNECTION_MISMATCH"
  | "HARNESS_DISABLED"
  | "RUNTIME_UNAVAILABLE"
  | "ROUTE_NOT_READY"
  | "PROVIDER_UNAVAILABLE"
  | "MODEL_DISABLED"
  | "MODEL_INCOMPATIBLE"
  | "CREDENTIAL_MISSING"
  | "CREDENTIAL_EXPIRED"
  | "RELAY_UNAVAILABLE"
  | "EFFORT_UNSUPPORTED"
  | "SETTING_INVALID"
  | "COMMAND_UNAVAILABLE"
  | "CAPABILITY_CHANGED";

export interface RuntimeSelectionIssue {
  code: RuntimeSelectionIssueCode;
  field: RuntimeSelectionField;
  severity: "error" | "warning";
  message: string;
  remediation?: {
    kind: "open-settings" | "contact-operator" | "choose-another-route";
    href?: string;
  };
}

export interface ResolvedRuntimeRepositorySnapshot {
  repositoryKey: string;
  connectionId: string;
  externalRepositoryId: string;
  owner: string;
  name: string;
  branch: string;
  position: number;
  webUrl: string;
  cloneUrl: string;
}

export interface ResolvedRuntimeTargetSnapshot {
  kind: RuntimeLaunchTarget["kind"];
  connectionId: string | null;
  provider: SourceControlProviderName | null;
  environmentId: string | null;
  repositories: ResolvedRuntimeRepositorySnapshot[];
}

export type RuntimeTransport = "native" | "host-relay" | "opencode-provider";

export interface RuntimeEffortOption {
  value: string;
  label: string;
  nativeValue: string;
  isDefault: boolean;
}

export interface RuntimeModelOption {
  model: string;
  displayName: string;
  description: string;
  category: string;
  routeId: string;
  provider: string;
  enabled: boolean;
  ready: boolean;
  disabledReason?: string;
  efforts: RuntimeEffortOption[];
  supportsAttachments: boolean;
  supportsToolEvents: boolean;
  supportsLiveModelSwitch: boolean;
}

export interface RuntimeRouteOption {
  routeId: string;
  harness: AgentHarness;
  provider: string;
  transport: RuntimeTransport;
  displayName: string;
  ready: boolean;
  code: RuntimeSelectionIssueCode | "READY";
  message?: string;
  models: RuntimeModelOption[];
}

export interface RuntimeSettingDefinition {
  key: string;
  label: string;
  description: string;
  type: "boolean" | "string" | "integer" | "enum" | "string-list";
  defaultValue: unknown;
  enumOptions?: Array<{ value: string; label: string }>;
  allowedScopes: RuntimeConfigurationScope[];
  mutability: "session-start" | "per-turn";
  visibility: "user" | "operator" | "read-only";
  sensitive: false;
  constraints?: Record<string, unknown>;
}

export interface RuntimeHarnessOption {
  harness: AgentHarness;
  displayName: string;
  description: string;
  enabled: boolean;
  runtimeAvailable: boolean;
  ready: boolean;
  disabledReason?: string;
  settingsSchemaVersion: string;
  settings: RuntimeSettingDefinition[];
  liveMutation: {
    model: boolean;
    effort: boolean;
    settings: string[];
  };
  routes: RuntimeRouteOption[];
}

export type RuntimeCommandContext = "draft" | "idle-session" | "running-session";
export type RuntimeCommandExecution = "control-plane" | "driver" | "prompt-transform";

export interface RuntimeCommandArgumentDefinition {
  name: string;
  label: string;
  type: "string" | "enum";
  required: boolean;
  options?: Array<{ value: string; label: string }>;
}

export interface RuntimeCommandDefinition {
  id: string;
  slashName: string;
  title: string;
  description: string;
  group: "session" | "runtime" | "harness";
  owner: "product" | "harness";
  harnesses: AgentHarness[] | "all";
  contexts: RuntimeCommandContext[];
  execution: RuntimeCommandExecution;
  arguments: RuntimeCommandArgumentDefinition[];
  mutates: Array<"session" | "model" | "effort" | "context">;
}

export interface RuntimeCommandOption extends RuntimeCommandDefinition {
  available: boolean;
  unavailableReason?: string;
}

export const runtimeCommandInvocationSchema = z.object({
  commandId: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
  clientInvocationId: z.string().trim().min(1).max(128),
});

export type RuntimeCommandInvocation = z.infer<typeof runtimeCommandInvocationSchema>;

export interface ResolvedRuntimeLaunchDraft {
  target: ResolvedRuntimeTargetSnapshot;
  harness: ResolvedRuntimeValue<AgentHarness> | null;
  routeId: ResolvedRuntimeValue<string> | null;
  model: ResolvedRuntimeValue<string> | null;
  effort: ResolvedRuntimeValue<string | null> | null;
  nativeEffort: string | null;
  settings: Record<string, ResolvedRuntimeValue<unknown>>;
}

export interface ResolveRuntimeLaunchDraftResponse {
  resolverVersion: string;
  capabilityCatalogVersion: string;
  checkedAt: number;
  draftDigest: string;
  launchable: boolean;
  effective: ResolvedRuntimeLaunchDraft;
  options: {
    harnesses: RuntimeHarnessOption[];
    models: RuntimeModelOption[];
    efforts: RuntimeEffortOption[];
    commands: RuntimeCommandOption[];
  };
  issues: RuntimeSelectionIssue[];
}

export interface SessionLaunchSpecV1 {
  version: typeof RUNTIME_LAUNCH_SPEC_VERSION;
  resolverVersion: string;
  capabilityCatalogVersion: string;
  resolvedAt: number;
  draftDigest: string;
  target: ResolvedRuntimeTargetSnapshot;
  runtime: {
    harness: ResolvedRuntimeValue<AgentHarness>;
    routeId: ResolvedRuntimeValue<string>;
    model: ResolvedRuntimeValue<string>;
    effort: ResolvedRuntimeValue<string | null>;
    nativeEffort: string | null;
    settings: Record<string, ResolvedRuntimeValue<unknown>>;
  };
  skillsManifestId: string | null;
  caller: {
    channel: "web" | "slack" | "github" | "gitea" | "linear" | "automation" | "child";
    canonicalUserId: string | null;
    integrationId: string | null;
  };
}

export interface RuntimeLaunchInput {
  target: RuntimeLaunchTarget;
  runtime?: RuntimeConfigFragment;
  skills?: SessionSkillSelection;
}

const runtimeConfigurationScopeSchema = z.enum([
  "installation",
  "user",
  "integration",
  "repository",
  "environment",
  "automation",
  "session",
]);

function resolvedRuntimeValueSchema<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value,
    source: z.object({
      scope: runtimeConfigurationScopeSchema,
      id: z.string().nullable(),
    }),
    inherited: z.boolean(),
  });
}

const resolvedRuntimeRepositorySnapshotSchema = z.object({
  repositoryKey: z.string().min(1),
  connectionId: z.string().min(1),
  externalRepositoryId: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  branch: z.string().min(1),
  position: z.number().int().nonnegative(),
  webUrl: z.string().url(),
  cloneUrl: z.string().url(),
});

const resolvedRuntimeTargetSnapshotSchema = z.object({
  kind: z.enum(["none", "repository", "repository-set", "environment"]),
  connectionId: z.string().min(1).nullable(),
  provider: sourceControlProviderNameSchema.nullable(),
  environmentId: z.string().min(1).nullable(),
  repositories: z.array(resolvedRuntimeRepositorySnapshotSchema),
});

export const runtimeLaunchCallerChannelSchema = z.enum([
  "web",
  "slack",
  "github",
  "gitea",
  "linear",
  "automation",
  "child",
]);

/** Immutable, secret-free execution contract persisted before sandbox spawn. */
export const sessionLaunchSpecV1Schema = z.object({
  version: z.literal(RUNTIME_LAUNCH_SPEC_VERSION),
  resolverVersion: z.string().min(1),
  capabilityCatalogVersion: z.string().min(1),
  resolvedAt: z.number().int().nonnegative(),
  draftDigest: z.string().regex(/^[a-f0-9]{64}$/),
  target: resolvedRuntimeTargetSnapshotSchema,
  runtime: z.object({
    harness: resolvedRuntimeValueSchema(agentHarnessSchema),
    routeId: resolvedRuntimeValueSchema(z.string().min(1)),
    model: resolvedRuntimeValueSchema(z.string().min(1)),
    effort: resolvedRuntimeValueSchema(z.string().min(1).nullable()),
    nativeEffort: z.string().min(1).nullable(),
    settings: z.record(z.string(), resolvedRuntimeValueSchema(z.unknown())),
  }),
  skillsManifestId: z.string().min(1).nullable(),
  caller: z.object({
    channel: runtimeLaunchCallerChannelSchema,
    canonicalUserId: z.string().min(1).nullable(),
    integrationId: z.string().min(1).nullable(),
  }),
}) satisfies z.ZodType<SessionLaunchSpecV1>;
