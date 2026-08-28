import type {
  RuntimeCommandOption,
  RuntimeHarnessOption,
  RuntimeModelOption,
} from "@open-inspect/shared/types/runtime-launch";
import { agentHarnessSchema } from "@open-inspect/shared/types/agent-harness";
import { signedControlPlaneFetch, type ControlPlaneEnv } from "../internal-auth";

const CATALOG_FETCH_TIMEOUT_MS = 10_000;

export interface FeishuRuntimeCatalog {
  harnesses: RuntimeHarnessOption[];
  commands: RuntimeCommandOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasReadyModel(value: unknown): value is RuntimeModelOption {
  if (!isRecord(value)) return false;
  return (
    typeof value.model === "string" &&
    typeof value.displayName === "string" &&
    typeof value.routeId === "string" &&
    value.ready === true &&
    Array.isArray(value.efforts)
  );
}

function isRuntimeHarness(value: unknown): value is RuntimeHarnessOption {
  if (!isRecord(value)) return false;
  if (
    typeof value.harness !== "string" ||
    typeof value.displayName !== "string" ||
    value.ready !== true ||
    !Array.isArray(value.routes) ||
    !Array.isArray(value.settings)
  ) {
    return false;
  }
  if (!agentHarnessSchema.safeParse(value.harness).success) return false;
  return value.routes.some(
    (route) =>
      isRecord(route) &&
      route.ready === true &&
      typeof route.routeId === "string" &&
      Array.isArray(route.models) &&
      route.models.some(hasReadyModel)
  );
}

function isRuntimeCommand(value: unknown): value is RuntimeCommandOption {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.slashName === "string" &&
    typeof value.title === "string" &&
    typeof value.available === "boolean"
  );
}

/**
 * Fetch the same readiness-aware runtime catalog used by the Web launch UI.
 * The response is treated as untrusted JSON even though it comes from the
 * signed control-plane service route; malformed entries are ignored so a
 * partial deployment cannot put invalid values into a Feishu card.
 */
export async function getRuntimeCatalog(
  env: ControlPlaneEnv,
  traceId?: string
): Promise<FeishuRuntimeCatalog | null> {
  try {
    const response = await signedControlPlaneFetch(
      env,
      { method: "GET", url: "https://internal/agent-runtime/catalog", traceId },
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
      }
    );
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body) || !Array.isArray(body.catalog)) return null;
    return {
      harnesses: body.catalog.filter(isRuntimeHarness),
      commands: Array.isArray(body.commands) ? body.commands.filter(isRuntimeCommand) : [],
    };
  } catch {
    return null;
  }
}
