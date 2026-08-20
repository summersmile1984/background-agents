import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const response = await controlPlaneUserFetch("/scm/connections/preflight", {
      method: "POST",
      body: JSON.stringify(await request.json()),
    });
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Failed to run SCM connection preflight:", error);
    return NextResponse.json({ error: "Failed to run connection preflight" }, { status: 500 });
  }
}
