import { inboxPayloadHash } from '../../src/application/services/inbox-payload-hash.js';
import 'reflect-metadata';
import { beforeAll, afterAll, test, expect } from 'bun:test';
import { DataSource } from 'typeorm';
import { databaseOptions } from '../../src/infrastructure/database/options.js';
import { FinancialFoundation1797000000000 } from '../../src/infrastructure/database/migrations/1797000000000-financial-foundation.js';
import { RejectedSnapshots1797000001000 } from '../../src/infrastructure/database/migrations/1797000001000-rejected-snapshots.js';
import { TypeOrmFinancialTransaction } from '../../src/infrastructure/database/repositories/typeorm-financial-transaction.js';
import { OpenWalletUseCase } from '../../src/application/use-cases/open-wallet.use-case.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerInput,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import { ReprocessPendingReferenceUseCase } from '../../src/application/use-cases/reprocess-pending-reference.use-case.js';
import type { FinancialRuntime } from '../../src/application/ports/financial-runtime.js';
import type { FinancialTransaction } from '../../src/application/ports/financial-transaction.js';
import { Money } from '../../src/domain/value-objects/money.js';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../../src/domain/financial.types.js';

const database = 'wager_core_' + crypto.randomUUID().replaceAll('-', '');
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
const opener = new OpenWalletUseCase(transaction);
const processor = new ProcessWagerTransactionUseCase(transaction);
const id = () => crypto.randomUUID();

beforeAll(async () => {
  await admin.initialize();
  await admin.query('CREATE DATABASE "' + database + '"');
  await source.initialize();
  expect(await source.runMigrations()).toHaveLength(2);
  await source.undoLastMigration();
  expect(await source.runMigrations()).toHaveLength(1);
}, 60000);

afterAll(async () => {
  if (source.isInitialized) {
    await source.destroy();
  }

  if (admin.isInitialized) {
    if (!/^wager_core_[a-f0-9]{32}$/.test(database)) {
      throw new Error('Unsafe test database');
    }
    await admin.query(
      'DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)',
    );
    await admin.destroy();
  }
});

async function wallet(amount = '100.00') {
  return opener.execute({
    playerId: id(),
    initialBalance: { amount, currency: 'BRL' },
  });
}

function payload(
  w: { id: string; playerId: string },
  kind = Kind.Bet,
  amount = '10.00',
): ProcessWagerInput {
  return {
    walletId: w.id,
    playerId: w.playerId,
    providerId: 'provider',
    externalTransactionId: id(),
    idempotencyKey: id(),
    roundId: 'round',
    gameId: 'game',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

async function reconcile(walletId: string): Promise<void> {
  await transaction.run(async (context) => {
    const w = await context.wallets.findById(walletId);
    if (!w) {
      throw new Error('Missing wallet');
    }
    const ledger = await context.ledger.findByWallet(walletId, 1000);
    let calculated = Money.zero(w.currency);
    for (const entry of ledger) {
      calculated =
        entry.direction === 'CREDIT'
          ? calculated.add(entry.money)
          : calculated.subtract(entry.money);
    }
    expect(w.balance.equals(calculated)).toBe(true);
  });
}

async function counts(walletId: string) {
  const [row] = await source.query<
    {
      transactions: string;
      ledger: string;
      events: string;
      version: number;
      balance: string;
    }[]
  >(
    `
    SELECT w.version,w.balance,
      (SELECT count(*) FROM wager_transactions WHERE wallet_id=w.id) AS transactions,
      (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id=w.id) AS ledger,
      (SELECT count(*) FROM outbox_messages WHERE aggregate_id=w.id) AS events
    FROM wallets w WHERE w.id=$1`,
    [walletId],
  );
  if (!row) {
    throw new Error('Missing wallet');
  }
  return row;
}

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await work;
  } catch (error) {
    failure = error;
  }
  expect(failure).toHaveProperty('code', code);
}

