import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = JSON.stringify(await request.json());
    const response = await controlPlaneUserFetch("/scm/migration/backfill", {
      method: "POST",
      body,
    });
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Failed to run SCM backfill:", error);
    return NextResponse.json({ error: "Failed to run SCM backfill" }, { status: 500 });
  }
}
