-- Multi-connection source-control foundation (expand phase only).
--
-- This migration deliberately does not rebuild or backfill legacy tables. New
-- code dual-writes the nullable references, an online job resolves legacy
-- repository identity, and a later migration changes legacy uniqueness only
-- after the audit gate passes.

CREATE TABLE scm_connections (
  id                    TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  base_url              TEXT NOT NULL,
  api_base_url          TEXT NOT NULL,
  clone_base_url        TEXT NOT NULL,
  auth_mode             TEXT NOT NULL,
  credential_source     TEXT NOT NULL,
  credential_ref        TEXT,
  username              TEXT,
  capabilities_json     TEXT NOT NULL DEFAULT '{}',
  version               TEXT,
  revision              INTEGER NOT NULL DEFAULT 1,
  enabled               INTEGER NOT NULL DEFAULT 1,
  is_default            INTEGER NOT NULL DEFAULT 0,
  last_checked_at       INTEGER,
  last_error_code       TEXT,
  created_by            TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  CHECK (provider IN ('github', 'gitea', 'gitlab', 'bitbucket')),
  CHECK (auth_mode IN ('github_app', 'pat', 'oauth')),
  CHECK (credential_source IN ('worker_binding', 'encrypted_d1')),
  CHECK (enabled IN (0, 1)),
  CHECK (is_default IN (0, 1)),
  CHECK (is_default = 0 OR enabled = 1),
  CHECK (
    (credential_source = 'worker_binding' AND credential_ref IS NOT NULL)
    OR credential_source = 'encrypted_d1'
  )
);

CREATE UNIQUE INDEX idx_scm_connections_display_name
  ON scm_connections (lower(display_name));
CREATE UNIQUE INDEX idx_scm_connections_default
  ON scm_connections (is_default) WHERE is_default = 1;
CREATE INDEX idx_scm_connections_enabled
  ON scm_connections (enabled, provider, display_name);

CREATE TABLE scm_connection_credentials (
  connection_id             TEXT NOT NULL,
  purpose                   TEXT NOT NULL,
  ciphertext                TEXT NOT NULL,
  encryption_format_version INTEGER NOT NULL,
  expires_at                INTEGER,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  PRIMARY KEY (connection_id, purpose),
  FOREIGN KEY (connection_id) REFERENCES scm_connections(id) ON DELETE CASCADE,
  CHECK (purpose IN (
    'service_token',
    'github_app_private_key',
    'oauth_client_secret',
    'webhook_secret'
  ))
);