test('opening creates processed OPENING, credit, snapshot, version one and two events', async () => {
  const w = await wallet();
  const state = await counts(w.id);
  expect(state).toEqual({
    version: 1,
    balance: '100.00',
    transactions: '1',
    ledger: '1',
    events: '2',
  });
  const [opening] = await source.query<
    {
      kind: string;
      status: string;
      result_balance: string;
      result_version: number;
    }[]
  >(
    'SELECT kind,status,result_balance,result_version FROM wager_transactions WHERE wallet_id=$1',
    [w.id],
  );
  expect(opening).toEqual({
    kind: 'OPENING',
    status: 'PROCESSED',
    result_balance: '100.00',
    result_version: 1,
  });

  await reconcile(w.id);
});

test('zero opening creates only wallet and concurrent duplicate opening is a conflict', async () => {
  const playerId = id();
  const input = {
    playerId,
    initialBalance: { amount: '0.00', currency: 'BRL' },
  };
  const result = await Promise.allSettled([
    opener.execute(input),
    opener.execute(input),
  ]);
  const success = result.find((item) => item.status === 'fulfilled');
  expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(result.find((item) => item.status === 'rejected')).toHaveProperty(
    'reason.code',
    'WALLET_CONFLICT',
  );
  if (!success || success.status !== 'fulfilled') {
    throw new Error('Missing wallet');
  }
  expect(await counts(success.value.id)).toEqual({
    balance: '0.00',
    version: 1,
    transactions: '0',
    ledger: '0',
    events: '0',
  });

  await reconcile(success.value.id);
});

