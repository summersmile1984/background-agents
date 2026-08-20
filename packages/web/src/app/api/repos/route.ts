import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import type { SourceControlConnectionSummary } from "@open-inspect/shared/types/source-control";

interface ControlPlaneReposResponse {
  repos: EnrichedRepository[];
  connections?: Array<
    Pick<SourceControlConnectionSummary, "id" | "provider" | "displayName" | "baseUrl">
  >;
  cached: boolean;
  cachedAt: string;
  connectionErrors?: Array<{ connectionId: string; code: string }>;
}

export async function GET() {
  const session = await getServerAuthSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Fetch the repository catalog using each configured connection's service authority.
    const response = await controlPlaneUserFetch("/repos");

    if (!response.ok) {
      const error = await response.text();
      console.error("Control plane API error:", error);
      return NextResponse.json(
        { error: "Failed to fetch repositories" },
        { status: response.status }
      );
    }

    const data: ControlPlaneReposResponse = await response.json();

    return NextResponse.json({
      repos: data.repos,
      connections: data.connections ?? [],
      cached: data.cached,
      cachedAt: data.cachedAt,
      connectionErrors: data.connectionErrors ?? [],
    });
  } catch (error) {
    console.error("Error fetching repos:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
