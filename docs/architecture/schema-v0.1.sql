-- OWN-71 database model draft.
-- Target: PostgreSQL 18 current minor.
-- IDs are application-generated UUIDs (prefer UUIDv7); this file contains no secrets.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL,
  username_normalized text NOT NULL,
  password_hash text NOT NULL,
  password_changed_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  must_change_password boolean NOT NULL DEFAULT true,
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  UNIQUE (username_normalized),
  CHECK (username_normalized = lower(btrim(username_normalized))),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (
    role IN ('reader', 'author', 'knowledge_admin', 'platform_admin')
  ),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  csrf_secret_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  user_agent_hash text,
  ip_prefix_hash text,
  UNIQUE (token_hash),
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);

CREATE INDEX sessions_active_user_idx
  ON sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

-- subject_hash and ip_prefix_hash are keyed hashes, not raw usernames or IPs.
CREATE TABLE login_throttles (
  subject_hash text NOT NULL,
  ip_prefix_hash text NOT NULL,
  window_started_at timestamptz NOT NULL,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_hash, ip_prefix_hash)
);

CREATE TABLE articles (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  status text NOT NULL CHECK (status IN ('published', 'unpublished', 'deleted')),
  visibility text NOT NULL DEFAULT 'team' CHECK (visibility IN ('team', 'restricted')),
  github_path text NOT NULL,
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  unpublished_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (github_path),
  CHECK (github_path = 'content/' || id::text || '/index.md'),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE INDEX articles_author_status_idx ON articles (author_id, status, updated_at DESC);

-- P0 defaults to team visibility. Restricted visibility is retained in the
-- model so every query and direct URL can use one record-level policy.
CREATE TABLE article_access_grants (
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  grantee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('read', 'edit', 'manage')),
  granted_by uuid NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, grantee_user_id, permission)
);

CREATE INDEX article_access_grants_user_idx
  ON article_access_grants (grantee_user_id, article_id);

