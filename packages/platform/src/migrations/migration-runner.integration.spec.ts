import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createPostgresTestContext,
  type PostgresTestContext,
} from '../test/postgres-test-context.js';
import { MigrationRunner } from './migration-runner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const migrationsDirectory = fileURLToPath(new URL('../../../../migrations', import.meta.url));

describeWithPostgres('MigrationRunner with PostgreSQL', () => {
  let context: PostgresTestContext;
  let runner: MigrationRunner;

  beforeEach(async () => {
    context = await createPostgresTestContext(databaseUrl!);
    runner = new MigrationRunner(context.pool, migrationsDirectory);
  });

  afterEach(async () => {
    await context.dispose();
  });

  it('migrates an empty database forward and rolls the latest migration back', async () => {
    await runner.up();

    await expect(runner.status()).resolves.toMatchObject({
      pending: [],
      applied: ['0001_platform'],
    });
    await expect(
      context.pool.query("SELECT to_regclass('background_jobs') AS table_name"),
    ).resolves.toMatchObject({ rows: [{ table_name: 'background_jobs' }] });

    await runner.down();

    await expect(runner.status()).resolves.toMatchObject({
      pending: ['0001_platform'],
      applied: [],
    });
    await expect(
      context.pool.query("SELECT to_regclass('background_jobs') AS table_name"),
    ).resolves.toMatchObject({ rows: [{ table_name: null }] });
  });

  it('is repeatable and never reapplies an already recorded migration', async () => {
    await runner.up();
    await runner.up();

    const result = await context.pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM schema_migrations',
    );
    expect(result.rows[0]?.count).toBe('1');
  });

  it('rolls back the entire batch when a later migration fails', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'team-wiki-migrations-'));
    try {
      await Promise.all([
        writeFile(
          path.join(temporaryDirectory, '0001_valid.up.sql'),
          'CREATE TABLE migration_atomicity_probe (id integer PRIMARY KEY);',
        ),
        writeFile(
          path.join(temporaryDirectory, '0001_valid.down.sql'),
          'DROP TABLE migration_atomicity_probe;',
        ),
        writeFile(
          path.join(temporaryDirectory, '0002_invalid.up.sql'),
          'CREATE TABLE should_rollback_too (id integer); SELECT invalid_syntax FROM;',
        ),
        writeFile(
          path.join(temporaryDirectory, '0002_invalid.down.sql'),
          'DROP TABLE should_rollback_too;',
        ),
      ]);

      await expect(new MigrationRunner(context.pool, temporaryDirectory).up()).rejects.toThrow();
      await expect(
        context.pool.query(
          "SELECT to_regclass('migration_atomicity_probe') AS first, " +
            "to_regclass('should_rollback_too') AS second, " +
            "to_regclass('schema_migrations') AS migrations",
        ),
      ).resolves.toMatchObject({
        rows: [{ first: null, second: null, migrations: null }],
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