CREATE TABLE scm_repositories (
  id                TEXT PRIMARY KEY,
  connection_id     TEXT NOT NULL,
  external_id       TEXT,
  owner             TEXT NOT NULL,
  name              TEXT NOT NULL,
  path_key          TEXT NOT NULL,
  default_branch    TEXT,
  web_url           TEXT,
  clone_url         TEXT,
  is_private        INTEGER,
  archived          INTEGER NOT NULL DEFAULT 0,
  resolution_status TEXT NOT NULL DEFAULT 'resolved',
  last_seen_at      INTEGER,
  removed_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES scm_connections(id) ON DELETE RESTRICT,
  UNIQUE (id, connection_id),
  CHECK (archived IN (0, 1)),
  CHECK (is_private IS NULL OR is_private IN (0, 1)),
  CHECK (resolution_status IN ('resolved', 'unresolved', 'removed')),
  CHECK (
    resolution_status != 'resolved'
    OR (
      external_id IS NOT NULL
      AND default_branch IS NOT NULL
      AND web_url IS NOT NULL
      AND clone_url IS NOT NULL
      AND is_private IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX idx_scm_repositories_external
  ON scm_repositories (connection_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX idx_scm_repositories_active_path
  ON scm_repositories (connection_id, path_key)
  WHERE removed_at IS NULL;
CREATE INDEX idx_scm_repositories_catalog
  ON scm_repositories (connection_id, resolution_status, owner, name);

-- Checkpointed, idempotent online backfill progress. No forge API is called by
-- this SQL migration itself.
CREATE TABLE scm_repository_backfill_state (
  job_name       TEXT PRIMARY KEY,
  cursor         TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  lease_owner    TEXT,
  lease_until    INTEGER,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  unresolved_rows INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (status IN ('pending', 'running', 'complete', 'failed'))
);

-- Short-lived sandbox/build capabilities. Only SHA-256 hashes are persisted;
-- the bearer value is returned once to the authorized data-plane caller.
CREATE TABLE scm_git_capabilities (
  token_hash       TEXT PRIMARY KEY,
  audience         TEXT NOT NULL,
  subject_id       TEXT NOT NULL,
  connection_id    TEXT NOT NULL,
  repository_ids   TEXT NOT NULL,
  allowed_operation TEXT NOT NULL,
  expires_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES scm_connections(id) ON DELETE CASCADE,
  CHECK (audience IN ('session_git', 'image_build_git')),
  CHECK (allowed_operation IN ('read', 'write'))
);
CREATE INDEX idx_scm_git_capabilities_subject
  ON scm_git_capabilities (audience, subject_id, expires_at);

CREATE TABLE scm_webhook_deliveries (
  connection_id TEXT NOT NULL,
  delivery_id   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'received',
  received_at   INTEGER NOT NULL,
  processed_at  INTEGER,
  error_code    TEXT,
  PRIMARY KEY (connection_id, delivery_id),
  FOREIGN KEY (connection_id) REFERENCES scm_connections(id) ON DELETE CASCADE,
  CHECK (status IN ('received', 'processed', 'failed'))
);
CREATE INDEX idx_scm_webhook_deliveries_received
  ON scm_webhook_deliveries (received_at);

-- Expand legacy repository-bearing tables with nullable connection-aware
-- references. Repo-less objects intentionally retain NULL values.
ALTER TABLE sessions ADD COLUMN scm_connection_id TEXT;
ALTER TABLE sessions ADD COLUMN primary_repository_id TEXT;

ALTER TABLE session_repositories ADD COLUMN scm_connection_id TEXT;
ALTER TABLE session_repositories ADD COLUMN repository_id TEXT;

ALTER TABLE environments ADD COLUMN scm_connection_id TEXT;
ALTER TABLE environment_repositories ADD COLUMN scm_connection_id TEXT;
ALTER TABLE environment_repositories ADD COLUMN repository_id TEXT;

ALTER TABLE automations ADD COLUMN scm_connection_id TEXT;
ALTER TABLE automation_repositories ADD COLUMN scm_connection_id TEXT;
ALTER TABLE automation_repositories ADD COLUMN repository_id TEXT;
ALTER TABLE automation_runs ADD COLUMN scm_connection_id TEXT;
ALTER TABLE automation_runs ADD COLUMN repository_id TEXT;

ALTER TABLE repo_metadata ADD COLUMN repository_id TEXT;
ALTER TABLE repo_secrets ADD COLUMN repository_id TEXT;
ALTER TABLE image_builds ADD COLUMN scm_connection_id TEXT;
ALTER TABLE image_builds ADD COLUMN repository_id TEXT;
ALTER TABLE session_pull_requests ADD COLUMN scm_connection_id TEXT;
ALTER TABLE session_pull_requests ADD COLUMN repository_id TEXT;
ALTER TABLE skill_assignments ADD COLUMN repository_id TEXT;
ALTER TABLE integration_repo_settings ADD COLUMN repository_id TEXT;

CREATE INDEX idx_sessions_scm_connection
  ON sessions (scm_connection_id, updated_at DESC);
CREATE INDEX idx_session_repositories_identity
  ON session_repositories (repository_id, session_id);
CREATE INDEX idx_environment_repositories_identity
  ON environment_repositories (repository_id, environment_id);
CREATE INDEX idx_automation_repositories_identity
  ON automation_repositories (repository_id, automation_id);
CREATE INDEX idx_repo_metadata_repository_id
  ON repo_metadata (repository_id);
CREATE INDEX idx_repo_secrets_repository_id
  ON repo_secrets (repository_id, key);
CREATE INDEX idx_session_pull_requests_repository_id
  ON session_pull_requests (repository_id, pr_number);
CREATE INDEX idx_skill_assignments_repository_id
  ON skill_assignments (repository_id);

-- A stable child repository must exist on the same connection as its parent.
-- Nullable legacy rows remain writable during the expand phase; all new
-- connection-aware writes are protected even if they bypass application
-- stores (for example an operator repair or a future Queue consumer).
CREATE TRIGGER session_repositories_scm_guard_insert
BEFORE INSERT ON session_repositories
WHEN NEW.repository_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.scm_connection_id IS NULL
    THEN RAISE(ABORT, 'session repository connection is required') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM scm_repositories
    WHERE id = NEW.repository_id AND connection_id = NEW.scm_connection_id
  ) THEN RAISE(ABORT, 'session repository identity is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sessions
    WHERE id = NEW.session_id AND scm_connection_id = NEW.scm_connection_id
  ) THEN RAISE(ABORT, 'session repository connection mismatch') END;
END;

CREATE TRIGGER session_repositories_scm_guard_update
BEFORE UPDATE OF repository_id, scm_connection_id, session_id ON session_repositories
WHEN NEW.repository_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.scm_connection_id IS NULL
    THEN RAISE(ABORT, 'session repository connection is required') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM scm_repositories
    WHERE id = NEW.repository_id AND connection_id = NEW.scm_connection_id
  ) THEN RAISE(ABORT, 'session repository identity is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sessions
    WHERE id = NEW.session_id AND scm_connection_id = NEW.scm_connection_id
  ) THEN RAISE(ABORT, 'session repository connection mismatch') END;
END;

CREATE TRIGGER environment_repositories_scm_guard_insert
BEFORE INSERT ON environment_repositories
WHEN NEW.repository_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.scm_connection_id IS NULL
    THEN RAISE(ABORT, 'environment repository connection is required') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM scm_repositories
    WHERE id = NEW.repository_id AND connection_id = NEW.scm_connection_id
  ) THEN RAISE(ABORT, 'environment repository identity is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM environments
    WHERE id = NEW.environment_id AND scm_connection_id = NEW.scm_connection_id
  ) THEN RAISE(ABORT, 'environment repository connection mismatch') END;
END;

CREATE TRIGGER environment_repositories_scm_guard_update
BEFORE UPDATE OF repository_id, scm_connection_id, environment_id ON environment_repositories
WHEN NEW.repository_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.scm_connection_id IS NULL
    THEN RAISE(ABORT, 'environment repository connection is required') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM scm_repositories
    WHERE id = NEW.repository_id AND connection_id = NEW.scm_connection_id
  ) THEN RAISE(ABORT, 'environment repository identity is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM environments
    WHERE id = NEW.environment_id AND scm_connection_id = NEW.scm_connection_id
  ) THEN RAISE(ABORT, 'environment repository connection mismatch') END;
