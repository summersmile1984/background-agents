import type {
  ResolveRuntimeLaunchDraftResponse,
  SessionLaunchSpecV1,
} from "@open-inspect/shared/types/runtime-launch";

export function createSessionLaunchSpec(input: {
  resolved: ResolveRuntimeLaunchDraftResponse;
  skillsManifestId: string | null;
  caller: SessionLaunchSpecV1["caller"];
}): SessionLaunchSpecV1 {
  const { effective } = input.resolved;
  if (
    !input.resolved.launchable ||
    !effective.harness ||
    !effective.routeId ||
    !effective.model ||
    !effective.effort
  ) {
    throw new Error("Cannot build a launch specification from an unresolved runtime draft");
  }
  return {
    version: 1,
    resolverVersion: input.resolved.resolverVersion,
    capabilityCatalogVersion: input.resolved.capabilityCatalogVersion,
    resolvedAt: input.resolved.checkedAt,
    draftDigest: input.resolved.draftDigest,
    target: effective.target,
    runtime: {
      harness: effective.harness,
      routeId: effective.routeId,
      model: effective.model,
      effort: effective.effort,
      nativeEffort: effective.nativeEffort,
      settings: effective.settings,
    },
    skillsManifestId: input.skillsManifestId,
    caller: input.caller,
  };
}
