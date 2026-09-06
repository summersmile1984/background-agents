import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { SqlDatabase, SqlStatement } from "./sql-database";

export interface SessionCreateRequestClaim {
  callerKey: string;
  clientRequestId: string;
  requestFingerprint: string;
  sessionId: string;
  createdAt: number;
}

export interface SessionCreateRequestResult extends SessionCreateRequestClaim {
  sessionStatus: SessionStatus;
}

interface SessionCreateRequestRow {
  caller_key: string;
  client_request_id: string;
  request_fingerprint: string;
  session_id: string;
  created_at: number;
  session_status: SessionStatus;
}

function toResult(row: SessionCreateRequestRow): SessionCreateRequestResult {
  return {
    callerKey: row.caller_key,
    clientRequestId: row.client_request_id,
    requestFingerprint: row.request_fingerprint,
    sessionId: row.session_id,
    createdAt: row.created_at,
    sessionStatus: row.session_status,
  };
}

export class SessionCreateRequestStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(
    callerKey: string,
    clientRequestId: string
  ): Promise<SessionCreateRequestResult | null> {
    const row = await this.db
      .prepare(
        `SELECT r.caller_key, r.client_request_id, r.request_fingerprint,
                r.session_id, r.created_at, s.status AS session_status
         FROM session_create_requests r
         JOIN sessions s ON s.id = r.session_id
         WHERE r.caller_key = ? AND r.client_request_id = ?`
      )
      .bind(callerKey, clientRequestId)
      .first<SessionCreateRequestRow>();
    return row ? toResult(row) : null;
  }

  bindCreate(claim: SessionCreateRequestClaim): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO session_create_requests
           (caller_key, client_request_id, request_fingerprint, session_id, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        claim.callerKey,
        claim.clientRequestId,
        claim.requestFingerprint,
        claim.sessionId,
        claim.createdAt
      );
  }
}