test('BET WIN LOSS REFUND and ROLLBACK preserve snapshots, versions, events and reconciliation', async () => {
  const w = await wallet();
  const bet = payload(w);
  const betResult = await processor.execute(bet);
  expect(betResult.balance?.amount).toBe('90.00');
  await reconcile(w.id);

  const win = payload(w, Kind.Win, '20.00');
  const winResult = await processor.execute(win);
  expect(winResult.balance?.amount).toBe('110.00');
  await reconcile(w.id);

  const loss = await processor.execute(payload(w, Kind.Loss, '0.00'));
  expect(loss.balance?.amount).toBe('110.00');
  expect(loss.walletVersion).toBe(3);
  await reconcile(w.id);

  const refund = await processor.execute({
    ...payload(w, Kind.Refund),
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  expect(refund.balance?.amount).toBe('120.00');
  await reconcile(w.id);

  const rollback = await processor.execute({
    ...payload(w, Kind.Rollback, '20.00'),
    referenceExternalTransactionId: win.externalTransactionId,
  });
  expect(rollback.balance?.amount).toBe('100.00');
  expect(rollback.walletVersion).toBe(5);
  expect(await counts(w.id)).toEqual({
    balance: '100.00',
    version: 5,
    transactions: '6',
    ledger: '5',
    events: '11',
  });
  const events = await source.query<{ payload: Record<string, unknown> }[]>(
    'SELECT payload FROM outbox_messages WHERE aggregate_id=$1',
    [w.id],
  );
  expect(
    events.every(
      (event) =>
        event.payload.version === 1 &&
        typeof event.payload.eventType === 'string',
    ),
  ).toBe(true);

  await reconcile(w.id);
});

test('sequential replay preserves original balance and creates no events or ledger', async () => {
  const w = await wallet();
  const a = payload(w, Kind.Bet, '20.00');
  const original = await processor.execute(a);
  await processor.execute(payload(w, Kind.Bet, '30.00'));
  const before = await counts(w.id);

  const replay = await processor.execute(a);

  expect(replay).toEqual({ ...original, idempotentReplay: true });
  expect(replay.balance?.amount).toBe('80.00');
  expect(await counts(w.id)).toEqual(before);
  expect(before.balance).toBe('50.00');
  await expectCode(
    processor.execute({ ...a, money: { amount: '21.00', currency: 'BRL' } }),
    'IDEMPOTENCY_CONFLICT',
  );
  await expectCode(
    processor.execute({ ...a, idempotencyKey: id() }),
    'EXTERNAL_IDENTITY_CONFLICT',
  );
  await reconcile(w.id);
});

test('50 concurrent duplicates commit one financial effect', async () => {
  const w = await wallet();
  const input = payload(w);
  const results = await Promise.all(
    Array.from({ length: 50 }, () => processor.execute(input)),
  );

  expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
  expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
  expect(await counts(w.id)).toEqual({
    balance: '90.00',
    version: 2,
    transactions: '2',
    ledger: '2',
    events: '4',
  });
  await reconcile(w.id);
}, 30000);

test('two concurrent bets of 80 on balance 100 approve exactly one', async () => {
  const w = await wallet();
  const results = await Promise.all([
    processor.execute(payload(w, Kind.Bet, '80.00')),
    processor.execute(payload(w, Kind.Bet, '80.00')),
  ]);

  expect(
    results.filter((result) => result.status === Status.Processed),
  ).toHaveLength(1);
  expect(
    results.find((result) => result.status === Status.Rejected)?.failureCode,
  ).toBe(FailureCode.InsufficientFunds);
  expect(await counts(w.id)).toEqual({
    balance: '20.00',
    version: 2,
    transactions: '3',
    ledger: '2',
    events: '5',
  });
  await reconcile(w.id);
});

test('wallets remain independent while a different wallet is locked', async () => {
  const a = await wallet();
  const b = await wallet();
  const lock = source.createQueryRunner();
  let waiting: ReturnType<typeof processor.execute> | undefined;
  try {
    await lock.connect();
    await lock.startTransaction();
    await lock.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [a.id]);
    waiting = processor.execute(payload(a));

    const other = await processor.execute(payload(b));
    expect(other.status).toBe(Status.Processed);
    const [blocked] = await source.query<{ count: string }[]>(
      "SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
      [database],
    );
    expect(blocked?.count).toBe('1');

    await lock.commitTransaction();
    expect((await waiting).status).toBe(Status.Processed);
  } finally {
    if (lock.isTransactionActive) {
      await lock.rollbackTransaction();
    }
    if (waiting) {
      await waiting.catch(() => undefined);
    }
    await lock.release();
  }
  await reconcile(a.id);
  await reconcile(b.id);
}, 15000);

test('concurrent reversals commit one credit and audit the other rejection', async () => {
  const w = await wallet();
  const bet = payload(w);
  await processor.execute(bet);
  const results = await Promise.all(
    [1, 2].map(() =>
      processor.execute({
        ...payload(w, Kind.Refund),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    ),
  );

  expect(
    results.filter((result) => result.status === Status.Processed),
  ).toHaveLength(1);
  expect(
    results.filter((result) => result.status === Status.Rejected),
  ).toHaveLength(1);
  expect((await counts(w.id)).balance).toBe('100.00');
  await reconcile(w.id);
});

for (const kind of [Kind.Refund, Kind.Rollback, Kind.Win]) {
  test(
    kind +
      ' before BET can be reprocessed once without duplicating pending events',
    async () => {
      let now = new Date('2026-01-01T00:00:00Z');
      const runtime: FinancialRuntime = { now: () => new Date(now), id };
      const process = new ProcessWagerTransactionUseCase(transaction, runtime);
      const reprocess = new ReprocessPendingReferenceUseCase(process);
      const w = await wallet();
      const bet = payload(w);
      const input = {
        ...payload(w, kind),
        referenceExternalTransactionId: bet.externalTransactionId,
      };
      const pending = await process.execute(input);
      const count = await counts(w.id);
      expect(pending.status).toBe(Status.PendingReference);
      await process.execute(input);
      expect(await counts(w.id)).toEqual(count);

      await process.execute(bet);
      now = new Date(now.getTime() + 1000);
      const results = await Promise.all([
        reprocess.execute(pending.transactionId),
        reprocess.execute(pending.transactionId),
      ]);
      expect(
        results.every((result) => result.status === Status.Processed),
      ).toBe(true);
      expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
        1,
      );
      expect((await counts(w.id)).balance).toBe('100.00');
      await reconcile(w.id);
    },
  );
}

test('inbox deduplication, conflict and HTTP-to-message replay are atomic', async () => {
  const w = await wallet();
  const input = payload(w);
  await processor.execute(input);
  const before = await counts(w.id);
  const message = {
    ...input,
    inbox: { consumerName: 'consumer', messageId: id() },
  };

  expect((await processor.execute(message)).canAcknowledge).toBe(true);
  expect((await processor.execute(message)).idempotentReplay).toBe(true);
  expect(await counts(w.id)).toEqual(before);
  const rows = await source.query(
    'SELECT message_id FROM inbox_messages WHERE message_id=$1',
    [message.inbox.messageId],
  );
  expect(rows).toHaveLength(1);
  await expectCode(
    processor.execute({
      ...message,
      money: { amount: '20.00', currency: 'BRL' },
    }),
    'INBOX_CONFLICT',
  );
  await reconcile(w.id);
});

function failAfter<T extends unknown[]>(
  operation: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
  return async (...args) => {
    await operation(...args);
    throw new Error('controlled persistence failure');
  };
}

for (const point of [
  'transaction',
  'wallet',
  'ledger',
  'inbox',
  'outbox',
] as const) {
  test(
    'failure after ' +
      point +
      ' rolls back every component and allows a safe retry',
    async () => {
      const w = await wallet();
      const before = await counts(w.id);
      const faulty: FinancialTransaction = {
        run: (work) =>
          transaction.run((context) => {
            if (point === 'transaction') {
              context.transactions.insert = failAfter(
                context.transactions.insert.bind(context.transactions),
              );
            }
            if (point === 'wallet') {
              context.wallets.update = failAfter(
                context.wallets.update.bind(context.wallets),
              );
            }
            if (point === 'ledger') {
              context.ledger.insert = failAfter(
                context.ledger.insert.bind(context.ledger),
              );
            }
            if (point === 'inbox') {
              context.inbox.insert = failAfter(
                context.inbox.insert.bind(context.inbox),
              );
            }
            if (point === 'outbox') {
              context.outbox.insert = failAfter(
                context.outbox.insert.bind(context.outbox),
              );
            }
            return work(context);
          }),
      };
      const input = {
        ...payload(w),
        inbox: { consumerName: 'consumer', messageId: id() },
      };
      let failure: unknown;
      try {
        await new ProcessWagerTransactionUseCase(faulty).execute(input);
      } catch (error) {
        failure = error;
      }

      expect(failure).toHaveProperty(
        'message',
        'controlled persistence failure',
      );
      expect(await counts(w.id)).toEqual(before);
      expect(
        await source.query(
          'SELECT message_id FROM inbox_messages WHERE message_id=$1',
          [input.inbox.messageId],
        ),
      ).toHaveLength(0);

      expect((await processor.execute(input)).status).toBe(Status.Processed);
      expect((await counts(w.id)).balance).toBe('90.00');
      await reconcile(w.id);
    },
  );
}

test('rejected replay returns its original balance after later credit', async () => {
  const w = await wallet('10.00');
  const input = payload(w, Kind.Bet, '20.00');
  const rejected = await processor.execute(input);
  expect(rejected.status).toBe(Status.Rejected);
  await processor.execute(payload(w, Kind.Win, '100.00'));

  const replay = await processor.execute(input);
  expect(replay.balance?.amount).toBe('10.00');
  expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
  expect(replay.idempotentReplay).toBe(true);
  expect((await counts(w.id)).balance).toBe('110.00');
  await reconcile(w.id);
});

test('reference expiry persists a terminal rejection snapshot and one rejected event', async () => {
  let now = new Date('2026-01-01T00:00:00Z');
  const process = new ProcessWagerTransactionUseCase(
    transaction,
    { now: () => new Date(now), id },
    { maxAttempts: 2, ttlMs: 10000, baseDelayMs: 10, maxDelayMs: 10 },
  );
  const w = await wallet();
  const pending = await process.execute({
    ...payload(w, Kind.Refund),
    referenceExternalTransactionId: 'missing',
  });
  now = new Date(now.getTime() + 10);

  const rejected = await process.reprocess(pending.transactionId);
  expect(rejected.status).toBe(Status.Rejected);
  expect(rejected.failureCode).toBe(FailureCode.ReferenceNotFound);
  expect(rejected.balance?.amount).toBe('100.00');
  const before = await counts(w.id);
  expect(
    (await process.reprocess(pending.transactionId)).idempotentReplay,
  ).toBe(true);
  expect(await counts(w.id)).toEqual(before);
  await reconcile(w.id);
});

test('partial reversal and insolvent reversal are audited without ledger changes', async () => {
  const w = await wallet('0.00');
  const win = payload(w, Kind.Win, '10.00');
  await processor.execute(win);
  const partial = await processor.execute({
    ...payload(w, Kind.Rollback, '5.00'),
    referenceExternalTransactionId: win.externalTransactionId,
  });
  expect(partial.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
  await processor.execute(payload(w, Kind.Bet, '10.00'));
  const result = await processor.execute({
    ...payload(w, Kind.Rollback, '10.00'),
    referenceExternalTransactionId: win.externalTransactionId,
  });
  expect(result.failureCode).toBe(FailureCode.InsufficientReversalFunds);
  expect((await counts(w.id)).balance).toBe('0.00');
  await reconcile(w.id);
});
test('transient failure after a financial write retries with fresh domain state', async () => {
  const w = await wallet();
  let failed = false;
  const flaky: FinancialTransaction = {
    run: (work) =>
      transaction.run((context) => {
        const insert = context.ledger.insert.bind(context.ledger);
        context.ledger.insert = async (entry) => {
          await insert(entry);
          if (!failed) {
            failed = true;
            const { PersistenceError } =
              await import('../../src/application/ports/persistence.error.js');
            throw new PersistenceError('transient');
          }
        };
        return work(context);
      }),
  };

  const result = await new ProcessWagerTransactionUseCase(flaky).execute(
    payload(w),
  );

  expect(result.status).toBe(Status.Processed);
  expect(await counts(w.id)).toEqual({
    balance: '90.00',
    version: 2,
    transactions: '2',
    ledger: '2',
    events: '4',
  });
  await reconcile(w.id);
});
test('global idempotency conflict across wallets rolls back the losing SQL transaction', async () => {
  const a = await wallet();
  const b = await wallet();
  let arrivals = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const synchronized: FinancialTransaction = {
    run: (work) =>
      transaction.run((context) => {
        const insert = context.transactions.insert.bind(context.transactions);
        context.transactions.insert = async (...args) => {
          arrivals += 1;
          if (arrivals === 2) {
            release();
          }
          await gate;
          await insert(...args);
        };
        return work(context);
      }),
  };
  const process = new ProcessWagerTransactionUseCase(synchronized);
  const key = id();
  const results = await Promise.allSettled([
    process.execute({ ...payload(a), idempotencyKey: key }),
    process.execute({ ...payload(b), idempotencyKey: key }),
  ]);

  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')).toHaveProperty(
    'reason.code',
    'IDEMPOTENCY_CONFLICT',
  );
  const balances = [
    (await counts(a.id)).balance,
    (await counts(b.id)).balance,
  ].sort();
  expect(balances).toEqual(['100.00', '90.00']);
  await reconcile(a.id);
  await reconcile(b.id);
}, 15000);

test('inbox conflict across wallets rolls back every losing financial effect', async () => {
  const a = await wallet();
  const b = await wallet();
  let arrivals = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const synchronized: FinancialTransaction = {
    run: (work) =>
      transaction.run((context) => {
        const insert = context.inbox.insert.bind(context.inbox);
        context.inbox.insert = async (message) => {
          arrivals += 1;
          if (arrivals === 2) {
            release();
          }
          await gate;
          await insert(message);
        };
        return work(context);
      }),
  };
  const process = new ProcessWagerTransactionUseCase(synchronized);
  const inbox = { consumerName: 'consumer', messageId: id() };
  const results = await Promise.allSettled([
    process.execute({ ...payload(a), inbox }),
    process.execute({ ...payload(b), inbox }),
  ]);

  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')).toHaveProperty(
    'reason.code',
    'INBOX_CONFLICT',
  );
  expect(
    [(await counts(a.id)).balance, (await counts(b.id)).balance].sort(),
  ).toEqual(['100.00', '90.00']);
  await reconcile(a.id);
  await reconcile(b.id);
}, 15000);
test('an existing matching inbox receipt is completed in the financial transaction', async () => {
  const w = await wallet();
  const input = {
    ...payload(w),
    inbox: { consumerName: 'consumer', messageId: id() },
  };
  await source.query(
    'INSERT INTO inbox_messages(consumer_name,message_id,payload_hash,received_at) VALUES($1,$2,$3,$4)',
    [
      input.inbox.consumerName,
      input.inbox.messageId,
      inboxPayloadHash(input),
      new Date(),
    ],
  );

  const result = await processor.execute(input);

  expect(result.canAcknowledge).toBe(true);
  const [record] = await source.query<{ processed_at: Date }[]>(
    'SELECT processed_at FROM inbox_messages WHERE message_id=$1',
    [input.inbox.messageId],
  );
  expect(record?.processed_at).toBeInstanceOf(Date);
  expect((await processor.execute(input)).idempotentReplay).toBe(true);
  await reconcile(w.id);
});

test('opening outbox failure rolls back wallet, opening, ledger and events', async () => {
  const playerId = id();
  const before = await source.query<{ table_name: string; total: string }[]>(
    "SELECT 'wallets' AS table_name,count(*) AS total FROM wallets UNION ALL SELECT 'transactions',count(*) FROM wager_transactions UNION ALL SELECT 'ledger',count(*) FROM wallet_ledger_entries UNION ALL SELECT 'outbox',count(*) FROM outbox_messages ORDER BY table_name",
  );
  const faulty: FinancialTransaction = {
    run: (work) =>
      transaction.run((context) => {
        context.outbox.insert = failAfter(
          context.outbox.insert.bind(context.outbox),
        );
        return work(context);
      }),
  };
  let failure: unknown;
  try {
    await new OpenWalletUseCase(faulty).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toHaveProperty('message', 'controlled persistence failure');
  expect(
    await source.query(
      "SELECT 'wallets' AS table_name,count(*) AS total FROM wallets UNION ALL SELECT 'transactions',count(*) FROM wager_transactions UNION ALL SELECT 'ledger',count(*) FROM wallet_ledger_entries UNION ALL SELECT 'outbox',count(*) FROM outbox_messages ORDER BY table_name",
    ),
  ).toEqual(before);
  const opened = await opener.execute({
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  await reconcile(opened.id);
});

for (const staleRead of [false, true]) {
  test(
    'inbox final read rejects a divergent concurrent commit, stale snapshot=' +
      staleRead,
    async () => {
      const a = await wallet();
      const b = await wallet();
      const inbox = { consumerName: 'race-consumer', messageId: id() };
      const winner = { ...payload(a), inbox };
      const loser = { ...payload(b), inbox };
      const before = await counts(b.id);
      let reads = 0;
      let winnerResult:
        Awaited<ReturnType<typeof processor.execute>> | undefined;
      const coordinated: FinancialTransaction = {
        run: (work) =>
          transaction.run((context) => {
            const find = context.inbox.find.bind(context.inbox);
            context.inbox.find = async (...args) => {
              reads += 1;
              if (reads === 2) {
                const snapshot = await find(...args);
                expect(snapshot).toBeUndefined();
                winnerResult = await processor.execute(winner);
                return staleRead ? snapshot : find(...args);
              }
              return find(...args);
            };
            return work(context);
          }),
      };

      await expectCode(
        new ProcessWagerTransactionUseCase(coordinated).execute(loser),
        'INBOX_CONFLICT',
      );

      expect(winnerResult?.canAcknowledge).toBe(true);
      expect(await counts(b.id)).toEqual(before);
      expect((await counts(a.id)).balance).toBe('90.00');
      const rows = await source.query<
        { payload_hash: string; processed_at: Date }[]
      >(
        'SELECT payload_hash,processed_at FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2',
        [inbox.consumerName, inbox.messageId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload_hash).toBe(inboxPayloadHash(winner));
      expect(rows[0]?.processed_at).toBeInstanceOf(Date);
      await reconcile(a.id);
      await reconcile(b.id);
    },
    15000,
  );
}

test('inbox distinguishes idempotency keys after an HTTP replay and preserves its receipt', async () => {
  const w = await wallet();
  const input = payload(w);
  await processor.execute(input);
  const before = await counts(w.id);
  const message = {
    ...input,
    inbox: { consumerName: 'consumer', messageId: id() },
  };
  const replay = await processor.execute(message);
  const receipt = await source.query(
    'SELECT * FROM inbox_messages WHERE message_id=$1',
    [message.inbox.messageId],
  );

  await expectCode(
    processor.execute({ ...message, idempotencyKey: id() }),
    'INBOX_CONFLICT',
  );

  expect(replay.idempotentReplay).toBe(true);
  expect(replay.canAcknowledge).toBe(true);
  expect(await counts(w.id)).toEqual(before);
  expect(
    await source.query('SELECT * FROM inbox_messages WHERE message_id=$1', [
      message.inbox.messageId,
    ]),
  ).toEqual(receipt);
  await reconcile(w.id);
});

for (const scenario of [
  'valid',
  'wallet',
  'player',
  'currency',
  'kind',
  'amount',
  'self',
  'rejected',
  'failed',
] as const) {
  test(
    'reference validation without financial movement: ' + scenario,
    async () => {
      const { WagerTransaction } =
        await import('../../src/domain/entities/wager-transaction.js');
      const w = await wallet();
      let referenceWallet = w;
      if (scenario === 'wallet') {
        referenceWallet = await opener.execute({
          playerId: w.playerId,
          initialBalance: { amount: '100.00', currency: 'USD' },
        });
      }
      if (scenario === 'player') {
        referenceWallet = await wallet();
      }
      if (scenario === 'currency') {
        referenceWallet = await opener.execute({
          playerId: w.playerId,
          initialBalance: { amount: '100.00', currency: 'USD' },
        });
      }
      const refInput = payload(
        referenceWallet,
        scenario === 'kind' ? Kind.Loss : Kind.Bet,
        scenario === 'amount' ? '11.00' : '10.00',
      );
      if (scenario === 'wallet') {
        // A second BRL wallet for the same player is forbidden by the schema.
        // This reference differs in wallet and currency while preserving player.
        refInput.money.currency = 'USD';
      }
      if (scenario === 'currency') {
        refInput.money.currency = 'USD';
      }
      const reference = WagerTransaction.create({
        ...refInput,
        id: id(),
        payloadHash: 'reference-hash',
        money: Money.from(refInput.money),
        createdAt: new Date(),
      });
      if (scenario === 'rejected') {
        reference.reject(FailureCode.InsufficientFunds);
      }
      if (scenario === 'failed') {
        reference.fail(FailureCode.PermanentInfrastructureFailure);
      }
      if (scenario !== 'self') {
        await transaction.run((context) =>
          context.transactions.insert(reference),
        );
      }
      const input = payload(w, Kind.Refund);
      input.referenceExternalTransactionId =
        scenario === 'self'
          ? input.externalTransactionId
          : reference.externalTransactionId;
      const before = await counts(w.id);

      const result = await processor.execute(input);

      const expected =
        scenario === 'valid'
          ? undefined
          : ['wallet', 'player', 'currency'].includes(scenario)
            ? FailureCode.ReferenceContextMismatch
            : scenario === 'kind'
              ? FailureCode.InvalidReferenceKind
              : scenario === 'amount'
                ? FailureCode.ReferenceAmountMismatch
                : FailureCode.InvalidReference;
      expect(result.status).toBe(
        scenario === 'valid' ? Status.PendingReference : Status.Rejected,
      );
      expect(result.failureCode).toBe(expected);
      const after = await counts(w.id);
      expect(after.balance).toBe(before.balance);
      expect(after.version).toBe(before.version);
      expect(after.ledger).toBe(before.ledger);
      await reconcile(w.id);
      if (referenceWallet.id !== w.id) {
        await reconcile(referenceWallet.id);
      }
    },
  );
}

test('structurally valid pending WIN reference later processes and permits one rollback', async () => {
  const w = await wallet();
  const bet = payload(w);
  const win = {
    ...payload(w, Kind.Win, '20.00'),
    referenceExternalTransactionId: bet.externalTransactionId,
  };
  let now = new Date();
  const runtime = { now: () => new Date(now), id };
  const process = new ProcessWagerTransactionUseCase(transaction, runtime);
  const pendingWin = await process.execute(win);
  const reversal = {
    ...payload(w, Kind.Rollback, '20.00'),
    referenceExternalTransactionId: win.externalTransactionId,
  };
  const pendingRollback = await process.execute(reversal);

  expect(pendingWin.status).toBe(Status.PendingReference);
  expect(pendingRollback.status).toBe(Status.PendingReference);
  expect((await counts(w.id)).balance).toBe('100.00');
  await reconcile(w.id);
  await process.execute(bet);
  now = new Date(now.getTime() + 1000);
  expect((await process.reprocess(pendingWin.transactionId)).status).toBe(
    Status.Processed,
  );
  expect((await process.reprocess(pendingRollback.transactionId)).status).toBe(
    Status.Processed,
  );
  const beforeReplay = await counts(w.id);
  expect(beforeReplay.balance).toBe('90.00');
  expect(
    (await process.reprocess(pendingRollback.transactionId)).idempotentReplay,
  ).toBe(true);
  expect(await counts(w.id)).toEqual(beforeReplay);
  await reconcile(w.id);
});

test('commit between idempotency and external identity reads returns the committed original result', async () => {
  const w = await wallet();
  const input = payload(w);
  let coordinated = false;
  let original: Awaited<ReturnType<typeof processor.execute>> | undefined;
  const racing: FinancialTransaction = {
    run: (work) =>
      transaction.run((context) => {
        const find = context.transactions.findByIdempotencyKey.bind(
          context.transactions,
        );
        context.transactions.findByIdempotencyKey = async (key) => {
          const snapshot = await find(key);
          if (!coordinated) {
            coordinated = true;
            expect(snapshot).toBeUndefined();
            original = await processor.execute(input);
          }
          return snapshot;
        };
        return work(context);
      }),
  };

  const result = await new ProcessWagerTransactionUseCase(racing).execute(
    input,
  );

  if (!original) {
    throw new Error('The winning transaction did not complete');
  }

  expect(result).toEqual({ ...original, idempotentReplay: true });
  expect(await counts(w.id)).toEqual({
    balance: '90.00',
    version: 2,
    transactions: '2',
    ledger: '2',
    events: '4',
  });
  await reconcile(w.id);
});
