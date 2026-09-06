import {
  resolveRuntimeLaunchDraftResponseSchema,
  type ResolveRuntimeLaunchDraftResponse,
  type RuntimeConfigFragment,
  type RuntimeLaunchTarget,
} from "@open-inspect/shared/types/runtime-launch";
import { signedControlPlaneFetch, type ControlPlaneEnv } from "../internal-auth";
import { createLogger } from "../logger";

const RUNTIME_DRAFT_TIMEOUT_MS = 10_000;
const log = createLogger("runtime-draft");

export type ResolveFeishuRuntimeDraftResult =
  | { ok: true; data: ResolveRuntimeLaunchDraftResponse }
  | {
      ok: false;
      reason: "invalid" | "unavailable";
      status?: number;
      code?: string;
      error: string;
    };

export async function resolveFeishuRuntimeDraft(input: {
  env: ControlPlaneEnv;
  actorId: string;
  target: RuntimeLaunchTarget;
  runtime?: RuntimeConfigFragment;
  traceId?: string;
}): Promise<ResolveFeishuRuntimeDraftResult> {
  let response: Response;
  try {
    response = await signedControlPlaneFetch(
      input.env,
      {
        method: "POST",
        url: "https://internal/agent-runtime/resolve-draft",
        body: JSON.stringify({
          target: input.target,
          ...(input.runtime ? { runtime: input.runtime } : {}),
        }),
        actor: input.actorId,
        traceId: input.traceId,
      },
      { signal: AbortSignal.timeout(RUNTIME_DRAFT_TIMEOUT_MS) }
    );
  } catch (error) {
    log.warn("runtime.resolve_failed", {
      trace_id: input.traceId,
      failure: "transport",
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return { ok: false, reason: "unavailable", error: "运行时解析暂时不可用，请重试。" };
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const failure =
      payload && typeof payload === "object"
        ? (payload as { code?: unknown; error?: unknown })
        : undefined;
    return {
      ok: false,
      reason: response.status >= 500 || response.status === 429 ? "unavailable" : "invalid",
      status: response.status,
      ...(typeof failure?.code === "string" ? { code: failure.code } : {}),
      error:
        typeof failure?.error === "string"
          ? failure.error
          : response.status >= 500
            ? "运行时解析暂时不可用，请重试。"
            : "当前目标或 Runtime 配置不可用。",
    };
  }
  const parsed = resolveRuntimeLaunchDraftResponseSchema.safeParse(payload);
  if (!parsed.success) {
    log.error("runtime.resolve_failed", {
      trace_id: input.traceId,
      failure: "invalid_response",
      issue_paths: parsed.error.issues.slice(0, 8).map((issue) => issue.path.join(".")),
    });
    return { ok: false, reason: "unavailable", error: "运行时解析返回无效，请稍后重试。" };
  }
  return { ok: true, data: parsed.data };
}
