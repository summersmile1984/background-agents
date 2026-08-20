import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

async function forward(method: "GET" | "POST", request?: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = method === "POST" && request ? JSON.stringify(await request.json()) : undefined;
    const response = await controlPlaneUserFetch("/scm/connections", { method, body });
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Failed to proxy SCM connections:", error);
    return NextResponse.json({ error: "Failed to access SCM connections" }, { status: 500 });
  }
}

export async function GET() {
  return forward("GET");
}

export async function POST(request: NextRequest) {
  return forward("POST", request);
}
