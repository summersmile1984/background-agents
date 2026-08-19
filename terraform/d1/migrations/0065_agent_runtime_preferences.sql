-- Deployment-wide defaults and enablement for coding-agent harnesses.
-- Existing installations fall back to DEFAULT_AGENT_HARNESS until this row is written.
CREATE TABLE IF NOT EXISTS agent_runtime_preferences (
  id                    TEXT PRIMARY KEY DEFAULT 'global',
  default_agent_harness TEXT NOT NULL,
  enabled_harnesses     TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
