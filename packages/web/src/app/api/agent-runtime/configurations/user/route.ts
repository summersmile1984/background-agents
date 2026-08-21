import { NextResponse } from "next/server";
import { runtimeConfigFragmentSchema } from "@open-inspect/shared/types/runtime-launch";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { getServerAuthSession } from "@/lib/server-auth-session";

async function userPath(): Promise<string | null> {
  const session = await getServerAuthSession();
  return session?.user?.id
    ? `/agent-runtime/configurations/user/${encodeURIComponent(session.user.id)}`
    : null;
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

export async function GET() {
  const path = await userPath();
  if (!path) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return forward(await controlPlaneUserFetch(path));
}

export async function PUT(request: Request) {
  const path = await userPath();
  if (!path) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

export async function DELETE() {
  const path = await userPath();
  if (!path) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return forward(await controlPlaneUserFetch(path, { method: "DELETE" }));
}
