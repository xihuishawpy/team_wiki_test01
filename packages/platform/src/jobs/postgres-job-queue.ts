import type { Pool } from 'pg';

export type JobStatus = 'queued' | 'running' | 'retry' | 'succeeded' | 'failed';

interface JobRow {
  readonly id: string;
  readonly kind: string;
  readonly dedupe_key: string;
  readonly payload: unknown;
  readonly status: JobStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly available_at: Date;
  readonly lease_owner: string | null;
  readonly lease_until: Date | null;
  readonly last_error_code: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface Job {
  readonly id: string;
  readonly kind: string;
  readonly dedupeKey: string;
  readonly payload: unknown;
  readonly status: JobStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: Date;
  readonly leaseOwner: string | null;
  readonly leaseUntil: Date | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ClaimedJob extends Job {
  readonly status: 'running';
  readonly leaseOwner: string;
  readonly leaseUntil: Date;
}

export interface EnqueueJob {
  readonly kind: string;
  readonly dedupeKey: string;
  readonly payload: unknown;
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly availableAt?: Date;
}

export interface ClaimJob {
  readonly workerId: string;
  readonly kinds: readonly string[];
  readonly leaseMs: number;
}

export interface JobQueue {
  enqueue(input: EnqueueJob): Promise<Job>;
  claim(input: ClaimJob): Promise<ClaimedJob | null>;
  markSucceeded(job: ClaimedJob): Promise<void>;
  markRetry(job: ClaimedJob, errorCode: string, delayMs: number): Promise<void>;
  markFailed(job: ClaimedJob, errorCode: string): Promise<void>;
}

export class LostJobLeaseError extends Error {
  public constructor(jobId: string) {
    super(`Job lease is no longer owned: ${jobId}`);
    this.name = 'LostJobLeaseError';
  }
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresJobQueue implements JobQueue {
  public constructor(private readonly pool: Pool) {}

  public async enqueue(input: EnqueueJob): Promise<Job> {
    const result = await this.pool.query<JobRow>(
      `
        INSERT INTO background_jobs (
          kind, dedupe_key, payload, priority, max_attempts, available_at
        )
        VALUES ($1, $2, $3::jsonb, $4, $5, $6)
        ON CONFLICT (kind, dedupe_key) DO NOTHING
        RETURNING *
      `,
      [
        input.kind,
        input.dedupeKey,
        JSON.stringify(input.payload),
        input.priority ?? 0,
        input.maxAttempts ?? 5,
        input.availableAt ?? new Date(),
      ],
    );
    const inserted = result.rows[0];
    if (inserted) {
      return mapJob(inserted);
    }

    const existing = await this.pool.query<JobRow>(
      'SELECT * FROM background_jobs WHERE kind = $1 AND dedupe_key = $2',
      [input.kind, input.dedupeKey],
    );
    return mapJob(existing.rows[0]!);
  }

  public async claim(input: ClaimJob): Promise<ClaimedJob | null> {
    if (input.kinds.length === 0) {
      return null;
    }
    const result = await this.pool.query<JobRow>(
      `
        WITH expired_exhausted AS (
          UPDATE background_jobs
          SET status = 'failed',
              lease_owner = NULL,
              lease_until = NULL,
              last_error_code = 'LEASE_EXPIRED_AT_ATTEMPT_LIMIT',
              updated_at = now()
          WHERE status = 'running'
            AND lease_until < now()
            AND attempts >= max_attempts
        ), candidate AS (
          SELECT id
          FROM background_jobs
          WHERE kind = ANY($3::text[])
            AND attempts < max_attempts
            AND (
              (status IN ('queued', 'retry') AND available_at <= now())
              OR (status = 'running' AND lease_until < now())
            )
          ORDER BY priority DESC, available_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE background_jobs AS job
        SET status = 'running',
            lease_owner = $1,
            lease_until = now() + ($2::integer * interval '1 millisecond'),
            attempts = attempts + 1,
            updated_at = now()
        FROM candidate
        WHERE job.id = candidate.id
        RETURNING job.*
      `,
      [input.workerId, input.leaseMs, input.kinds],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return mapJob(row) as ClaimedJob;
  }

  public async markSucceeded(job: ClaimedJob): Promise<void> {
    await this.finishOwnedJob(job, "status = 'succeeded', last_error_code = NULL");
  }

  public async markRetry(job: ClaimedJob, errorCode: string, delayMs: number): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE background_jobs
        SET status = 'retry',
            available_at = now() + ($3::integer * interval '1 millisecond'),
            lease_owner = NULL,
            lease_until = NULL,
            last_error_code = $4,
            updated_at = now()
        WHERE id = $1 AND status = 'running' AND lease_owner = $2
      `,
      [job.id, job.leaseOwner, delayMs, errorCode],
    );
    if (result.rowCount !== 1) {
      throw new LostJobLeaseError(job.id);
    }
  }

  public async markFailed(job: ClaimedJob, errorCode: string): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE background_jobs
        SET status = 'failed',
            lease_owner = NULL,
            lease_until = NULL,
            last_error_code = $3,
            updated_at = now()
        WHERE id = $1 AND status = 'running' AND lease_owner = $2
      `,
      [job.id, job.leaseOwner, errorCode],
    );
    if (result.rowCount !== 1) {
      throw new LostJobLeaseError(job.id);
    }
  }

  private async finishOwnedJob(job: ClaimedJob, assignment: string): Promise<void> {
    const result = await this.pool.query(
      `
        UPDATE background_jobs
        SET ${assignment},
            lease_owner = NULL,
            lease_until = NULL,
            updated_at = now()
        WHERE id = $1 AND status = 'running' AND lease_owner = $2
      `,
      [job.id, job.leaseOwner],
    );
    if (result.rowCount !== 1) {
      throw new LostJobLeaseError(job.id);
    }
  }
}
