import {
  createSessionResponseSchema,
  sendPromptResponseSchema,
  type CallbackContext,
  type CreateSessionResponse,
  type SendPromptResponse,
} from "@open-inspect/shared/types/session-api";
import { signedControlPlaneFetch, type ControlPlaneEnv } from "../internal-auth";
import type { FeishuRepositoryTarget } from "../targets";

const OUTBOUND_TIMEOUT_MS = 10_000;

export type SendPromptResult =
  | { ok: true; data: SendPromptResponse }
  | { ok: false; reason: "stale" | "transient" };

export async function createSession(input: {
  env: ControlPlaneEnv;
  target: FeishuRepositoryTarget;
  model: string;
  actorId: string;
  traceId?: string;
}): Promise<CreateSessionResponse | null> {
  const body = JSON.stringify({
    repositoryKey: input.target.repositoryKey,
    runtime: { harness: "inherit", model: input.model },
  });
  const response = await signedControlPlaneFetch(
    input.env,
    {
      method: "POST",
      url: "https://internal/sessions",
      body,
      actor: input.actorId,
      traceId: input.traceId,
    },
    { signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) }
  ).catch(() => null);
  if (!response?.ok) return null;
  const parsed = createSessionResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export async function sendPrompt(input: {
  env: ControlPlaneEnv;
  sessionId: string;
  content: string;
  actorId: string;
  callbackContext: CallbackContext;
  traceId?: string;
}): Promise<SendPromptResult> {
  const body = JSON.stringify({
    content: input.content,
    source: "feishu",
    callbackContext: input.callbackContext,
  });
  const response = await signedControlPlaneFetch(
    input.env,
    {
      method: "POST",
      url: `https://internal/sessions/${encodeURIComponent(input.sessionId)}/prompt`,
      body,
      actor: input.actorId,
      traceId: input.traceId,
    },
    { signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) }
  ).catch(() => null);
  if (!response?.ok) return { ok: false, reason: response?.status === 404 ? "stale" : "transient" };
  const parsed = sendPromptResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, reason: "transient" };
}
