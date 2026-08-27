import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidReasoningEffort,
  resolveEnabledModel,
} from "@open-inspect/shared/models";

export interface ModelPreference {
  model: string;
  reasoningEffort?: string;
}

/**
 * Locked native-harness sessions must keep the exact runtime selected by their
 * immutable LaunchSpec. Runtime readiness can temporarily make the live option
 * list empty; treating that as an ordinary enabled-model list would silently
 * fall back to DEFAULT_MODEL and make the control plane reject the prompt as a
 * forbidden live runtime change.
 */
export function resolveSessionModelPreference(
  preference: ModelPreference,
  enabledModels: string[] | undefined,
  pinnedPreference?: ModelPreference | null
): ModelPreference {
  return pinnedPreference ?? resolveModelPreference(preference, enabledModels);
}

export function resolveModelPreference(
  preference: ModelPreference,
  enabledModels: string[] | undefined
): ModelPreference {
  const model = enabledModels
    ? resolveEnabledModel({
        model: preference.model,
        enabledModels,
        fallbackModel: DEFAULT_MODEL,
      })
    : getValidModelOrDefault(preference.model);
  return {
    model,
    reasoningEffort:
      preference.reasoningEffort && isValidReasoningEffort(model, preference.reasoningEffort)
        ? preference.reasoningEffort
        : getDefaultReasoningEffort(model),
  };
}
