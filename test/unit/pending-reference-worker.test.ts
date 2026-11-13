import { expect, test } from 'bun:test';
import type { PendingReferenceReader } from '../../src/application/ports/pending-reference-reader.js';
import type { ProcessWagerResult } from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import { FinancialApplicationError } from '../../src/application/errors/financial-application.error.js';
import {
  WagerTransactionStatus as Status,
  FailureCode,
} from '../../src/domain/financial.types.js';
import { workerOptions } from '../../src/infrastructure/config/worker-options.js';
import { PendingReferenceWorker } from '../../src/infrastructure/messaging/consumers/pending-reference.worker.js';
import { MessagingDiagnostics } from '../../src/infrastructure/messaging/messaging-diagnostics.js';
import { transactionCancellation } from '../../src/infrastructure/database/transaction-cancellation.js';

const now = new Date('2026-11-13T12:00:00.000Z');
const options = workerOptions({});
const candidate = { transactionId: crypto.randomUUID(), referenceAttempts: 1 };
const result: ProcessWagerResult = {
  transactionId: candidate.transactionId,
  status: Status.PendingReference,
  createdAt: now.toISOString(),
  idempotentReplay: false,
  canAcknowledge: false,
};
const silent = (): MessagingDiagnostics => new MessagingDiagnostics(() => {});

test('pending reference selection receives controlled time, TTL cutoff and bounded batch size', async () => {
  const selections: unknown[][] = [];
  const calls: unknown[][] = [];
  const reader: PendingReferenceReader = {
    findDue: async (...args) => {
      selections.push(args);
      return [candidate];
    },
  };
  const worker = new PendingReferenceWorker(
    reader,
    {
      execute: async (...args) => {
        calls.push(args);
        expect(transactionCancellation.getStore()).toBeDefined();
        return result;
      },
    },
    { ...options, pendingReferenceBatchSize: 7 },
    silent(),
    () => now,
  );

  expect(await worker.processBatch()).toBe(1);

  expect(selections).toEqual([[now, new Date('2026-11-12T12:00:00.000Z'), 7]]);
  expect(calls).toEqual([
    [candidate.transactionId, { correlationId: candidate.transactionId }],
  ]);
});

for (const [status, metric, event] of [
  [Status.Processed, 'pendingReferenceResolved', 'resolved'],
  [Status.PendingReference, 'pendingReferenceRescheduled', 'pending'],
  [Status.Rejected, 'pendingReferenceRejected', 'rejected'],
] as const) {
  test(
    'pending reference diagnostics report ' + status + ' without payloads',
    async () => {
      const records: Readonly<Record<string, unknown>>[] = [];
      const diagnostics = new MessagingDiagnostics((record) =>
        records.push(record),
      );
      const worker = new PendingReferenceWorker(
        { findDue: async () => [candidate] },
        {
          execute: async () => ({
            ...result,
            status,
            failureCode:
              status === Status.Rejected
                ? FailureCode.ReferenceNotFound
                : undefined,
          }),
        },
        options,
        diagnostics,
      );

      await worker.processBatch();

      expect(diagnostics.snapshot()[metric]).toBe(1);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        event: 'pending_reference_' + event,
        transactionId: candidate.transactionId,
        correlationId: candidate.transactionId,
        attempt: 2,
      });
      expect(records[0]).not.toHaveProperty('money');
    },
  );
}

test('stale candidate replay does not count another reference attempt', async () => {
  const diagnostics = silent();
  const worker = new PendingReferenceWorker(
    { findDue: async () => [candidate] },
    {
      execute: async () => ({ ...result, idempotentReplay: true }),
    },
    options,
    diagnostics,
  );

  expect(await worker.processBatch()).toBe(0);
  expect(diagnostics.snapshot()).toEqual({});
});

test('transient candidate failure leaves the next candidate eligible for processing', async () => {
  const diagnostics = silent();
  let calls = 0;
  const worker = new PendingReferenceWorker(
    {
      findDue: async () => [
        candidate,
        { ...candidate, transactionId: crypto.randomUUID() },
      ],
    },
    {
      execute: async () => {
        calls += 1;
        if (calls === 1) {
          throw new FinancialApplicationError('TRANSIENT_FAILURE');
        }

        return result;
      },
    },
    options,
    diagnostics,
  );

  expect(await worker.processBatch()).toBe(1);
  expect(calls).toBe(2);
  expect(diagnostics.snapshot()).toEqual({
    pendingReferenceFailures: 1,
    pendingReferenceRescheduled: 1,
  });
});

