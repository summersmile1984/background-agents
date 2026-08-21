-- Canonical, credential-free runtime defaults shared by Web and integrations.
CREATE TABLE runtime_configurations (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('installation', 'user', 'integration', 'repository', 'environment')
  ),
  scope_id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope_type, scope_id)
);

CREATE INDEX idx_runtime_configurations_scope
  ON runtime_configurations(scope_type, scope_id);
