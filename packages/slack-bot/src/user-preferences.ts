import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
  resolveEnabledModel,
} from "@open-inspect/shared/models";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import type { UserPreferences } from "@open-inspect/shared/types/session-api";
import type { Env } from "./types";
import { runtimeConfigurationRecordSchema } from "@open-inspect/shared/types/runtime-launch";
import { agentHarnessSchema, type AgentHarness } from "@open-inspect/shared/types/agent-harness";
import { signedControlPlaneFetch } from "./internal-auth";
import {
  getValidatedBranch,
  isValidBranchName,
  normalizeBranchPreference,
} from "./branch-preferences";
import { createLogger } from "./logger";

const log = createLogger("user-preferences");

export interface ResolvedUserPreferences {
  agentHarness?: AgentHarness | "inherit";
  model: string;
  reasoningEffort: string | undefined;
  branch: string | undefined;
  /** False only when a legacy KV runtime preference could not be migrated yet. */
  canonicalRuntimeStored?: boolean;
}

async function getControlPlaneRuntimePreferences(
  env: Env,
  userId: string
): Promise<{ harness?: AgentHarness; model?: string; effort?: string } | null> {
  try {
    const actor = `slack:${userId}`;
    const response = await signedControlPlaneFetch(env, {
      method: "GET",
      url: `https://internal/agent-runtime/configurations/user/${encodeURIComponent(actor)}`,
      actor,
    });
    if (!response.ok) return null;
    const raw = (await response.json()) as { configuration?: unknown };
    const parsed = runtimeConfigurationRecordSchema.safeParse(raw.configuration);
    if (!parsed.success) return null;
    const model = parsed.data.config.model;
    const effort = parsed.data.config.effort;
    const harness = parsed.data.config.harness;
    return {
      ...(harness && harness !== "inherit" && agentHarnessSchema.safeParse(harness).success
        ? { harness: harness as AgentHarness }
        : {}),
      ...(model && model !== "inherit" ? { model } : {}),
      ...(effort && effort !== "inherit" ? { effort } : {}),
    };
  } catch {
    return null;
  }
}

