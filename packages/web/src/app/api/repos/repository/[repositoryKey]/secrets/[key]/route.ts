import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ repositoryKey: string; key: string }> }
) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { repositoryKey, key } = await params;
  const response = await controlPlaneUserFetch(
    `/repos/${encodeURIComponent(repositoryKey)}/secrets/${encodeURIComponent(key)}`,
    { method: "DELETE" }
  );
  return NextResponse.json(await response.json(), {
    status: response.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
