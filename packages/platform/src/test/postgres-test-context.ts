import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

export interface PostgresTestContext {
  readonly pool: Pool;
  readonly schema: string;
  readonly dispose: () => Promise<void>;
}

export async function createPostgresTestContext(
  connectionString: string,
): Promise<PostgresTestContext> {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const administrator = new Pool({ connectionString, max: 1 });
  await administrator.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString,
    max: 8,
    options: `-c search_path=${schema}`,
  });

  return {
    pool,
    schema,
    dispose: async () => {
      await pool.end();
      await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
      await administrator.end();
    },
  };
}
