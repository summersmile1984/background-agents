import { NextResponse } from "next/server";
import {
  persistedRuntimeConfigurationScopeSchema,
  runtimeConfigFragmentSchema,
} from "@open-inspect/shared/types/runtime-launch";
import { controlPlaneUserFetch } from "@/lib/control-plane";

type RouteContext = { params: Promise<{ scope: string; scopeId: string }> };

async function controlPlanePath(context: RouteContext): Promise<string | null> {
  const { scope, scopeId } = await context.params;
  const parsedScope = persistedRuntimeConfigurationScopeSchema.safeParse(scope);
  if (!parsedScope.success || parsedScope.data === "user" || !scopeId) return null;
  return `/agent-runtime/configurations/${parsedScope.data}/${encodeURIComponent(scopeId)}`;
}

function forward(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    },
  });
}

export async function GET(_request: Request, context: RouteContext) {
  const path = await controlPlanePath(context);
  if (!path)
    return NextResponse.json({ error: "Invalid runtime configuration scope" }, { status: 400 });
  return forward(await controlPlaneUserFetch(path));
}

export async function PUT(request: Request, context: RouteContext) {
  const path = await controlPlanePath(context);
  if (!path)
    return NextResponse.json({ error: "Invalid runtime configuration scope" }, { status: 400 });
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid runtime configuration" }, { status: 400 });
  }
  const parsed = runtimeConfigFragmentSchema.safeParse(
    raw && typeof raw === "object" && "config" in raw ? (raw as { config: unknown }).config : raw
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid runtime configuration" },
      { status: 400 }
    );
  }
  return forward(
    await controlPlaneUserFetch(path, {
      method: "PUT",
      body: JSON.stringify({ config: parsed.data }),
    })
  );
}

export async function DELETE(_request: Request, context: RouteContext) {
  const path = await controlPlanePath(context);
  if (!path)
    return NextResponse.json({ error: "Invalid runtime configuration scope" }, { status: 400 });
  return forward(await controlPlaneUserFetch(path, { method: "DELETE" }));
}