END;

CREATE TRIGGER automation_repositories_scm_guard_insert
BEFORE INSERT ON automation_repositories
WHEN NEW.repository_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.scm_connection_id IS NULL
    THEN RAISE(ABORT, 'automation repository connection is required') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM scm_repositories
    WHERE id = NEW.repository_id AND connection_id = NEW.scm_connection_id
  ) THEN RAISE(ABORT, 'automation repository identity is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM automations
    WHERE id = NEW.automation_id AND scm_connection_id = NEW.scm_connection_id
  ) THEN RAISE(ABORT, 'automation repository connection mismatch') END;
END;

CREATE TRIGGER automation_repositories_scm_guard_update
BEFORE UPDATE OF repository_id, scm_connection_id, automation_id ON automation_repositories
WHEN NEW.repository_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.scm_connection_id IS NULL
    THEN RAISE(ABORT, 'automation repository connection is required') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM scm_repositories
    WHERE id = NEW.repository_id AND connection_id = NEW.scm_connection_id
  ) THEN RAISE(ABORT, 'automation repository identity is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM automations
    WHERE id = NEW.automation_id AND scm_connection_id = NEW.scm_connection_id
  ) THEN RAISE(ABORT, 'automation repository connection mismatch') END;
END;

CREATE TABLE mcp_server_repository_scopes (
  mcp_server_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (mcp_server_id, repository_id),
  FOREIGN KEY (mcp_server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES scm_repositories(id) ON DELETE CASCADE
);
CREATE INDEX idx_mcp_server_repository_scopes_repository
  ON mcp_server_repository_scopes (repository_id, mcp_server_id);

-- Parallel stable-key stores avoid the legacy global owner/name and numeric-id
-- uniqueness domains during the expand period. Legacy tables remain readable
-- until the contract migration removes fallback support.
CREATE TABLE scm_repository_metadata (
  repository_id TEXT PRIMARY KEY,
  description TEXT,
  aliases TEXT,
  channel_associations TEXT,
  keywords TEXT,
  default_environment_id TEXT,
  image_build_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES scm_repositories(id) ON DELETE CASCADE,
  CHECK (image_build_enabled IN (0, 1))
);

CREATE TABLE scm_repository_secrets (
  repository_id TEXT NOT NULL,
  key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, key),
  FOREIGN KEY (repository_id) REFERENCES scm_repositories(id) ON DELETE CASCADE
);

