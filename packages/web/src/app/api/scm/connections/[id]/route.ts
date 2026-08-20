import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Context) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const response = await controlPlaneUserFetch(`/scm/connections/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(await request.json()),
    });
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Failed to update SCM connection:", error);
    return NextResponse.json({ error: "Failed to update SCM connection" }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: Context) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const response = await controlPlaneUserFetch(
      `/scm/connections/${encodeURIComponent(id)}/disable`,
      { method: "POST" }
    );
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Failed to disable SCM connection:", error);
    return NextResponse.json({ error: "Failed to disable SCM connection" }, { status: 500 });
  }
}
