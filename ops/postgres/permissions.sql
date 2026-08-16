REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CONNECT ON DATABASE team_wiki FROM PUBLIC;
REVOKE ALL ON TABLE schema_migrations, background_jobs FROM PUBLIC;

GRANT CONNECT ON DATABASE team_wiki
  TO team_wiki_api, team_wiki_publish, team_wiki_classify, team_wiki_reconcile;
GRANT USAGE ON SCHEMA public
  TO team_wiki_api, team_wiki_publish, team_wiki_classify, team_wiki_reconcile;
GRANT SELECT ON TABLE schema_migrations
  TO team_wiki_api, team_wiki_publish, team_wiki_classify, team_wiki_reconcile;

GRANT SELECT, INSERT ON TABLE background_jobs TO team_wiki_api;
GRANT SELECT, UPDATE ON TABLE background_jobs
  TO team_wiki_publish, team_wiki_classify, team_wiki_reconcile;

ALTER TABLE background_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS background_jobs_api_read ON background_jobs;
DROP POLICY IF EXISTS background_jobs_api_enqueue ON background_jobs;
DROP POLICY IF EXISTS background_jobs_publish ON background_jobs;
DROP POLICY IF EXISTS background_jobs_classify ON background_jobs;
DROP POLICY IF EXISTS background_jobs_reconcile ON background_jobs;

CREATE POLICY background_jobs_api_read ON background_jobs
  FOR SELECT TO team_wiki_api USING (true);
CREATE POLICY background_jobs_api_enqueue ON background_jobs
  FOR INSERT TO team_wiki_api WITH CHECK (true);
CREATE POLICY background_jobs_publish ON background_jobs
  FOR ALL TO team_wiki_publish
  USING (kind LIKE 'publish.%') WITH CHECK (kind LIKE 'publish.%');
CREATE POLICY background_jobs_classify ON background_jobs
  FOR ALL TO team_wiki_classify
  USING (kind LIKE 'classify.%') WITH CHECK (kind LIKE 'classify.%');
CREATE POLICY background_jobs_reconcile ON background_jobs
  FOR ALL TO team_wiki_reconcile
  USING (kind LIKE 'reconcile.%') WITH CHECK (kind LIKE 'reconcile.%');