test('polling recovers after selection failure and waits between non-overlapping cycles', async () => {
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delays: number[] = [];
  let queries = 0;
  const diagnostics = silent();
  const worker = new PendingReferenceWorker(
    {
      findDue: async () => {
        queries += 1;
        if (queries === 1) {
          throw new Error('Database temporarily unavailable');
        }

        return [];
      },
    },
    { execute: async () => result },
    { ...options, pendingReferencePollMs: 25 },
    diagnostics,
    () => now,
    async (delay) => {
      delays.push(delay);
      if (delays.length === 2) {
        waiting.resolve();
        await release.promise;
      }
    },
  );

  worker.start();
  worker.start();
  await waiting.promise;
  const stopping = worker.stop();
  release.resolve();
  await stopping;

  expect(queries).toBe(2);
  expect(delays).toEqual([1000, 25]);
  expect(diagnostics.snapshot().pendingReferenceFailures).toBe(1);
});

test('shutdown drains current work and prevents the next candidate and polling cycle', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let stopped = false;
  const records: Readonly<Record<string, unknown>>[] = [];
  const worker = new PendingReferenceWorker(
    { findDue: async () => [candidate, candidate] },
    {
      execute: async () => {
        calls += 1;
        entered.resolve();
        await release.promise;
        return result;
      },
    },
    options,
    new MessagingDiagnostics((record) => records.push(record)),
  );

  worker.start();
  await entered.promise;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release.resolve();
  await stopping;
  worker.start();

  expect(calls).toBe(1);
  expect(await worker.processBatch()).toBe(0);
  expect(records.map((record) => record.event)).toEqual([
    'pending_reference_worker_started',
    'pending_reference_pending',
    'pending_reference_worker_stopped',
  ]);
});

test('cancelled batch does not select or execute financial work', async () => {
  const abort = new AbortController();
  abort.abort();
  let selected = false;
  const worker = new PendingReferenceWorker(
    {
      findDue: async () => {
        selected = true;
        return [];
      },
    },
    { execute: async () => result },
    options,
    silent(),
  );

  const failure = await worker.processBatch(abort.signal).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(DOMException);
  expect(selected).toBe(false);
});

test('shutdown deadline propagates cooperative cancellation and settles active work', async () => {
  const entered = Promise.withResolvers<void>();
  let cancelled = false;
  const worker = new PendingReferenceWorker(
    { findDue: async () => [candidate] },
    {
      execute: async () => {
        const signal = transactionCancellation.getStore();
        if (!signal) {
          throw new Error('Missing cancellation context');
        }

        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        cancelled = true;
        signal.throwIfAborted();
        return result;
      },
    },
    { ...options, shutdownTimeoutMs: 11000 },
    silent(),
  );

  worker.start();
  await entered.promise;
  await worker.stop();

  expect(cancelled).toBe(true);
});

test('pending reference configuration defaults and overrides are validated', () => {
  expect(options).toMatchObject({
    pendingReferenceEnabled: false,
    pendingReferencePollMs: 1000,
    pendingReferenceBatchSize: 20,
  });
  expect(
    workerOptions({
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '25',
      PENDING_REFERENCE_BATCH_SIZE: '3',
    }),
  ).toMatchObject({
    pendingReferenceEnabled: true,
    pendingReferencePollMs: 25,
    pendingReferenceBatchSize: 3,
  });

  for (const env of [
    { PENDING_REFERENCE_WORKER_ENABLED: 'yes' },
    { PENDING_REFERENCE_POLL_INTERVAL_MS: '0' },
    { PENDING_REFERENCE_POLL_INTERVAL_MS: '1.5' },
    { PENDING_REFERENCE_BATCH_SIZE: '101' },
    { PENDING_REFERENCE_BATCH_SIZE: '-1' },
  ]) {
    expect(() => workerOptions(env)).toThrow();
  }
});
