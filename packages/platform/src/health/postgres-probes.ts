import type { Pool } from 'pg';

import type { MigrationRunner } from '../migrations/migration-runner.js';
import type { DependencyProbe } from './readiness.js';

export function createPostgresProbes(
  pool: Pool,
  migrationRunner: MigrationRunner,
): readonly DependencyProbe[] {
  return [
    {
      name: 'database',
      required: true,
      check: async () => {
        await pool.query('SELECT 1');
        return { status: 'ok' };
      },
    },
    {
      name: 'migrations',
      required: true,
      check: async () => {
        const status = await migrationRunner.status();
        return status.pending.length === 0
          ? { status: 'ok' }
          : { status: 'unavailable', code: 'MIGRATIONS_PENDING' };
      },
    },
  ];
}
