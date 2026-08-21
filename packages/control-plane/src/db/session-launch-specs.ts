import {
  sessionLaunchSpecV1Schema,
  type SessionLaunchSpecV1,
} from "@open-inspect/shared/types/runtime-launch";
import type { SqlDatabase, SqlStatement } from "./sql-database";

interface SessionLaunchSpecRow {
  spec_json: string;
}

export class SessionLaunchSpecStore {
  constructor(private readonly db: SqlDatabase) {}

  bindCreate(sessionId: string, spec: SessionLaunchSpecV1): SqlStatement {
    const parsed = sessionLaunchSpecV1Schema.parse(spec);
    return this.db
      .prepare(
        `INSERT INTO session_launch_specs
         (session_id, version, resolver_version, capability_catalog_version, draft_digest,
          harness, route_id, model, reasoning_effort, spec_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        sessionId,
        parsed.version,
        parsed.resolverVersion,
        parsed.capabilityCatalogVersion,
        parsed.draftDigest,
        parsed.runtime.harness.value,
        parsed.runtime.routeId.value,
        parsed.runtime.model.value,
        parsed.runtime.effort.value,
        JSON.stringify(parsed),
        parsed.resolvedAt
      );
  }

  async get(sessionId: string): Promise<SessionLaunchSpecV1 | null> {
    const row = await this.db
      .prepare("SELECT spec_json FROM session_launch_specs WHERE session_id = ?")
      .bind(sessionId)
      .first<SessionLaunchSpecRow>();
    if (!row) return null;
    return sessionLaunchSpecV1Schema.parse(JSON.parse(row.spec_json));
  }
}
