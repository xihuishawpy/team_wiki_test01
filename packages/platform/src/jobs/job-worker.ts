import type { ClaimedJob, JobQueue } from './postgres-job-queue.js';

export type JobHandler = (job: ClaimedJob) => Promise<void>;

export interface JobWorkerOptions {
  readonly queue: JobQueue;
  readonly workerId: string;
  readonly kinds: readonly string[];
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly leaseMs?: number;
  readonly retryDelay?: (attempts: number) => number;
}

export class JobHandlerError extends Error {
  public constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'JobHandlerError';
  }
}

function supportedPayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'schema_version' in payload &&
    payload.schema_version === 1
  );
}

function defaultRetryDelay(attempts: number): number {
  const exponentialDelay = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(exponentialDelay * jitter);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export class JobWorker {
  private readonly leaseMs: number;
  private readonly retryDelay: (attempts: number) => number;

  public constructor(private readonly options: JobWorkerOptions) {
    this.leaseMs = options.leaseMs ?? 60_000;
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  public async runOnce(): Promise<boolean> {
    const job = await this.options.queue.claim({
      workerId: this.options.workerId,
      kinds: this.options.kinds,
      leaseMs: this.leaseMs,
    });
    if (!job) {
      return false;
    }

    if (!supportedPayload(job.payload)) {
      await this.options.queue.markFailed(job, 'UNKNOWN_PAYLOAD_SCHEMA');
      return true;
    }

    const handler = this.options.handlers[job.kind];
    if (!handler) {
      await this.options.queue.markFailed(job, 'UNSUPPORTED_JOB_KIND');
      return true;
    }

    try {
      await handler(job);
      await this.options.queue.markSucceeded(job);
    } catch (error) {
      const handlerError =
        error instanceof JobHandlerError
          ? error
          : new JobHandlerError('UNEXPECTED_HANDLER_ERROR', true);
      if (handlerError.retryable && job.attempts < job.maxAttempts) {
        await this.options.queue.markRetry(job, handlerError.code, this.retryDelay(job.attempts));
      } else {
        await this.options.queue.markFailed(job, handlerError.code);
      }
    }
    return true;
  }

  public async run(signal: AbortSignal, pollIntervalMs: number): Promise<void> {
    while (!signal.aborted) {
      const processed = await this.runOnce();
      if (!processed) {
        await delay(pollIntervalMs, signal);
      }
    }
  }
}
