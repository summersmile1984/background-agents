import {
  signedControlPlaneFetch as sharedSignedControlPlaneFetch,
  type OutboundRequestToSign,
  type SignedFetchInit,
} from "@open-inspect/shared/service-auth";
import type { Env } from "./types";

export type ControlPlaneEnv = Pick<Env, "CONTROL_PLANE" | "SERVICE_AUTH_SECRET">;

export function signedControlPlaneFetch(
  env: ControlPlaneEnv,
  request: OutboundRequestToSign,
  init?: SignedFetchInit
): Promise<Response> {
  return sharedSignedControlPlaneFetch("feishu-bot", env, request, init);
}
