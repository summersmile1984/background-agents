import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ repositoryKey: string }> }
) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { repositoryKey } = await params;
  const response = await controlPlaneUserFetch(
    `/image-builds/toggle/repository/${encodeURIComponent(repositoryKey)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    }
  );
  return NextResponse.json(await response.json(), { status: response.status });
}
