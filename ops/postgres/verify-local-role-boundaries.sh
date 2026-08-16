#!/bin/sh
set -eu

migrator_password="${TEAM_WIKI_MIGRATOR_DB_PASSWORD:-local_migrator_change_me}"
publish_password="${TEAM_WIKI_PUBLISH_DB_PASSWORD:-local_publish_change_me}"
classify_password="${TEAM_WIKI_CLASSIFY_DB_PASSWORD:-local_classify_change_me}"

docker compose exec -T -e PGPASSWORD="$migrator_password" postgres \
  psql -v ON_ERROR_STOP=1 -U team_wiki_migrator -d team_wiki -c \
  "INSERT INTO background_jobs (kind, dedupe_key, payload) VALUES
   ('publish.permission-probe', 'publish-permission-probe', '{\"schema_version\":1}'),
   ('classify.permission-probe', 'classify-permission-probe', '{\"schema_version\":1}')
   ON CONFLICT DO NOTHING"

publish_visible="$(docker compose exec -T -e PGPASSWORD="$publish_password" postgres \
  psql -Atq -v ON_ERROR_STOP=1 -U team_wiki_publish -d team_wiki -c \
  "SELECT count(*) FROM background_jobs WHERE kind LIKE '%.permission-probe'")"
classify_visible="$(docker compose exec -T -e PGPASSWORD="$classify_password" postgres \
  psql -Atq -v ON_ERROR_STOP=1 -U team_wiki_classify -d team_wiki -c \
  "SELECT count(*) FROM background_jobs WHERE kind LIKE '%.permission-probe'")"

test "$publish_visible" = "1"
test "$classify_visible" = "1"

docker compose exec -T -e PGPASSWORD="$publish_password" postgres \
  psql -v ON_ERROR_STOP=1 -U team_wiki_publish -d team_wiki -c \
  "UPDATE background_jobs SET status = 'failed' WHERE kind = 'classify.permission-probe'"

classify_status="$(docker compose exec -T -e PGPASSWORD="$migrator_password" postgres \
  psql -Atq -v ON_ERROR_STOP=1 -U team_wiki_migrator -d team_wiki -c \
  "SELECT status FROM background_jobs WHERE kind = 'classify.permission-probe'")"
test "$classify_status" = "queued"

if docker compose exec -T -e PGPASSWORD="$publish_password" postgres \
  psql -v ON_ERROR_STOP=1 -U team_wiki_publish -d team_wiki -c \
  "INSERT INTO background_jobs (kind, dedupe_key, payload)
   VALUES ('publish.permission-probe', 'unauthorized-insert', '{\"schema_version\":1}')"
then
  echo "publisher unexpectedly inserted a job" >&2
  exit 1
fi

docker compose exec -T -e PGPASSWORD="$migrator_password" postgres \
  psql -v ON_ERROR_STOP=1 -U team_wiki_migrator -d team_wiki -c \
  "DELETE FROM background_jobs WHERE kind LIKE '%.permission-probe'"
