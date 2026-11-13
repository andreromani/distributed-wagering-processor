import 'reflect-metadata';
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  expect,
  test,
} from 'bun:test';
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { databaseOptions } from '../../src/infrastructure/database/options.js';
import { FinancialFoundation1797000000000 } from '../../src/infrastructure/database/migrations/1797000000000-financial-foundation.js';
import { RejectedSnapshots1797000001000 } from '../../src/infrastructure/database/migrations/1797000001000-rejected-snapshots.js';
import { TypeOrmFinancialTransaction } from '../../src/infrastructure/database/repositories/typeorm-financial-transaction.js';
import { TypeOrmPendingReferenceReader } from '../../src/infrastructure/database/repositories/typeorm-pending-reference.reader.js';
import { OpenWalletUseCase } from '../../src/application/use-cases/open-wallet.use-case.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerInput,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import { ReprocessPendingReferenceUseCase } from '../../src/application/use-cases/reprocess-pending-reference.use-case.js';
import type { FinancialTransaction } from '../../src/application/ports/financial-transaction.js';
import type { PendingReferenceReader } from '../../src/application/ports/pending-reference-reader.js';
import { FinancialApplicationError } from '../../src/application/errors/financial-application.error.js';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/financial.types.js';
import { workerOptions } from '../../src/infrastructure/config/worker-options.js';
import { PendingReferenceWorker } from '../../src/infrastructure/messaging/consumers/pending-reference.worker.js';
import { MessagingDiagnostics } from '../../src/infrastructure/messaging/messaging-diagnostics.js';
import { MessagingLifecycle } from '../../src/infrastructure/messaging/messaging-lifecycle.js';
import { WagerTransactionConsumer } from '../../src/infrastructure/messaging/consumers/wager-transaction.consumer.js';
import { OutboxPublisher } from '../../src/infrastructure/messaging/publishers/outbox.publisher.js';

const database = 'wager_references_' + crypto.randomUUID().replaceAll('-', '');
const admin = new DataSource({
  ...databaseOptions(),
  extra: { statement_timeout: 60000, query_timeout: 65000 },
});
const source = new DataSource({
  ...databaseOptions(),
  database,
  migrations: [
    FinancialFoundation1797000000000,
    RejectedSnapshots1797000001000,
  ],
});
const transaction = new TypeOrmFinancialTransaction(source);
const reader = new TypeOrmPendingReferenceReader(source);
const options = { ...workerOptions({}), pendingReferencePollMs: 10 };
let instant = new Date('2026-11-13T12:00:00.000Z');
const runtime = { now: () => new Date(instant), id: () => crypto.randomUUID() };
const processor = new ProcessWagerTransactionUseCase(transaction, runtime);
const reprocess = new ReprocessPendingReferenceUseCase(processor);
const workers: PendingReferenceWorker[] = [];

beforeAll(async () => {
  await admin.initialize();
  await admin.query('CREATE DATABASE "' + database + '"');
  await source.initialize();
  expect(await source.runMigrations()).toHaveLength(2);
}, 60000);