async function saveControlPlaneRuntimePreferences(
  env: Env,
  userId: string,
  preferences: UserPreferences,
  harness: AgentHarness | "inherit"
): Promise<boolean> {
  try {
    const actor = `slack:${userId}`;
    const response = await signedControlPlaneFetch(env, {
      method: "PUT",
      url: `https://internal/agent-runtime/configurations/user/${encodeURIComponent(actor)}`,
      actor,
      body: JSON.stringify({
        config: {
          harness,
          model: preferences.model ?? "inherit",
          effort: preferences.reasoningEffort ?? "inherit",
        },
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

type UserPreferencesPatch = Partial<ResolvedUserPreferences>;
type UserPreferencesUpdater = (
  current: ResolvedUserPreferences
) => UserPreferencesPatch | null | undefined;

function getUserPreferencesKey(userId: string): string {
  return `user_prefs:${userId}`;
}

function hasPreferenceField<K extends keyof UserPreferencesPatch>(
  patch: UserPreferencesPatch,
  field: K
): patch is UserPreferencesPatch & Required<Pick<UserPreferencesPatch, K>> {
  return Object.prototype.hasOwnProperty.call(patch, field);
}

function normalizeResolvedPreferences(
  preferences: {
    model: string | undefined | null;
    reasoningEffort?: string;
    branch?: string;
  },
  defaultModel: string | undefined,
  options: { validateBranch?: boolean; enabledModels?: string[] } = {}
): ResolvedUserPreferences {
  const model = resolveEnabledModel({
    model: preferences.model,
    fallbackModel: defaultModel,
    enabledModels: options.enabledModels,
  });
  const reasoningEffort =
    preferences.reasoningEffort && isValidReasoningEffort(model, preferences.reasoningEffort)
      ? preferences.reasoningEffort
      : getDefaultReasoningEffort(model);
  const branch =
    options.validateBranch === false
      ? normalizeBranchPreference(preferences.branch)
      : getValidatedBranch(preferences.branch);

  return {
    agentHarness: "inherit",
    model,
    reasoningEffort,
    branch,
  };
}

function getNormalizedValidModel(model: string | undefined | null): string | undefined {
  if (model && isValidModel(model)) {
    return normalizeModelId(model);
  }

  return undefined;
}

function mergeUserPreferencesPatch(
  userId: string,
  current: UserPreferences | null,
  patch: UserPreferencesPatch,
  options: UserPreferenceResolutionOptions
): UserPreferences | null {
  const model = hasPreferenceField(patch, "model")
    ? getNormalizedValidModel(patch.model)
    : getNormalizedValidModel(current?.model);
  let reasoningEffort = hasPreferenceField(patch, "reasoningEffort")
    ? patch.reasoningEffort
    : hasPreferenceField(patch, "model")
      ? undefined
      : current?.reasoningEffort;
  const branch = hasPreferenceField(patch, "branch")
    ? normalizeBranchPreference(patch.branch)
    : normalizeBranchPreference(current?.branch);

  if (branch && !isValidBranchName(branch)) {
    log.warn("slack.branch_pref.invalid", {
      user_id: userId,
      branch,
    });
    return null;
  }

  const resolvedModel = resolveEnabledModel({
    model,
    fallbackModel: options.defaultModel ?? DEFAULT_MODEL,
    enabledModels: options.enabledModels,
  });
  if (reasoningEffort && !isValidReasoningEffort(resolvedModel, reasoningEffort)) {
    reasoningEffort = undefined;
  }

  const prefs: UserPreferences = { userId, updatedAt: Date.now() };
  if (model) prefs.model = model;
  if (reasoningEffort) prefs.reasoningEffort = reasoningEffort;
  if (branch) prefs.branch = branch;
  return prefs;
}

function isValidUserPreferences(data: unknown): data is UserPreferences {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }

  const obj = data as Record<string, unknown>;
  const modelValid = obj.model === undefined || typeof obj.model === "string";
  const reasoningEffortValid =
    obj.reasoningEffort === undefined || typeof obj.reasoningEffort === "string";
  const branchValid = obj.branch === undefined || typeof obj.branch === "string";

  return (
    typeof obj.userId === "string" &&
    modelValid &&
    reasoningEffortValid &&
    typeof obj.updatedAt === "number" &&
    branchValid
  );
}

export function resolveUserPreferences(
  prefs: UserPreferences | null | undefined,
  defaultModel: string | undefined,
  enabledModels?: string[]
): ResolvedUserPreferences {
  return normalizeResolvedPreferences(
    {
      model: prefs?.model ?? defaultModel ?? DEFAULT_MODEL,
      reasoningEffort: prefs?.reasoningEffort,
      branch: prefs?.branch,
    },
    defaultModel,
    { enabledModels }
  );
}

export interface UserPreferenceResolutionOptions {
  defaultModel?: string;
  enabledModels?: string[];
}

export async function getUserPreferences(
  env: Env,
  userId: string
): Promise<UserPreferences | null> {
  try {
    const key = getUserPreferencesKey(userId);
    const data = await createKvCacheStore(env.SLACK_KV).get(key, "json");
    return isValidUserPreferences(data) ? data : null;
  } catch (e) {
    log.error("kv.get", {
      key_prefix: "user_prefs",
      user_id: userId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return null;
  }
}

export async function getResolvedUserPreferences(
  env: Env,
  userId: string,
  options: UserPreferenceResolutionOptions = {}
): Promise<ResolvedUserPreferences> {
  const [prefs, runtime] = await Promise.all([
    getUserPreferences(env, userId),
    getControlPlaneRuntimePreferences(env, userId),
  ]);
  const resolved = resolveUserPreferences(
    runtime
      ? {
          userId,
          updatedAt: prefs?.updatedAt ?? Date.now(),
          model: runtime.model ?? prefs?.model,
          reasoningEffort: runtime.effort ?? prefs?.reasoningEffort,
          branch: prefs?.branch,
        }
      : prefs,
    options.defaultModel ?? env.DEFAULT_MODEL,
    options.enabledModels
  );
  const hasLegacyRuntimePreference = Boolean(prefs?.model || prefs?.reasoningEffort);
  const canonicalRuntimeStored =
    Boolean(runtime) || !hasLegacyRuntimePreference
      ? true
      : await saveControlPlaneRuntimePreferences(env, userId, prefs!, "inherit");
  return {
    ...resolved,
    agentHarness: runtime?.harness ?? "inherit",
    canonicalRuntimeStored,
  };
}

async function saveUserPreferences(
  env: Env,
  userId: string,
  preferences: UserPreferences,
  options: UserPreferenceResolutionOptions = {}
): Promise<boolean> {
  try {
    const model = getNormalizedValidModel(preferences.model);
    let reasoningEffort = preferences.reasoningEffort;
    const branch = normalizeBranchPreference(preferences.branch);
    if (branch && !isValidBranchName(branch)) {
      log.warn("slack.branch_pref.invalid", {
        user_id: userId,
        branch,
      });
      return false;
    }
    const resolvedModel = resolveEnabledModel({
      model,
      fallbackModel: options.defaultModel ?? env.DEFAULT_MODEL,
      enabledModels: options.enabledModels,
    });
    if (reasoningEffort && !isValidReasoningEffort(resolvedModel, reasoningEffort)) {
      reasoningEffort = undefined;
    }

    const prefs: UserPreferences = { userId, updatedAt: Date.now() };
    if (model) prefs.model = model;
    if (reasoningEffort) prefs.reasoningEffort = reasoningEffort;
    if (branch) prefs.branch = branch;

    await createKvCacheStore(env.SLACK_KV).put(
      getUserPreferencesKey(userId),
      JSON.stringify(prefs)
    );
    return true;
  } catch (e) {
    log.error("kv.put", {
      key_prefix: "user_prefs",
      user_id: userId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return false;
  }
}

export async function updateUserPreferences(
  env: Env,
  userId: string,
  patchOrUpdater: UserPreferencesPatch | UserPreferencesUpdater,
  options: UserPreferenceResolutionOptions = {}
): Promise<boolean> {
  const [current, runtimeCurrent] = await Promise.all([
    getUserPreferences(env, userId),
    getControlPlaneRuntimePreferences(env, userId),
  ]);
  const resolvedCurrent = resolveUserPreferences(
    current,
    options.defaultModel ?? env.DEFAULT_MODEL,
    options.enabledModels
  );
  const patch =
    typeof patchOrUpdater === "function" ? patchOrUpdater(resolvedCurrent) : patchOrUpdater;
  if (!patch) {
    return false;
  }

  const merged = mergeUserPreferencesPatch(userId, current, patch, {
    defaultModel: options.defaultModel ?? env.DEFAULT_MODEL,
    enabledModels: options.enabledModels,
  });
  if (!merged) return false;
  const savedKv = await saveUserPreferences(env, userId, merged, options);
  const updatesRuntime =
    hasPreferenceField(patch, "model") || hasPreferenceField(patch, "reasoningEffort");
  const savedRuntime = updatesRuntime
    ? await saveControlPlaneRuntimePreferences(
        env,
        userId,
        merged,
        runtimeCurrent?.harness ?? "inherit"
      )
    : true;
  return savedKv && savedRuntime;
}

export async function updateUserHarnessPreference(
  env: Env,
  userId: string,
  harness: AgentHarness | "inherit"
): Promise<boolean> {
  const [current, runtimeCurrent] = await Promise.all([
    getUserPreferences(env, userId),
    getControlPlaneRuntimePreferences(env, userId),
  ]);
  const preferences: UserPreferences = current ?? { userId, updatedAt: Date.now() };
  if (runtimeCurrent?.model) preferences.model = runtimeCurrent.model;
  if (runtimeCurrent?.effort) preferences.reasoningEffort = runtimeCurrent.effort;
  return saveControlPlaneRuntimePreferences(env, userId, preferences, harness);
}
