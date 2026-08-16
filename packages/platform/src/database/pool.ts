import { Pool } from 'pg';

export function createDatabasePool(databaseUrl: string, role: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    application_name: `team-wiki-${role}`,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    max: role === 'api' ? 10 : 5,
    query_timeout: 5_000,
  });
}
