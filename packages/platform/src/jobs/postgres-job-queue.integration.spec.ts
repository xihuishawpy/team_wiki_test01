import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MigrationRunner } from '../migrations/migration-runner.js';
import {
  createPostgresTestContext,
  type PostgresTestContext,
} from '../test/postgres-test-context.js';
import { PostgresJobQueue } from './postgres-job-queue.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const migrationsDirectory = fileURLToPath(new URL('../../../../migrations', import.meta.url));

describeWithPostgres('PostgresJobQueue concurrency', () => {
  let context: PostgresTestContext;
  let firstQueue: PostgresJobQueue;
  let secondQueue: PostgresJobQueue;

  beforeEach(async () => {
    context = await createPostgresTestContext(databaseUrl!);
    await new MigrationRunner(context.pool, migrationsDirectory).up();
    firstQueue = new PostgresJobQueue(context.pool);
    secondQueue = new PostgresJobQueue(context.pool);
  });

  afterEach(async () => {
    await context.dispose();
  });

  it('lets two workers race without claiming or completing a deduplicated job twice', async () => {
    const enqueued = await firstQueue.enqueue({
      kind: 'publish.noop',
      dedupeKey: 'article-version-1',
      payload: { schema_version: 1, article_id: 'article-1' },
    });
    await secondQueue.enqueue({
      kind: 'publish.noop',
      dedupeKey: 'article-version-1',
      payload: { schema_version: 1, article_id: 'article-1' },
    });

    const claims = await Promise.all([
      firstQueue.claim({ workerId: 'worker-a', kinds: ['publish.noop'], leaseMs: 60_000 }),
      secondQueue.claim({ workerId: 'worker-b', kinds: ['publish.noop'], leaseMs: 60_000 }),
    ]);
    const claimed = claims.filter((job) => job !== null);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(enqueued.id);
    const winner = claimed[0]!;
    await (winner.leaseOwner === 'worker-a' ? firstQueue : secondQueue).markSucceeded(winner);

    const result = await context.pool.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM background_jobs WHERE id = $1',
      [enqueued.id],
    );
    expect(result.rows).toEqual([{ status: 'succeeded', attempts: 1 }]);
  });

  it('recovers an abandoned running job after its lease expires', async () => {
    const enqueued = await firstQueue.enqueue({
      kind: 'classify.noop',
      dedupeKey: 'article-version-2',
      payload: { schema_version: 1, article_id: 'article-2' },
    });
    const abandoned = await firstQueue.claim({
      workerId: 'worker-a',
      kinds: ['classify.noop'],
      leaseMs: 60_000,
    });
    expect(abandoned?.id).toBe(enqueued.id);

    await context.pool.query(
      "UPDATE background_jobs SET lease_until = now() - interval '1 second' WHERE id = $1",
      [enqueued.id],
    );
    const recovered = await secondQueue.claim({
      workerId: 'worker-b',
      kinds: ['classify.noop'],
      leaseMs: 60_000,
    });

    expect(recovered).toMatchObject({
      id: enqueued.id,
      leaseOwner: 'worker-b',
      attempts: 2,
    });
  });
});
