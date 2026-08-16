import 'reflect-metadata';

import path from 'node:path';

import {
  createDatabasePool,
  createLogger,
  createPostgresProbes,
  loadConfig,
  MigrationRunner,
  NestStructuredLogger,
} from '@team-wiki/platform';

import { createApiApplication } from './bootstrap.js';

async function main(): Promise<void> {
  const loaded = loadConfig({ ...process.env, APP_ROLE: 'api' });
  if (!('api' in loaded)) {
    throw new Error('API role configuration was not loaded');
  }
  const logger = createLogger(loaded.common);
  const database = createDatabasePool(loaded.common.databaseUrl, 'api');
  const migrations = new MigrationRunner(database, path.resolve(process.cwd(), 'migrations'));
  const application = await createApiApplication({
    config: loaded,
    probes: createPostgresProbes(database, migrations),
    logger: new NestStructuredLogger(logger),
    webRoot: path.resolve(process.cwd(), 'apps/web/dist'),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown_started');
    await application.close();
    await database.end();
    logger.info('shutdown_complete');
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await application.listen(loaded.api.port, '0.0.0.0');
  logger.info({ port: loaded.api.port }, 'api_started');
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({ error_code: 'API_STARTUP_FAILED' })}\n`);
  process.exitCode = 1;
});