beforeEach(async () => {
  instant = new Date('2026-11-13T12:00:00.000Z');
  const expired = new ProcessWagerTransactionUseCase(transaction, {
    ...runtime,
    now: () => new Date('2026-11-16T12:00:00.000Z'),
  });
  for (const pending of await reader.findDue(
    new Date('2026-11-16T12:00:00.000Z'),
    new Date('2026-11-15T12:00:00.000Z'),
    100,
  )) {
    await expired.reprocess(pending.transactionId);
  }
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

afterAll(async () => {
  if (source.isInitialized) {
    await source.destroy();
  }

  if (admin.isInitialized) {
    if (!/^wager_references_[a-f0-9]{32}$/.test(database)) {
      throw new Error('Unsafe test database');
    }

    await admin.query(
      'DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)',
    );
    await admin.destroy();
  }
});

function worker(
  pendingReader: PendingReferenceReader = reader,
  useCase: Pick<ReprocessPendingReferenceUseCase, 'execute'> = reprocess,
): PendingReferenceWorker {
  const instance = new PendingReferenceWorker(
    pendingReader,
    useCase,
    options,
    new MessagingDiagnostics(() => {}),
    runtime.now,
  );
  workers.push(instance);
  return instance;
}

async function fixture() {
  const wallet = await new OpenWalletUseCase(transaction, runtime).execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const bet: ProcessWagerInput = {
    providerId: 'provider',
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
  };
  const refund = await processor.execute({
    ...bet,
    kind: Kind.Refund,
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  expect(refund.status).toBe(Status.PendingReference);
  return { wallet, bet, refund };
}

async function state(id: string) {
  return transaction.run(async (context) => {
    const stored = await context.transactions.findById(id);
    if (!stored) {
      throw new Error('Missing test transaction');
    }

    return stored;
  });
}

async function accounting(
  walletId: string,
  expected: {
    balance: string;
    version: number;
    entries: number;
    events: number;
  },
): Promise<void> {
  const rows = await source.query<
    {
      balance: string;
      calculated: string;
      version: number;
      entries: number;
      events: number;
    }[]
  >(
    `SELECT w.balance, w.version,
      (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id=w.id) AS entries,
      (SELECT sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)::numeric(30,2)::text FROM wallet_ledger_entries WHERE wallet_id=w.id) AS calculated,
      (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id=w.id) AS events
     FROM wallets w WHERE id=$1`,
    [walletId],
  );

  expect(rows).toEqual([{ ...expected, calculated: expected.balance }]);
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error('Pending reference worker test deadline');
    }

    await Bun.sleep(5);
  }
}

test('automatic worker resolves REFUND after BET arrives and preserves accounting', async () => {
  const { wallet, bet, refund } = await fixture();
  const instance = worker();
  instance.start();
  expect((await state(refund.transactionId)).referenceAttempts).toBe(1);
  await accounting(wallet.id, {
    balance: '100.00',
    version: 1,
    entries: 1,
    events: 3,
  });

  await processor.execute(bet);
  instant = new Date(instant.getTime() + 1000);
  await until(
    async () =>
      (await state(refund.transactionId)).transaction.status ===
      Status.Processed,
  );
  await instance.stop();

  await accounting(wallet.id, {
    balance: '100.00',
    version: 3,
    entries: 3,
    events: 7,
  });
  const events = await source.query<{ correlation: string }[]>(
    `SELECT payload->>'correlationId' AS correlation FROM outbox_messages WHERE payload->'data'->>'transactionId'=$1 AND event_type='WagerTransactionProcessed'`,
    [refund.transactionId],
  );
  expect(events).toEqual([{ correlation: refund.transactionId }]);
});

test('missing reference advances one durable attempt and respects nextAttemptAt', async () => {
  const { wallet, refund } = await fixture();
  const instance = worker();
  expect(await instance.processBatch()).toBe(0);
  instant = new Date(instant.getTime() + 1000);

  expect(await instance.processBatch()).toBe(1);

  const stored = await state(refund.transactionId);
  expect(stored.referenceAttempts).toBe(2);
  expect(stored.nextAttemptAt).toEqual(new Date(instant.getTime() + 2000));
  expect(await instance.processBatch()).toBe(0);
  await accounting(wallet.id, {
    balance: '100.00',
    version: 1,
    entries: 1,
    events: 3,
  });
});

test('five total attempts reject the reference once without financial movement', async () => {
  const { wallet, refund } = await fixture();
  const instance = worker();
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    const before = await state(refund.transactionId);
    expect(before.nextAttemptAt).toBeDefined();
    if (!before.nextAttemptAt) {
      throw new Error('Missing persisted retry schedule');
    }

    instant = before.nextAttemptAt;
    expect(await instance.processBatch()).toBe(1);
    expect((await state(refund.transactionId)).referenceAttempts).toBe(attempt);
  }

  const stored = await state(refund.transactionId);
  expect(stored.transaction.status).toBe(Status.Rejected);
  expect(stored.transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
  expect(stored.nextAttemptAt).toBeUndefined();
  expect(await instance.processBatch()).toBe(0);
  await accounting(wallet.id, {
    balance: '100.00',
    version: 1,
    entries: 1,
    events: 4,
  });
});

test('TTL selects expired references even when their next attempt is in the future', async () => {
  const { wallet, refund } = await fixture();
  instant = new Date(instant.getTime() + 86400000);
  await source.query(
    'UPDATE wager_transactions SET next_attempt_at=$2 WHERE id=$1',
    [refund.transactionId, new Date(instant.getTime() + 3600000)],
  );

  expect(await worker().processBatch()).toBe(1);

  const stored = await state(refund.transactionId);
  expect(stored.transaction.status).toBe(Status.Rejected);
  expect(stored.transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
  expect(stored.referenceAttempts).toBe(1);
  await accounting(wallet.id, {
    balance: '100.00',
    version: 1,
    entries: 1,
    events: 4,
  });
});

for (const referencePresent of [false, true]) {
  test(
    'two workers revalidate the same scheduled reference under wallet lock, reference present ' +
      referencePresent,
    async () => {
      const { wallet, bet, refund } = await fixture();
      if (referencePresent) {
        await processor.execute(bet);
      }

      instant = new Date(instant.getTime() + 1000);
      const selected = Promise.withResolvers<void>();
      let selections = 0;
      const synchronized: PendingReferenceReader = {
        findDue: async (...args) => {
          const candidates = await reader.findDue(...args);
          expect(candidates.map((item) => item.transactionId)).toContain(
            refund.transactionId,
          );
          selections += 1;
          if (selections === 2) {
            selected.resolve();
          }

          await selected.promise;
          return candidates;
        },
      };

      const outcomes = await Promise.all([
        worker(synchronized).processBatch(),
        worker(synchronized).processBatch(),
      ]);

      expect(outcomes.reduce((sum, value) => sum + value, 0)).toBe(1);
      const stored = await state(refund.transactionId);
      expect(stored.referenceAttempts).toBe(referencePresent ? 1 : 2);
      expect(stored.transaction.status).toBe(
        referencePresent ? Status.Processed : Status.PendingReference,
      );
      await accounting(
        wallet.id,
        referencePresent
          ? { balance: '100.00', version: 3, entries: 3, events: 7 }
          : { balance: '100.00', version: 1, entries: 1, events: 3 },
      );
    },
  );
}

test('new worker recovers persisted scheduling after the previous worker stops', async () => {
  const { wallet, bet, refund } = await fixture();
  const previous = worker();
  previous.start();
  await previous.stop();
  await processor.execute(bet);
  instant = new Date(instant.getTime() + 1000);
  const restarted = worker();

  restarted.start();
  await until(
    async () =>
      (await state(refund.transactionId)).transaction.status ===
      Status.Processed,
  );
  await restarted.stop();

  expect((await state(refund.transactionId)).referenceAttempts).toBe(1);
  await accounting(wallet.id, {
    balance: '100.00',
    version: 3,
    entries: 3,
    events: 7,
  });
});

test('transient failure after outbox insertion rolls back and the next cycle recovers', async () => {
  const { wallet, bet, refund } = await fixture();
  await processor.execute(bet);
  instant = new Date(instant.getTime() + 1000);
  let fail = true;
  const failing: FinancialTransaction = {
    run: (work) =>
      transaction.run((context) =>
        work({
          ...context,
          outbox: {
            ...context.outbox,
            lockDue: (now, limit) => context.outbox.lockDue(now, limit),
            insert: async (message) => {
              await context.outbox.insert(message);
              if (fail) {
                throw new FinancialApplicationError('TRANSIENT_FAILURE');
              }
            },
          },
        }),
      ),
  };
  const instance = worker(
    reader,
    new ReprocessPendingReferenceUseCase(
      new ProcessWagerTransactionUseCase(failing, runtime),
    ),
  );
  const before = await state(refund.transactionId);

  expect(await instance.processBatch()).toBe(0);

  expect(await state(refund.transactionId)).toEqual(before);
  await accounting(wallet.id, {
    balance: '75.00',
    version: 2,
    entries: 2,
    events: 5,
  });
  fail = false;
  expect(await instance.processBatch()).toBe(1);
  await accounting(wallet.id, {
    balance: '100.00',
    version: 3,
    entries: 3,
    events: 7,
  });
});

test('cancelled financial write rolls back before another worker recovers', async () => {
  const { wallet, bet, refund } = await fixture();
  await processor.execute(bet);
  instant = new Date(instant.getTime() + 1000);
  const abort = new AbortController();
  const interrupted: FinancialTransaction = {
    run: (work) =>
      transaction.run((context) =>
        work({
          ...context,
          wallets: {
            ...context.wallets,
            insert: (value) => context.wallets.insert(value),
            findById: (id) => context.wallets.findById(id),
            findByPlayerCurrency: (player, currency) =>
              context.wallets.findByPlayerCurrency(player, currency),
            findByIdForUpdate: (id) => context.wallets.findByIdForUpdate(id),
            update: async (value) => {
              await context.wallets.update(value);
              abort.abort();
            },
          },
        }),
      ),
  };
  const instance = worker(
    reader,
    new ReprocessPendingReferenceUseCase(
      new ProcessWagerTransactionUseCase(interrupted, runtime),
    ),
  );

  const failure = await instance.processBatch(abort.signal).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(DOMException);

  expect((await state(refund.transactionId)).referenceAttempts).toBe(1);
  expect((await state(refund.transactionId)).transaction.status).toBe(
    Status.PendingReference,
  );
  await accounting(wallet.id, {
    balance: '75.00',
    version: 2,
    entries: 2,
    events: 5,
  });
  expect(await worker().processBatch()).toBe(1);
  await accounting(wallet.id, {
    balance: '100.00',
    version: 3,
    entries: 3,
    events: 7,
  });
});

test('reader bounds selection and excludes terminal and future scheduled transactions', async () => {
  const first = await fixture();
  const second = await fixture();
  expect(
    await reader.findDue(instant, new Date(instant.getTime() - 86400000), 20),
  ).toEqual([]);
  instant = new Date(instant.getTime() + 1000);

  const candidates = await reader.findDue(
    instant,
    new Date(instant.getTime() - 86400000),
    1,
  );

  expect(candidates).toHaveLength(1);
  expect([first.refund.transactionId, second.refund.transactionId]).toContain(
    candidates[0]?.transactionId,
  );
  expect(candidates[0]?.referenceAttempts).toBe(1);
});

test('Nest lifecycle explicitly enables the pending reference worker and drains before DataSource closes', async () => {
  const nestedSource = new DataSource({ ...databaseOptions(), database });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { wallet, bet, refund } = await fixture();
  await processor.execute(bet);
  instant = new Date(instant.getTime() + 1000);
  const nestedWorker = worker(new TypeOrmPendingReferenceReader(nestedSource), {
    execute: async (...args) => {
      entered.resolve();
      await release.promise;
      return new ReprocessPendingReferenceUseCase(
        new ProcessWagerTransactionUseCase(
          new TypeOrmFinancialTransaction(nestedSource),
          runtime,
        ),
      ).execute(...args);
    },
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DataSource)
    .useValue(nestedSource)
    .overrideProvider(PendingReferenceWorker)
    .useValue(nestedWorker)
    .overrideProvider(MessagingDiagnostics)
    .useValue(new MessagingDiagnostics(() => {}))
    .overrideProvider(MessagingLifecycle)
    .useFactory({
      inject: [WagerTransactionConsumer, OutboxPublisher],
      factory: (
        consumer: WagerTransactionConsumer,
        publisher: OutboxPublisher,
      ) =>
        new MessagingLifecycle(
          consumer,
          publisher,
          {
            ...options,
            consumerEnabled: false,
            publisherEnabled: false,
            pendingReferenceEnabled: true,
          },
          nestedWorker,
        ),
    })
    .compile();
  let close: Promise<void> | undefined;
  try {
    await module.init();
    await entered.promise;
    close = module.close();
    await Promise.resolve();
    expect(nestedSource.isInitialized).toBe(true);
    release.resolve();
    await close;

    expect(nestedSource.isInitialized).toBe(false);
    expect((await state(refund.transactionId)).transaction.status).toBe(
      Status.Processed,
    );
    await accounting(wallet.id, {
      balance: '100.00',
      version: 3,
      entries: 3,
      events: 7,
    });
  } finally {
    release.resolve();
    await (close ?? module.close());
  }
});

test('HTTP test composition prevents automatic pending worker startup with its flag enabled', async () => {
  const previous = process.env.PENDING_REFERENCE_WORKER_ENABLED;
  process.env.PENDING_REFERENCE_WORKER_ENABLED = 'true';
  let starts = 0;
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DataSource)
    .useValue(new DataSource({ ...databaseOptions(), database }))
    .overrideProvider(PendingReferenceWorker)
    .useValue({
      start: () => {
        starts += 1;
      },
      stop: async () => {},
    })
    .compile();
  try {
    await module.init();

    expect(starts).toBe(0);
  } finally {
    await module.close();
    if (previous === undefined) {
      delete process.env.PENDING_REFERENCE_WORKER_ENABLED;
    } else {
      process.env.PENDING_REFERENCE_WORKER_ENABLED = previous;
    }
  }
});
