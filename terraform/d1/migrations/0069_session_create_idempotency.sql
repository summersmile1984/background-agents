-- Stable idempotency for side-effecting session creation. The row is inserted
-- in the same D1 batch as its session, so a duplicate caller/key rolls the
-- losing session insert back before a Durable Object or sandbox is created.
CREATE TABLE session_create_requests (
  caller_key          TEXT    NOT NULL,
  client_request_id   TEXT    NOT NULL,
  request_fingerprint TEXT    NOT NULL,
  session_id          TEXT    NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (caller_key, client_request_id)
);

CREATE INDEX idx_session_create_requests_created_at
  ON session_create_requests (created_at);