CREATE TABLE scm_integration_repo_settings (
  integration_id TEXT NOT NULL,
  repository_id  TEXT NOT NULL,
  settings       TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (integration_id, repository_id),
  FOREIGN KEY (repository_id) REFERENCES scm_repositories(id) ON DELETE CASCADE
);
CREATE INDEX idx_scm_integration_repo_settings_repository
  ON scm_integration_repo_settings (repository_id, integration_id);

-- Stable PR authority rows live in a parallel table during expansion because
-- the legacy table's unique index is global on (external repo id, PR number).
-- That legacy key collides as soon as GitHub and Gitea both contain repo 42.
CREATE TABLE scm_session_pull_requests (
  artifact_id            TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,
  scm_connection_id      TEXT NOT NULL,
  repository_id          TEXT NOT NULL,
  repository_external_id TEXT,
  repo_owner             TEXT NOT NULL,
  repo_name              TEXT NOT NULL,
  pr_number              INTEGER NOT NULL CHECK (pr_number > 0),
  url                    TEXT NOT NULL,
  lifecycle_state        TEXT NOT NULL CHECK (lifecycle_state IN ('open', 'closed', 'merged')),
  is_draft               INTEGER NOT NULL CHECK (is_draft IN (0, 1)),
  head_branch            TEXT NOT NULL,
  base_branch            TEXT NOT NULL,
  head_sha               TEXT,
  provider_created_at    INTEGER,
  provider_updated_at    INTEGER,
  merged_at              INTEGER,
  closed_at              INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id, scm_connection_id)
    REFERENCES scm_repositories(id, connection_id) ON DELETE RESTRICT,
  UNIQUE (repository_id, pr_number),
  CHECK (lifecycle_state = 'open' OR is_draft = 0)
);
CREATE INDEX idx_scm_session_pull_requests_session
  ON scm_session_pull_requests (session_id);

-- Stable repository skill assignments avoid the legacy unique key on
-- (skill, owner, name), which cannot represent equal paths on two forges.
CREATE TABLE scm_skill_assignments (
  id            TEXT PRIMARY KEY,
  skill_id      TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES scm_repositories(id) ON DELETE CASCADE,
  UNIQUE (skill_id, repository_id)
);
CREATE INDEX idx_scm_skill_assignments_repository
  ON scm_skill_assignments (repository_id, skill_id);

CREATE TRIGGER scm_skill_assignments_generation_insert
AFTER INSERT ON scm_skill_assignments
BEGIN
  UPDATE skills_catalog_state SET generation = generation + 1 WHERE singleton = 1;
END;

CREATE TRIGGER scm_skill_assignments_generation_update
AFTER UPDATE ON scm_skill_assignments
BEGIN
  UPDATE skills_catalog_state SET generation = generation + 1 WHERE singleton = 1;
END;

CREATE TRIGGER scm_skill_assignments_generation_delete
AFTER DELETE ON scm_skill_assignments
BEGIN
  UPDATE skills_catalog_state SET generation = generation + 1 WHERE singleton = 1;
END;
