import type { SessionLaunchSpecV1 } from "@open-inspect/shared/types/runtime-launch";
import type { RequestContext } from "../routes/shared";

export interface RuntimeConfigurationOwner {
  scope: "user" | "integration";
  id: string;
}

/** Keep integration provenance identical between draft resolution and session creation. */
export function runtimeCallerChannel(
  ctx: RequestContext,
  provider: SessionLaunchSpecV1["target"]["provider"] = null
): SessionLaunchSpecV1["caller"]["channel"] {
  const principal = ctx.principal;
  if (!principal || principal.kind === "user" || principal.kind !== "service") return "web";
  if (principal.service === "slack-bot") return "slack";
  if (principal.service === "feishu-bot") return "feishu";
  if (principal.service === "linear-bot") return "linear";
  if (principal.service === "github-bot") return provider === "gitea" ? "gitea" : "github";
  return "web";
}

/**
 * Runtime configuration layers belonging to the verified request principal.
 * Service callers must assert an actor; body-carried identity is never used.
 */
export function runtimeConfigurationOwnersForRequest(
  ctx: RequestContext,
  provider: SessionLaunchSpecV1["target"]["provider"] = null
): RuntimeConfigurationOwner[] | null {
  const principal = ctx.principal;
  if (!principal) return null;
  if (principal.kind === "user") return [{ scope: "user", id: principal.userId }];
  if (principal.kind !== "service" || !principal.actor?.participantUserId) return null;

  const channel = runtimeCallerChannel(ctx, provider);
  return [
    ...(channel === "web" ? [] : [{ scope: "integration" as const, id: channel }]),
    { scope: "user", id: principal.actor.participantUserId },
  ];
}
