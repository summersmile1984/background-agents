-- Immutable, secret-free runtime contract resolved before a sandbox starts.
-- Indexed mirrors support operations queries without parsing spec_json; the
-- JSON value remains the canonical versioned contract.
CREATE TABLE session_launch_specs (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version = 1),
  resolver_version TEXT NOT NULL,
  capability_catalog_version TEXT NOT NULL,
  draft_digest TEXT NOT NULL,
  harness TEXT NOT NULL CHECK (harness IN ('opencode', 'codex', 'claude', 'deepseek')),
  route_id TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT,
  spec_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_session_launch_specs_runtime
  ON session_launch_specs(harness, route_id, model);
