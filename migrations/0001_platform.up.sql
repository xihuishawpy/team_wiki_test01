CREATE TABLE background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'retry', 'succeeded', 'failed', 'dead_letter')),
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT background_jobs_kind_dedupe_unique UNIQUE (kind, dedupe_key),
  CONSTRAINT background_jobs_lease_pair CHECK (
    (lease_owner IS NULL AND lease_until IS NULL)
    OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
  )
);

CREATE INDEX background_jobs_claim_idx
  ON background_jobs (priority DESC, available_at, id)
  WHERE status IN ('queued', 'retry', 'running');
