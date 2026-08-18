-- Additive multi-harness session identity. Existing rows and deployments keep
-- OpenCode semantics until a caller or Environment explicitly selects another
-- harness.
ALTER TABLE sessions ADD COLUMN agent_harness TEXT NOT NULL DEFAULT 'opencode'
  CHECK (agent_harness IN ('opencode', 'codex', 'claude', 'deepseek'));

ALTER TABLE environments ADD COLUMN default_agent_harness TEXT
  CHECK (
    default_agent_harness IS NULL
    OR default_agent_harness IN ('opencode', 'codex', 'claude', 'deepseek')
  );

ALTER TABLE automations ADD COLUMN agent_harness TEXT
  CHECK (
    agent_harness IS NULL
    OR agent_harness IN ('opencode', 'codex', 'claude', 'deepseek')
  );