CREATE TABLE drafts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  article_id uuid REFERENCES articles(id),
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 300),
  markdown text NOT NULL DEFAULT '' CHECK (octet_length(markdown) <= 4000000),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX drafts_owner_updated_idx
  ON drafts (owner_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE draft_attachments (
  id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  original_filename text NOT NULL,
  sanitized_filename text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('uploading', 'ready', 'failed', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (storage_key),
  UNIQUE (draft_id, sanitized_filename),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

-- A snapshot is created only when publish is requested. It lets auto-save
-- continue while a worker publishes an immutable title/body/attachment set.
CREATE TABLE draft_publish_snapshots (
  id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES drafts(id),
  draft_revision bigint NOT NULL CHECK (draft_revision >= 1),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  markdown text NOT NULL CHECK (octet_length(markdown) BETWEEN 1 AND 4000000),
  input_hash text NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, draft_revision),
  UNIQUE (id, draft_id, draft_revision, input_hash)
);

CREATE TABLE draft_publish_snapshot_attachments (
  snapshot_id uuid NOT NULL REFERENCES draft_publish_snapshots(id) ON DELETE CASCADE,
  draft_attachment_id uuid NOT NULL REFERENCES draft_attachments(id),
  github_path text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  position integer NOT NULL CHECK (position >= 1),
  PRIMARY KEY (snapshot_id, draft_attachment_id),
  UNIQUE (snapshot_id, github_path),
  UNIQUE (snapshot_id, position),
  CHECK (github_path LIKE 'content/%/assets/%')
);

CREATE TABLE publish_requests (
  id uuid PRIMARY KEY,
  requested_by uuid NOT NULL REFERENCES users(id),
  snapshot_id uuid NOT NULL,
  draft_id uuid NOT NULL REFERENCES drafts(id),
  draft_revision bigint NOT NULL CHECK (draft_revision >= 1),
  article_id uuid REFERENCES articles(id),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  input_hash text NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (
    status IN (
      'queued',
      'publishing',
      'reconciling',
      'succeeded',
      'retryable_failed',
      'blocked_failed'
    )
  ),
  base_commit_sha text,
  candidate_commit_sha text,
  result_commit_sha text,
  error_code text,
  error_detail_safe text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (requested_by, idempotency_key),
  FOREIGN KEY (snapshot_id, draft_id, draft_revision, input_hash)
    REFERENCES draft_publish_snapshots(id, draft_id, draft_revision, input_hash),
  CHECK (base_commit_sha IS NULL OR base_commit_sha ~ '^[0-9a-f]{40,64}$'),
  CHECK (candidate_commit_sha IS NULL OR candidate_commit_sha ~ '^[0-9a-f]{40,64}$'),
  CHECK (result_commit_sha IS NULL OR result_commit_sha ~ '^[0-9a-f]{40,64}$'),
  CHECK ((status = 'succeeded') = (result_commit_sha IS NOT NULL)),
  CHECK ((status = 'succeeded') = (completed_at IS NOT NULL))
);

CREATE INDEX publish_requests_work_idx
  ON publish_requests (status, updated_at)
  WHERE status IN ('queued', 'publishing', 'reconciling', 'retryable_failed');

CREATE TABLE article_versions (
  id uuid PRIMARY KEY,
  article_id uuid NOT NULL REFERENCES articles(id),
  publish_request_id uuid REFERENCES publish_requests(id),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40,64}$'),
  body_hash text NOT NULL CHECK (body_hash ~ '^sha256:[0-9a-f]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  title_hash text NOT NULL CHECK (title_hash ~ '^sha256:[0-9a-f]{64}$'),
  source text NOT NULL CHECK (source IN ('application', 'github')),
  created_by uuid REFERENCES users(id),
  github_actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, article_id),
  UNIQUE (article_id, commit_sha),
  UNIQUE (publish_request_id)
);

ALTER TABLE articles
  ADD CONSTRAINT articles_current_version_fk
  FOREIGN KEY (current_version_id, id) REFERENCES article_versions(id, article_id);

CREATE INDEX article_versions_article_time_idx
  ON article_versions (article_id, created_at DESC);

CREATE TABLE published_attachments (
  id uuid PRIMARY KEY,
  article_version_id uuid NOT NULL REFERENCES article_versions(id) ON DELETE CASCADE,
  source_draft_attachment_id uuid REFERENCES draft_attachments(id),
  github_path text NOT NULL,
  original_filename text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_version_id, github_path),
  CHECK (github_path LIKE 'content/%/assets/%')
);

