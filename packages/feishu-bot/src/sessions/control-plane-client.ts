import {
  createSessionErrorResponseSchema,
  createSessionResponseSchema,
  sendPromptResponseSchema,
  type CallbackContext,
  type CreateSessionResponse,
  type SendPromptResponse,
} from "@open-inspect/shared/types/session-api";
import type { AgentHarness } from "@open-inspect/shared/types/agent-harness";
import type { VisualVerificationSelection } from "@open-inspect/shared/types/visual-verification";
import type {
  ResolveRuntimeLaunchDraftResponse,
  RuntimeCommandOption,
  RuntimeConfigFragment,
  RuntimeLaunchTarget,
} from "@open-inspect/shared/types/runtime-launch";
import { signedControlPlaneFetch, type ControlPlaneEnv } from "../internal-auth";
import type { FeishuRepositoryTarget } from "../targets";

const OUTBOUND_TIMEOUT_MS = 10_000;
const OUTBOUND_MAX_ATTEMPTS = 2;

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

export interface RuntimeCommandResponse {
  invocationId?: string;
  commandId?: string;
  status?: string;
  action?: string;
  error?: string;
  commands?: RuntimeCommandOption[];
  runtime?: {
    target?: {
      provider?: string | null;
      repositories?: Array<{ owner: string; name: string; branch: string }>;
    };
    harness?: string;
    routeId?: string;
    model?: string;
    effort?: string | null;
    sandboxStatus?: string | null;
    sessionStatus?: string | null;
  };
}

export type CreateResolvedSessionResult =
  | { ok: true; data: CreateSessionResponse }
  | {
      ok: false;
      reason: "capability_changed" | "conflict" | "invalid" | "unavailable";
      status?: number;
      error: string;
      draft?: ResolveRuntimeLaunchDraftResponse;
      sessionId?: string;
    };

function targetCreateBody(target: RuntimeLaunchTarget): Record<string, unknown> {
  switch (target.kind) {
    case "none":
      return {};
    case "repository":
      return {
        repositoryKey: target.repositoryKey,
        ...(target.branch ? { branch: target.branch } : {}),
      };
    case "repository-set":
      return { repositoryKeys: target.repositoryKeys };
    case "environment":
      return { environmentId: target.environmentId };
  }
}

async function fetchControlPlaneWithRetry(
  request: () => Promise<Response>
): Promise<Response | null> {
  for (let attempt = 1; attempt <= OUTBOUND_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await request();
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt === OUTBOUND_MAX_ATTEMPTS) return response;
      await response.body?.cancel();
    } catch {
      if (attempt === OUTBOUND_MAX_ATTEMPTS) return null;
    }
  }
  return null;
}

/** Create from a target-aware resolved draft without guessing a harness from the model name. */
export async function createResolvedSession(input: {
  env: ControlPlaneEnv;
  target: RuntimeLaunchTarget;
  runtime?: RuntimeConfigFragment;
  runtimeDraftDigest: string;
  clientRequestId: string;
  actorId: string;
  traceId?: string;
}): Promise<CreateResolvedSessionResult> {
  const body = JSON.stringify({
    ...targetCreateBody(input.target),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    runtimeDraftDigest: input.runtimeDraftDigest,
    clientRequestId: input.clientRequestId,
  });
  const response = await fetchControlPlaneWithRetry(() =>
    signedControlPlaneFetch(
      input.env,
      {
        method: "POST",
        url: "https://internal/sessions",
        body,
        actor: input.actorId,
        traceId: input.traceId,
      },
      { signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) }
    )
  );
  if (!response) {
    return { ok: false, reason: "unavailable", error: "创建会话结果暂时未知，请重试。" };
  }
  const payload = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = createSessionResponseSchema.safeParse(payload);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, reason: "unavailable", error: "Control Plane 返回了无效会话响应。" };
  }
  const parsed = createSessionErrorResponseSchema.safeParse(payload);
  const error = parsed.success ? parsed.data.error : "Control Plane 拒绝创建会话。";
  if (response.status === 409 && parsed.success && parsed.data.code === "CAPABILITY_CHANGED") {
    return {
      ok: false,
      reason: "capability_changed",
      status: response.status,
      error,
      ...(parsed.data.draft ? { draft: parsed.data.draft } : {}),
    };
  }
  if (response.status === 409) {
    return {
      ok: false,
      reason: "conflict",
      status: response.status,
      error,
      ...(parsed.success && parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
    };
  }
  return {
    ok: false,
    reason: response.status >= 500 || response.status === 429 ? "unavailable" : "invalid",
    status: response.status,
    error,
  };
}

export type RuntimeCommandResult =
  | { ok: true; data: RuntimeCommandResponse }
  | { ok: false; reason: "stale" | "transient" | "unavailable"; status?: number; error?: string };

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
  clientRequestId?: string;
  traceId?: string;
}): Promise<SendPromptResult> {
  const body = JSON.stringify({
    content: input.content,
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    source: "feishu",
    callbackContext: input.callbackContext,
    ...(input.visualVerification ? { visualVerification: input.visualVerification } : {}),
  });
  const response = await fetchControlPlaneWithRetry(() =>
    signedControlPlaneFetch(
      input.env,
      {
        method: "POST",
        url: `https://internal/sessions/${encodeURIComponent(input.sessionId)}/prompt`,
        body,
        actor: input.actorId,
        traceId: input.traceId,
      },
      { signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) }
    )
  );
  if (!response?.ok) return { ok: false, reason: response?.status === 404 ? "stale" : "transient" };
  const parsed = sendPromptResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, reason: "transient" };
}

/** Invoke a product-owned slash command against an existing session. */
export async function invokeRuntimeCommand(input: {
  env: ControlPlaneEnv;
  sessionId: string;
  commandId: string;
  clientInvocationId: string;
  actorId: string;
  traceId?: string;
}): Promise<RuntimeCommandResult> {
  const body = JSON.stringify({
    commandId: input.commandId,
    arguments: {},
    clientInvocationId: input.clientInvocationId,
  });
  const response = await signedControlPlaneFetch(
    input.env,
    {
      method: "POST",
      url: `https://internal/sessions/${encodeURIComponent(input.sessionId)}/commands`,
      body,
      actor: input.actorId,
      traceId: input.traceId,
    },
    { signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) }
  ).catch(() => null);
  if (!response) return { ok: false, reason: "transient" };
  const payload = (await response.json().catch(() => ({}))) as RuntimeCommandResponse;
  if (!response.ok) {
    return {
      ok: false,
      reason: response.status === 404 ? "stale" : "unavailable",
      status: response.status,
      error: payload.error,
    };
  }
  return { ok: true, data: payload };
}
