import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ repositoryKey: string }> }
) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { repositoryKey } = await params;
  try {
    const response = await controlPlaneUserFetch(
      `/repos/${encodeURIComponent(repositoryKey)}/branches`
    );
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Failed to fetch branches by repository key:", error);
    return NextResponse.json({ error: "Failed to fetch branches" }, { status: 500 });
  }
}