CREATE TABLE taxonomy_versions (
  version bigint PRIMARY KEY CHECK (version >= 1),
  changed_by uuid NOT NULL REFERENCES users(id),
  change_reason text NOT NULL CHECK (char_length(change_reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE taxonomy_nodes (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('content_type', 'topic', 'project')),
  parent_id uuid REFERENCES taxonomy_nodes(id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  normalized_name text NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 100),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_in_version bigint NOT NULL REFERENCES taxonomy_versions(version),
  updated_in_version bigint NOT NULL REFERENCES taxonomy_versions(version),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (updated_in_version >= created_in_version)
);

CREATE UNIQUE INDEX taxonomy_nodes_active_name_idx
  ON taxonomy_nodes (kind, normalized_name)
  WHERE enabled;

CREATE INDEX taxonomy_nodes_kind_order_idx
  ON taxonomy_nodes (kind, enabled DESC, sort_order, display_name);

-- Immutable change snapshots make classifications reproducible at their
-- recorded taxonomy_version even though taxonomy_nodes is the current view.
CREATE TABLE taxonomy_node_revisions (
  node_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  version bigint NOT NULL REFERENCES taxonomy_versions(version),
  kind text NOT NULL CHECK (kind IN ('content_type', 'topic', 'project')),
  parent_id uuid REFERENCES taxonomy_nodes(id),
  display_name text NOT NULL,
  normalized_name text NOT NULL,
  enabled boolean NOT NULL,
  sort_order integer NOT NULL,
  changed_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, version)
);

CREATE INDEX taxonomy_node_revisions_version_idx
  ON taxonomy_node_revisions (version, kind, node_id);

CREATE TABLE model_configs (
  id uuid PRIMARY KEY,
  base_url text NOT NULL,
  model_name text NOT NULL CHECK (char_length(model_name) BETWEEN 1 AND 200),
  secret_reference text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  config_version bigint NOT NULL CHECK (config_version >= 1),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  UNIQUE (config_version),
  CHECK (base_url ~ '^https://')
);

CREATE UNIQUE INDEX model_configs_one_enabled_idx
  ON model_configs (enabled)
  WHERE enabled;

CREATE TABLE classifications (
  id uuid PRIMARY KEY,
  article_version_id uuid NOT NULL REFERENCES article_versions(id),
  status text NOT NULL CHECK (
    status IN (
      'pending',
      'classified',
      'needs_review',
      'failed',
      'confirmed',
      'corrected',
      'superseded'
    )
  ),
  content_type_id uuid REFERENCES taxonomy_nodes(id),
  primary_topic_id uuid REFERENCES taxonomy_nodes(id),
  project_id uuid REFERENCES taxonomy_nodes(id),
  confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text CHECK (char_length(reason) <= 80),
  model_config_version bigint,
  model_reported_version text,
  prompt_version text,
  taxonomy_version bigint NOT NULL REFERENCES taxonomy_versions(version),
  source_content_hash text NOT NULL CHECK (source_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  superseded_at timestamptz,
  FOREIGN KEY (model_config_version) REFERENCES model_configs(config_version),
  CHECK (jsonb_typeof(confidence) = 'object'),
  CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
);

CREATE UNIQUE INDEX classifications_current_version_idx
  ON classifications (article_version_id)
  WHERE superseded_at IS NULL;

CREATE INDEX classifications_review_queue_idx
  ON classifications (status, created_at)
  WHERE status IN ('needs_review', 'failed');

CREATE TABLE classification_secondary_topics (
  classification_id uuid NOT NULL REFERENCES classifications(id) ON DELETE CASCADE,
  taxonomy_node_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  PRIMARY KEY (classification_id, taxonomy_node_id),
  UNIQUE (classification_id, position)
);

CREATE TABLE tags (
  id uuid PRIMARY KEY,
  normalized_name text NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 64),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalized_name)
);

CREATE TABLE classification_tags (
  classification_id uuid NOT NULL REFERENCES classifications(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id),
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 5),
  model_original_value text NOT NULL CHECK (char_length(model_original_value) BETWEEN 1 AND 128),
  PRIMARY KEY (classification_id, tag_id),
  UNIQUE (classification_id, position)
);

CREATE TABLE classification_feedback (
  id uuid PRIMARY KEY,
  classification_id uuid NOT NULL REFERENCES classifications(id),
  action text NOT NULL CHECK (action IN ('confirm', 'correct', 'retry')),
  old_value jsonb NOT NULL,
  new_value jsonb NOT NULL,
  reason text CHECK (char_length(reason) <= 500),
  actor_id uuid NOT NULL REFERENCES users(id),
  source_content_hash text NOT NULL CHECK (source_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(old_value) = 'object'),
  CHECK (jsonb_typeof(new_value) = 'object')
);

CREATE INDEX classification_feedback_classification_idx
  ON classification_feedback (classification_id, created_at);

CREATE TABLE background_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (
    status IN ('queued', 'running', 'retry', 'succeeded', 'dead', 'cancelled')
  ),
  priority smallint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  last_error_code text,
  last_error_safe text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (kind, dedupe_key),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'dead', 'cancelled')) = (completed_at IS NOT NULL))
);

CREATE INDEX background_jobs_claim_idx
  ON background_jobs (priority DESC, available_at, id)
  WHERE status IN ('queued', 'retry');

CREATE INDEX background_jobs_expired_lease_idx
  ON background_jobs (lease_until)
  WHERE status = 'running';

