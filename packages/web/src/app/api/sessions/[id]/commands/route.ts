import { NextResponse } from "next/server";
import { runtimeCommandInvocationSchema } from "@open-inspect/shared/types/runtime-launch";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid command body" }, { status: 400 });
  }
  const parsed = runtimeCommandInvocationSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid command body" }, { status: 400 });
  }
  const { id } = await params;
  const response = await controlPlaneUserFetch(`/sessions/${encodeURIComponent(id)}/commands`, {
    method: "POST",
    body: JSON.stringify(parsed.data),
  });
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    },
  });
}
