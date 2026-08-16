import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  createDatabasePool,
  createLogger,
  JobWorker,
  loadConfig,
  MigrationRunner,
  PostgresJobQueue,
  type ApplicationRole,
  type JobHandler,
} from '@team-wiki/platform';

type WorkerRole = Exclude<ApplicationRole, 'api'>;

function workerRole(value: string | undefined): WorkerRole {
  if (value === 'publish' || value === 'classify' || value === 'reconcile') {
    return value;
  }
  throw new Error('Worker role must be publish, classify, or reconcile');
}

async function main(): Promise<void> {
  const role = workerRole(process.argv[2]);
  const config = loadConfig({ ...process.env, APP_ROLE: role });
  const logger = createLogger(config.common);
  const database = createDatabasePool(config.common.databaseUrl, role);
  const migrations = new MigrationRunner(database, path.resolve(process.cwd(), 'migrations'));
  const migrationStatus = await migrations.status();
  if (migrationStatus.pending.length > 0) {
    throw new Error('Database migrations are pending');
  }

  const kind = `${role}.noop`;
  const noop: JobHandler = () => Promise.resolve();
  const workerId = `${role}-${randomUUID()}`;
  const worker = new JobWorker({
    queue: new PostgresJobQueue(database),
    workerId,
    kinds: [kind],
    handlers: { [kind]: noop },
    onDeadLetter: (job, errorCode) => {
      logger.error(
        { worker_id: workerId, job_id: job.id, job_kind: job.kind, error_code: errorCode },
        'job_dead_lettered',
      );
    },
  });
  const controller = new AbortController();
  const stop = (signal: string): void => {
    logger.info({ signal, worker_id: workerId }, 'worker_shutdown_started');
    controller.abort();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  logger.info({ worker_id: workerId }, 'worker_started');
  try {
    await worker.run(controller.signal, config.common.pollIntervalMs);
  } finally {
    await database.end();
    logger.info({ worker_id: workerId }, 'worker_stopped');
  }
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({ error_code: 'WORKER_STARTUP_FAILED' })}\n`);
  process.exitCode = 1;
});
