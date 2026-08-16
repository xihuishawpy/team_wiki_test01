import path from 'node:path';

import { loadConfig } from '../config/config.js';
import { createDatabasePool } from '../database/pool.js';
import { MigrationRunner } from './migration-runner.js';

type MigrationAction = 'up' | 'down' | 'status';

function parseAction(value: string | undefined): MigrationAction {
  if (value === 'up' || value === 'down' || value === 'status') {
    return value;
  }
  throw new Error('Usage: migration CLI requires one of: up, down, status');
}

async function main(): Promise<void> {
  const action = parseAction(process.argv[2]);
  const config = loadConfig(process.env);
  const pool = createDatabasePool(config.common.databaseUrl, 'migration');
  const runner = new MigrationRunner(
    pool,
    process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'migrations'),
  );
  try {
    const result =
      action === 'up'
        ? await runner.up()
        : action === 'down'
          ? await runner.down()
          : await runner.status();
    process.stdout.write(`${JSON.stringify({ action, result })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({ error_code: 'MIGRATION_COMMAND_FAILED' })}\n`);
  process.exitCode = 1;
});
