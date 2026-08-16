import { describe, expect, it, vi } from 'vitest';

import type { ClaimedJob, JobQueue } from './postgres-job-queue.js';
import { JobHandlerError, JobWorker } from './job-worker.js';

function claimedJob(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'job-1',
    kind: 'publish.noop',
    dedupeKey: 'dedupe-1',
    payload: { schema_version: 1 },
    status: 'running',
    priority: 0,
    attempts: 1,
    maxAttempts: 5,
    availableAt: timestamp,
    leaseOwner: 'worker-1',
    leaseUntil: timestamp,
    lastErrorCode: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function queueWith(job: ClaimedJob): JobQueue {
  return {
    enqueue: vi.fn(),
    claim: vi.fn().mockResolvedValue(job),
    markSucceeded: vi.fn(),
    markRetry: vi.fn(),
    markFailed: vi.fn(),
  };
}

describe('JobWorker', () => {
  it('completes a supported schema-versioned job exactly once', async () => {
    const job = claimedJob();
    const queue = queueWith(job);
    const handler = vi.fn().mockResolvedValue(undefined);
    const worker = new JobWorker({
      queue,
      workerId: 'worker-1',
      kinds: ['publish.noop'],
      handlers: { 'publish.noop': handler },
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(job);
    expect(queue.markSucceeded).toHaveBeenCalledOnce();
    expect(queue.markRetry).not.toHaveBeenCalled();
  });

  it('dead-letters an unknown payload schema without invoking the handler', async () => {
    const job = claimedJob({ payload: { schema_version: 999 } });
    const queue = queueWith(job);
    const handler = vi.fn();
    const worker = new JobWorker({
      queue,
      workerId: 'worker-1',
      kinds: ['publish.noop'],
      handlers: { 'publish.noop': handler },
    });

    await worker.runOnce();

    expect(handler).not.toHaveBeenCalled();
    expect(queue.markFailed).toHaveBeenCalledWith(job, 'UNKNOWN_PAYLOAD_SCHEMA');
  });

  it('retries safe transient failures but stops at the configured attempt limit', async () => {
    const retryableJob = claimedJob({ attempts: 2, maxAttempts: 3 });
    const retryQueue = queueWith(retryableJob);
    const handler = vi.fn().mockRejectedValue(new JobHandlerError('GITHUB_RATE_LIMITED', true));
    const worker = new JobWorker({
      queue: retryQueue,
      workerId: 'worker-1',
      kinds: ['publish.noop'],
      handlers: { 'publish.noop': handler },
      retryDelay: () => 2_500,
    });

    await worker.runOnce();
    expect(retryQueue.markRetry).toHaveBeenCalledWith(retryableJob, 'GITHUB_RATE_LIMITED', 2_500);

    const exhaustedJob = claimedJob({ attempts: 3, maxAttempts: 3 });
    const exhaustedQueue = queueWith(exhaustedJob);
    const exhaustedWorker = new JobWorker({
      queue: exhaustedQueue,
      workerId: 'worker-1',
      kinds: ['publish.noop'],
      handlers: { 'publish.noop': handler },
    });
    await exhaustedWorker.runOnce();
    expect(exhaustedQueue.markFailed).toHaveBeenCalledWith(exhaustedJob, 'GITHUB_RATE_LIMITED');
  });
});
