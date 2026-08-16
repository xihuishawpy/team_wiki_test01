import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Pool, PoolClient } from 'pg';

interface Migration {
  readonly id: string;
  readonly checksum: string;
  readonly upSql: string;
  readonly downSql: string;
}

interface AppliedMigrationRow {
  readonly id: string;
  readonly checksum: string;
}

export interface MigrationStatus {
  readonly applied: readonly string[];
  readonly pending: readonly string[];
}

const migrationNamePattern = /^(\d{4}_[a-z0-9_]+)\.up\.sql$/;
const migrationLockName = 'team-wiki-schema-migrations';

async function discoverMigrations(directory: string): Promise<readonly Migration[]> {
  const fileNames = await readdir(directory);
  const ids = fileNames
    .map((fileName) => migrationNamePattern.exec(fileName)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort();

  return Promise.all(
    ids.map(async (id) => {
      const [upSql, downSql] = await Promise.all([
        readFile(path.join(directory, `${id}.up.sql`), 'utf8'),
        readFile(path.join(directory, `${id}.down.sql`), 'utf8'),
      ]);
      return {
        id,
        checksum: createHash('sha256').update(upSql).digest('hex'),
        upSql,
        downSql,
      };
    }),
  );
}

async function migrationTableExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ table_name: string | null }>(
    "SELECT to_regclass('schema_migrations')::text AS table_name",
  );
  return result.rows[0]?.table_name !== null;
}

async function readApplied(client: PoolClient): Promise<readonly AppliedMigrationRow[]> {
  if (!(await migrationTableExists(client))) {
    return [];
  }
  const result = await client.query<AppliedMigrationRow>(
    'SELECT id, checksum FROM schema_migrations ORDER BY id',
  );
  return result.rows;
}

function validateApplied(
  migrations: readonly Migration[],
  applied: readonly AppliedMigrationRow[],
): void {
  const byId = new Map(migrations.map((migration) => [migration.id, migration]));
  for (const recorded of applied) {
    const local = byId.get(recorded.id);
    if (!local) {
      throw new Error(`Applied migration is missing locally: ${recorded.id}`);
    }
    if (local.checksum !== recorded.checksum) {
      throw new Error(`Applied migration checksum changed: ${recorded.id}`);
    }
  }
}

async function withMigrationLock<T>(client: PoolClient, operation: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [migrationLockName]);
  try {
    return await operation();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [migrationLockName]);
  }
}

export class MigrationRunner {
  public constructor(
    private readonly pool: Pool,
    private readonly migrationsDirectory: string,
  ) {}

  public async status(): Promise<MigrationStatus> {
    const migrations = await discoverMigrations(this.migrationsDirectory);
    const client = await this.pool.connect();
    try {
      const applied = await readApplied(client);
      validateApplied(migrations, applied);
      const appliedIds = applied.map((migration) => migration.id);
      const appliedSet = new Set(appliedIds);
      return {
        applied: appliedIds,
        pending: migrations
          .filter((migration) => !appliedSet.has(migration.id))
          .map((migration) => migration.id),
      };
    } finally {
      client.release();
    }
  }

  public async up(): Promise<readonly string[]> {
    const migrations = await discoverMigrations(this.migrationsDirectory);
    const client = await this.pool.connect();
    try {
      return await withMigrationLock(client, async () => {
        await client.query('BEGIN');
        try {
          await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
              id text PRIMARY KEY,
              checksum text NOT NULL,
              applied_at timestamptz NOT NULL DEFAULT now()
            )
          `);
          const applied = await readApplied(client);
          validateApplied(migrations, applied);
          const appliedSet = new Set(applied.map((migration) => migration.id));
          const pending = migrations.filter((migration) => !appliedSet.has(migration.id));

          for (const migration of pending) {
            await client.query(migration.upSql);
            await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [
              migration.id,
              migration.checksum,
            ]);
          }
          await client.query('COMMIT');
          return pending.map((migration) => migration.id);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    } finally {
      client.release();
    }
  }

  public async down(): Promise<string | null> {
    const migrations = await discoverMigrations(this.migrationsDirectory);
    const client = await this.pool.connect();
    try {
      return await withMigrationLock(client, async () => {
        const applied = await readApplied(client);
        validateApplied(migrations, applied);
        const latest = applied.at(-1);
        if (!latest) {
          return null;
        }
        const migration = migrations.find((candidate) => candidate.id === latest.id)!;

        await client.query('BEGIN');
        try {
          await client.query(migration.downSql);
          await client.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
          await client.query('COMMIT');
          return migration.id;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    } finally {
      client.release();
    }
  }
}
