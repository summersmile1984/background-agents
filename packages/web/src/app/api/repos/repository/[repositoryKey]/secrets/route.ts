import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";

async function forward(request: Request, repositoryKey: string) {
  const session = await getServerAuthSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const response = await controlPlaneUserFetch(
    `/repos/${encodeURIComponent(repositoryKey)}/secrets`,
    request.method === "GET"
      ? undefined
      : {
          method: request.method,
          headers: { "Content-Type": "application/json" },
          body: await request.text(),
        }
  );
  return NextResponse.json(await response.json(), {
    status: response.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ repositoryKey: string }> }
) {
  return forward(request, (await params).repositoryKey);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ repositoryKey: string }> }
) {
  return forward(request, (await params).repositoryKey);
}
