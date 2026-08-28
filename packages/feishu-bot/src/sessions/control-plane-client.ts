import {
  createSessionResponseSchema,
  sendPromptResponseSchema,
  type CallbackContext,
  type CreateSessionResponse,
  type SendPromptResponse,
} from "@open-inspect/shared/types/session-api";
import type { AgentHarness } from "@open-inspect/shared/types/agent-harness";
import type { VisualVerificationSelection } from "@open-inspect/shared/types/visual-verification";
import type { RuntimeConfigFragment } from "@open-inspect/shared/types/runtime-launch";
import { signedControlPlaneFetch, type ControlPlaneEnv } from "../internal-auth";
import type { FeishuRepositoryTarget } from "../targets";

const OUTBOUND_TIMEOUT_MS = 10_000;

type FeishuRuntimeHarness = AgentHarness | "inherit";

/**
 * Feishu currently supplies a deployment default model rather than a harness
 * picker. Preserve the configured default for provider-neutral models, but do
 * not send a native harness model to OpenCode by accident.
 */
export function defaultHarnessForModel(model: string): FeishuRuntimeHarness {
  if (model.startsWith("openai/")) return "codex";
  if (model.startsWith("anthropic/")) return "claude";
  if (model.startsWith("deepseek/")) return "deepseek";
  return "inherit";
}

export type SendPromptResult =
  | { ok: true; data: SendPromptResponse }
  | { ok: false; reason: "stale" | "transient" };

export async function createSession(input: {
  env: ControlPlaneEnv;
  target: FeishuRepositoryTarget;
  branch?: string;
  model: string;
  runtime?: RuntimeConfigFragment;
  actorId: string;
  traceId?: string;
}): Promise<CreateSessionResponse | null> {
  const body = JSON.stringify({
    repositoryKey: input.target.repositoryKey,
    ...(input.branch ? { branch: input.branch } : {}),
    runtime: {
      harness: input.runtime?.harness ?? defaultHarnessForModel(input.model),
      model: input.runtime?.model ?? input.model,
      ...(input.runtime?.routeId ? { routeId: input.runtime.routeId } : {}),
      ...(input.runtime?.effort ? { effort: input.runtime.effort } : {}),
      ...(input.runtime?.settings ? { settings: input.runtime.settings } : {}),
    },
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
  visualVerification?: VisualVerificationSelection;
  traceId?: string;
}): Promise<SendPromptResult> {
  const body = JSON.stringify({
    content: input.content,
    source: "feishu",
    callbackContext: input.callbackContext,
    ...(input.visualVerification ? { visualVerification: input.visualVerification } : {}),
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