CREATE TABLE github_webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event_type text NOT NULL,
  installation_id bigint NOT NULL,
  repository_id bigint NOT NULL,
  ref text,
  after_sha text,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (
    status IN ('accepted', 'ignored', 'processing', 'succeeded', 'failed')
  ),
  error_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CHECK (after_sha IS NULL OR after_sha ~ '^[0-9a-f]{40,64}$')
);

CREATE INDEX github_webhook_pending_idx
  ON github_webhook_deliveries (status, received_at)
  WHERE status IN ('accepted', 'processing', 'failed');

-- Derived cache: never use body_text as the article read source.
CREATE TABLE search_documents (
  article_version_id uuid PRIMARY KEY REFERENCES article_versions(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  title text NOT NULL,
  body_text text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  indexed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX search_documents_title_trgm_idx
  ON search_documents USING gin (title gin_trgm_ops);

CREATE INDEX search_documents_body_trgm_idx
  ON search_documents USING gin (body_text gin_trgm_ops);

CREATE INDEX search_documents_article_idx ON search_documents (article_id);

CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(value) IN ('object', 'array', 'string', 'number', 'boolean'))
);

-- Append-only. Deployment migrations must revoke UPDATE/DELETE from every app role.
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'service', 'github', 'system')),
  actor_id uuid,
  service_name text,
  object_type text NOT NULL,
  object_id uuid,
  action text NOT NULL,
  result text NOT NULL CHECK (result IN ('success', 'denied', 'failure')),
  request_id text NOT NULL,
  metadata_safe jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(metadata_safe) = 'object'),
  CHECK (
    (actor_type = 'user' AND actor_id IS NOT NULL)
    OR (actor_type <> 'user')
  )
);

CREATE INDEX audit_logs_object_time_idx
  ON audit_logs (object_type, object_id, created_at DESC);

CREATE INDEX audit_logs_actor_time_idx
  ON audit_logs (actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

-- Enforce taxonomy kinds at the database boundary. Disabled nodes remain valid
-- for history, but application writes must reject them for new classifications.
CREATE FUNCTION validate_classification_taxonomy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.content_type_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM taxonomy_nodes n
    WHERE n.id = NEW.content_type_id AND n.kind = 'content_type'
  ) THEN
    RAISE EXCEPTION 'content_type_id must reference a content_type node';
  END IF;

  IF NEW.primary_topic_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM taxonomy_nodes n
    WHERE n.id = NEW.primary_topic_id AND n.kind = 'topic'
  ) THEN
    RAISE EXCEPTION 'primary_topic_id must reference a topic node';
  END IF;

  IF NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM taxonomy_nodes n
    WHERE n.id = NEW.project_id AND n.kind = 'project'
  ) THEN
    RAISE EXCEPTION 'project_id must reference a project node';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER classifications_taxonomy_kind_trigger
BEFORE INSERT OR UPDATE OF content_type_id, primary_topic_id, project_id
ON classifications
FOR EACH ROW EXECUTE FUNCTION validate_classification_taxonomy();

CREATE FUNCTION validate_secondary_topic_kind()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM taxonomy_nodes n
    WHERE n.id = NEW.taxonomy_node_id AND n.kind = 'topic'
  ) THEN
    RAISE EXCEPTION 'secondary taxonomy node must be a topic';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER classification_secondary_topic_kind_trigger
BEFORE INSERT OR UPDATE OF taxonomy_node_id
ON classification_secondary_topics
FOR EACH ROW EXECUTE FUNCTION validate_secondary_topic_kind();

COMMIT;

-- Follow-up migrations after platform roles are known:
-- 1. GRANT each runtime role only its module tables and sequences/functions.
-- 2. REVOKE UPDATE/DELETE on audit_logs from all runtime roles.
-- 3. Add backup/PITR verification and retention jobs outside this schema.
-- 4. Benchmark pg_trgm with the real Chinese/English corpus before T09 release.
