import 'reflect-metadata';
import { beforeAll, afterAll, test, expect } from 'bun:test';
import { DataSource, QueryFailedError } from 'typeorm';
import { databaseOptions } from '../../src/infrastructure/database/options.js';
import { FinancialFoundation1797000000000 } from '../../src/infrastructure/database/migrations/1797000000000-financial-foundation.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { WagerTransaction } from '../../src/domain/entities/wager-transaction.js';
import { Money } from '../../src/domain/value-objects/money.js';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../../src/domain/financial.types.js';
import { TypeOrmFinancialTransaction } from '../../src/infrastructure/database/repositories/typeorm-financial-transaction.js';
import { TypeOrmWalletRepository } from '../../src/infrastructure/database/repositories/typeorm-wallet.repository.js';
import { WalletRowSchema } from '../../src/infrastructure/database/entities/wallet.schema.js';
import { WagerRowSchema } from '../../src/infrastructure/database/entities/wager-transaction.schema.js';
import { LedgerRowSchema } from '../../src/infrastructure/database/entities/wallet-ledger.schema.js';
import { InboxRowSchema } from '../../src/infrastructure/database/entities/inbox-message.schema.js';
import type { WagerRow } from '../../src/infrastructure/database/entities/wager-transaction.schema.js';
import type { WalletRow } from '../../src/infrastructure/database/entities/wallet.schema.js';
import type { LedgerRow } from '../../src/infrastructure/database/entities/wallet-ledger.schema.js';

const database = 'wager_test_' + crypto.randomUUID().replaceAll('-', '');

const admin = new DataSource({
  ...databaseOptions(),
  extra: { statement_timeout: 60000, query_timeout: 65000 },
});

const source = new DataSource({
  ...databaseOptions(),
  database,
  migrations: [FinancialFoundation1797000000000],
});

const unit = new TypeOrmFinancialTransaction(source);

const at = new Date('2026-01-01T00:00:00.000Z');

const money = (amount: string) => Money.from({ amount, currency: 'BRL' });

const id = () => crypto.randomUUID();

async function cli(command: string) {
  const child = Bun.spawn([process.execPath, 'run', command], {
    env: { ...process.env, POSTGRES_DB: database },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) {
    throw new Error(command + ' failed: ' + out + err);
  }
}

beforeAll(async () => {
  await admin.initialize();
  await admin.query('CREATE DATABASE "' + database + '"');
  await cli('migration:run');
  await source.initialize();

  expect(
    (
      await source.query<{ count: string }[]>(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages')",
      )
    )[0]?.count,
  ).toBe('5');

  await cli('migration:revert');
  await cli('migration:revert');

  expect(
    (
      await source.query<{ name: string | null }[]>(
        "SELECT to_regclass('wallets') AS name",
      )
    )[0]?.name,
  ).toBeNull();

  await cli('migration:run');
}, 180000);

afterAll(async () => {
  if (source.isInitialized) {
    await source.destroy();
  }

  if (admin.isInitialized) {
    if (!/^wager_test_[a-f0-9]{32}$/.test(database)) {
      throw new Error('Unsafe test database name');
    }

    await admin.query(
      'DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)',
    );
    await admin.destroy();
  }
});

async function wallet(overrides: Partial<WalletRow> = {}): Promise<WalletRow> {
  const row: WalletRow = {
    id: id(),
    player_id: id(),
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    created_at: at,
    updated_at: at,
    ...overrides,
  };

  await source.manager.insert(WalletRowSchema, row);

  return row;
}

async function wager(
  w: WalletRow,
  overrides: Partial<WagerRow> = {},
): Promise<WagerRow> {
  const key = id();
  const row: WagerRow = {
    id: key,
    provider_id: 'provider',
    external_transaction_id: key,
    idempotency_key: key,
    payload_hash: 'hash',
    wallet_id: w.id,
    player_id: w.player_id,
    round_id: 'round',
    game_id: 'game',
    kind: Kind.Bet,
    amount: '10.00',
    currency: w.currency,
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: Status.Processed,
    failure_code: null,
    created_at: at,
    processed_at: at,
    result_balance: '90.00',
    result_version: 2,
    reference_attempts: 0,
    next_attempt_at: null,
    ...overrides,
  };

  await source.manager.insert(WagerRowSchema, row);

  return row;
}

function entry(
  w: WalletRow,
  tx: WagerRow,
  overrides: Partial<LedgerRow> = {},
): LedgerRow {
  return {
    id: id(),
    wallet_id: w.id,
    transaction_id: tx.id,
    direction: 'DEBIT' as LedgerRow['direction'],
    amount: '10.00',
    currency: w.currency,
    balance_before: '100.00',
    balance_after: '90.00',
    created_at: at,
    ...overrides,
  };
}

async function expectFailure(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);

  if (failure instanceof Error) {
    expect(failure.message).toContain(message);
  }
}

async function rejected(
  operation: Promise<unknown>,
  code: string,
  constraint?: string,
) {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(QueryFailedError);

  if (!(failure instanceof QueryFailedError)) {
    throw new Error('Expected SQL failure');
  }

  const detail: unknown = failure.driverError;

  expect(detail).toHaveProperty('code', code);

  if (constraint) {
    expect(detail).toHaveProperty('constraint', constraint);
  }
}

test('migration creates named indexes and all ledger guards', async () => {
  const indexes = await source.query<{ indexname: string }[]>(
    "SELECT indexname FROM pg_indexes WHERE schemaname='public'",
  );

  expect(indexes.map((row) => row.indexname)).toContain(
    'uq_wager_processed_reversal',
  );
  expect(indexes.map((row) => row.indexname)).toContain('ix_outbox_pending');

  const triggers = await source.query<{ tgname: string }[]>(
    'SELECT tgname FROM pg_trigger WHERE NOT tgisinternal',
  );

  expect(triggers.map((row) => row.tgname)).toContain(
    'immutable_ledger_truncate',
  );
});

test('wallet uniqueness', async () => {
  const original = await wallet();

  await rejected(
    wallet({ ...original, id: id() }),
    '23505',
    'uq_wallet_player_currency',
  );
});

for (const balance of ['-0.01', 'NaN', 'Infinity', '-Infinity']) {
  test('SQL rejects wallet balance ' + balance, async () => {
    await rejected(
      wallet({ balance }),
      balance.includes('Infinity') ? '22003' : '23514',
    );
  });
}

test('SQL rejects wallet version and unsupported currency', async () => {
  await rejected(wallet({ version: 0 }), '23514', 'ck_wallet_version');
  await rejected(wallet({ currency: 'ZZZ' }), '23514', 'ck_wallet_currency');
});

test('transaction external identity and global idempotency key are unique', async () => {
  const w = await wallet();
  const original = await wager(w);

  await rejected(
    wager(w, { external_transaction_id: original.external_transaction_id }),
    '23505',
    'uq_wager_provider_external',
  );
  await rejected(
    wager(w, { idempotency_key: original.idempotency_key }),
    '23505',
    'uq_wager_idempotency',
  );
});

for (const amount of ['-0.01', '0.00', 'NaN', 'Infinity', '-Infinity']) {
  test('SQL rejects wager amount ' + amount, async () => {
    await rejected(
      wager(await wallet(), { amount }),
      amount.includes('Infinity') ? '22003' : '23514',
    );
  });
}

test('SQL checks statuses, reference requirement, snapshot, failure and wallet context', async () => {
  const w = await wallet();

  await rejected(wager(w, { status: 'INVALID' as Status }), '23514');
  await rejected(wager(w, { kind: Kind.Refund }), '23514');
  await rejected(wager(w, { result_balance: null }), '23514');
  await rejected(
    wager(w, {
      status: Status.Rejected,
      processed_at: null,
      result_balance: null,
      result_version: null,
    }),
    '23514',
  );
  await rejected(wager(w, { player_id: 'other' }), '23503', 'fk_wager_wallet');
  await rejected(
    wager(w, { wallet_id: 'missing' }),
    '23503',
    'fk_wager_wallet',
  );
  await rejected(
    wager(w, {
      reference_transaction_id: 'missing',
      status: Status.Pending,
      processed_at: null,
      result_balance: null,
      result_version: null,
    }),
    '23503',
    'fk_wager_reference',
  );
});

test('pending missing reference is stored for scheduled retry', async () => {
  const w = await wallet();
  const tx = await wager(w, {
    kind: Kind.Refund,
    reference_external_transaction_id: 'not-here',
    status: Status.PendingReference,
    processed_at: null,
    result_balance: null,
    result_version: null,
    reference_attempts: 3,
    next_attempt_at: at,
  });
  const loaded = await unit.run((ctx) => ctx.transactions.findById(tx.id));

  expect(loaded?.referenceAttempts).toBe(3);
  expect(loaded?.nextAttemptAt).toEqual(at);
});

test('processed reversals are unique per reference and kind, rejected attempts remain auditable', async () => {
  const w = await wallet();
  const ref = await wager(w);
  for (const kind of [Kind.Refund, Kind.Rollback]) {
    await wager(w, {
      kind,
      reference_external_transaction_id: ref.external_transaction_id,
      reference_transaction_id: ref.id,
    });
    await rejected(
      wager(w, {
        kind,
        reference_external_transaction_id: ref.external_transaction_id,
        reference_transaction_id: ref.id,
      }),
      '23505',
      'uq_wager_processed_reversal',
    );
    await wager(w, {
      kind,
      reference_external_transaction_id: ref.external_transaction_id,
      reference_transaction_id: ref.id,
      status: Status.Rejected,
      failure_code: FailureCode.InvalidReference,
      processed_at: null,
      result_balance: null,
      result_version: null,
    });
  }
});

test('SQL rejects reference context, status, kind and partial reversal', async () => {
  const w = await wallet();
  const ref = await wager(w);
  for (const changes of [
    { amount: '5.00' },
    { round_id: 'other' },
    { provider_id: 'other' },
    { reference_external_transaction_id: 'other' },
  ]) {
    await rejected(
      wager(w, {
        kind: Kind.Refund,
        reference_transaction_id: ref.id,
        reference_external_transaction_id: ref.external_transaction_id,
        ...changes,
      }),
      '23514',
      'ck_wager_reference_context',
    );
  }
  const pending = await wager(w, {
    status: Status.Pending,
    processed_at: null,
    result_balance: null,
    result_version: null,
  });

  await rejected(
    wager(w, {
      kind: Kind.Refund,
      reference_transaction_id: pending.id,
      reference_external_transaction_id: pending.external_transaction_id,
    }),
    '23514',
  );
});

test('ledger uniqueness, arithmetic and context are protected directly in SQL', async () => {
  const w = await wallet();
  const tx = await wager(w);

  await source.manager.insert(LedgerRowSchema, entry(w, tx));
  await rejected(
    source.manager.insert(LedgerRowSchema, entry(w, tx)),
    '23505',
    'uq_ledger_wallet_transaction',
  );
  await rejected(
    source.manager.insert(
      LedgerRowSchema,
      entry(w, tx, { balance_after: '80.00' }),
    ),
    '23514',
    'ck_ledger_arithmetic',
  );
  await rejected(
    source.manager.insert(LedgerRowSchema, entry(w, tx, { currency: 'USD' })),
    '23514',
    'ck_ledger_context',
  );
  await rejected(
    source.manager.insert(LedgerRowSchema, entry(await wallet(), tx)),
    '23514',
    'ck_ledger_context',
  );
  await rejected(
    source.manager.insert(
      LedgerRowSchema,
      entry(w, tx, { transaction_id: 'missing' }),
    ),
    '23514',
  );
});

test('ledger rejects UPDATE DELETE and TRUNCATE', async () => {
  const w = await wallet();
  const tx = await wager(w);
  const row = entry(w, tx);

  await source.manager.insert(LedgerRowSchema, row);
  await rejected(
    source.query('UPDATE wallet_ledger_entries SET amount=amount WHERE id=$1', [
      row.id,
    ]),
    '23514',
    'ck_ledger_immutable',
  );
  await rejected(
    source.query('DELETE FROM wallet_ledger_entries WHERE id=$1', [row.id]),
    '23514',
    'ck_ledger_immutable',
  );
  await rejected(
    source.query('TRUNCATE wallet_ledger_entries'),
    '23514',
    'ck_ledger_immutable',
  );
});

test('inbox primary key and immutable original result', async () => {
  const record = {
    consumer_name: 'test',
    message_id: id(),
    payload_hash: 'hash',
    received_at: at,
    processed_at: null,
  };

  await source.manager.insert(InboxRowSchema, record);
  await rejected(source.manager.insert(InboxRowSchema, record), '23505');

  const tx = await wager(await wallet());

  await rejected(
    source.query(
      'UPDATE wager_transactions SET result_balance=$1 WHERE id=$2',
      ['99.00', tx.id],
    ),
    '23514',
    'ck_wager_terminal',
  );
});

test('round trips preserve large monetary values, dates, status and original balance', async () => {
  const key = id();
  const opening = Wallet.open({
    id: key,
    playerId: key,
    initialBalance: money('9007199254740993.01'),
    at,
    opening: {
      transactionId: id(),
      ledgerEntryId: id(),
      payloadHash: 'opening-hash',
    },
  });
  const { openingTransaction, openingEntry } = opening;

  if (!openingTransaction || !openingEntry) {
    throw new Error('Missing opening');
  }

  await unit.run(async (ctx) => {
    await ctx.wallets.insert(opening.wallet);
    await ctx.transactions.insert(openingTransaction, {
      balance: opening.wallet.balance,
      version: 1,
    });
    await ctx.ledger.insert(openingEntry);
  });
  await unit.run(async (ctx) => {
    const loaded = await ctx.wallets.findByIdForUpdate(key);

    if (!loaded) {
      throw new Error('Missing wallet');
    }

    const tx = WagerTransaction.create({
      id: id(),
      providerId: 'provider',
      externalTransactionId: id(),
      idempotencyKey: id(),
      payloadHash: 'hash',
      walletId: key,
      playerId: key,
      roundId: 'round',
      gameId: 'game',
      kind: Kind.Win,
      money: money('0.01'),
      createdAt: at,
    });

    await ctx.transactions.insert(tx);

    const result = tx.applyTo(loaded, { ledgerEntryId: id(), at });

    await ctx.wallets.update(loaded);
    await ctx.transactions.update(tx, {
      result: { balance: loaded.balance, version: loaded.version },
    });

    if (result) {
      await ctx.ledger.insert(result);
    }

    expect(
      (
        await ctx.transactions.findByProviderExternal(
          tx.providerId,
          tx.externalTransactionId,
        )
      )?.transaction.status,
    ).toBe(Status.Processed);
    expect(
      (
        await ctx.transactions.findByIdempotencyKey(tx.idempotencyKey)
      )?.result?.balance.toString(),
    ).toBe('9007199254740993.02');

    const original = await ctx.transactions.findById(openingTransaction.id);

    expect(original?.result?.balance.toString()).toBe('9007199254740993.01');
    expect(original?.result?.version).toBe(1);
    expect(original?.transaction.createdAt).toEqual(at);
    expect(original?.transaction.processedAt).toEqual(at);
    expect((await ctx.wallets.findByPlayerCurrency(key, 'BRL'))?.version).toBe(
      2,
    );

    const entries = await ctx.ledger.findByWallet(key);

    expect(entries).toHaveLength(2);
    expect(
      entries.find((e) => e.id === openingEntry.id)?.money.toString(),
    ).toBe('9007199254740993.01');

    const first = entries[0];

    if (!first) {
      throw new Error('Missing ledger');
    }

    expect(
      await ctx.ledger.findByWallet(key, 50, {
        id: first.id,
        createdAt: first.createdAt,
      }),
    ).toHaveLength(1);
  });
});

test('all five repositories share rollback and outbox due query', async () => {
  const key = id();

  await expectFailure(
    unit.run(async (ctx) => {
      const result = Wallet.open({
        id: key,
        playerId: key,
        initialBalance: money('10.00'),
        at,
        opening: {
          transactionId: key,
          ledgerEntryId: key,
          payloadHash: 'hash',
        },
      });

      if (!result.openingTransaction || !result.openingEntry) {
        throw new Error('Missing opening');
      }

      await ctx.wallets.insert(result.wallet);
      await ctx.transactions.insert(result.openingTransaction, {
        balance: result.wallet.balance,
        version: 1,
      });
      await ctx.ledger.insert(result.openingEntry);
      await ctx.inbox.insert({
        consumerName: key,
        messageId: key,
        payloadHash: 'hash',
        receivedAt: at,
      });
      await ctx.outbox.insert({
        id: key,
        aggregateId: key,
        eventType: 'test',
        payload: { amount: '10.00' },
        occurredAt: at,
        attempts: 0,
      });

      expect(
        (await ctx.outbox.lockDue(new Date(), 1000)).some(
          (row) => row.id === key,
        ),
      ).toBe(true);
      expect((await ctx.inbox.find(key, key))?.payloadHash).toBe('hash');

      throw new Error('rollback requested');
    }),
    'rollback requested',
  );
  for (const table of [
    'wallets',
    'wager_transactions',
    'wallet_ledger_entries',
    'outbox_messages',
  ]) {
    expect(
      await source.query('SELECT id FROM ' + table + ' WHERE id=$1', [key]),
    ).toHaveLength(0);
  }

  expect(
    await source.query(
      'SELECT message_id FROM inbox_messages WHERE message_id=$1',
      [key],
    ),
  ).toHaveLength(0);
});

test('pessimistic lock requires active transaction', async () => {
  await expectFailure(
    new TypeOrmWalletRepository(source.manager).findByIdForUpdate('missing'),
    'active transaction',
  );
});

test('independent connection waits for same wallet while another wallet is accessible', async () => {
  const firstWallet = await wallet();
  const otherWallet = await wallet();
  const first = source.createQueryRunner();
  const second = source.createQueryRunner();
  let waiting: Promise<unknown> | undefined;
  try {
    await first.connect();
    await second.connect();
    await first.startTransaction('READ COMMITTED');
    await second.startTransaction('READ COMMITTED');
    await first.query("SET LOCAL statement_timeout='5s'");
    await second.query("SET LOCAL statement_timeout='5s'");
    await new TypeOrmWalletRepository(first.manager).findByIdForUpdate(
      firstWallet.id,
    );
    await new TypeOrmWalletRepository(second.manager).findByIdForUpdate(
      otherWallet.id,
    );

    const [{ pid }] = await second.manager.query<{ pid: number }[]>(
      'SELECT pg_backend_pid() AS pid',
    );

    if (!pid) {
      throw new Error('Missing backend');
    }

    waiting = new TypeOrmWalletRepository(second.manager).findByIdForUpdate(
      firstWallet.id,
    );

    let blocked = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await source.query<{ blocked: boolean }[]>(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
        [pid],
      );

      if (rows[0]?.blocked) {
        blocked = true;
        break;
      }

      await Bun.sleep(10);
    }

    expect(blocked).toBe(true);

    await first.commitTransaction();

    expect(await waiting).toBeDefined();

    await second.commitTransaction();
  } finally {
    if (first.isTransactionActive) {
      await first.rollbackTransaction();
    }

    if (waiting) {
      await waiting.catch(() => undefined);
    }

    if (second.isTransactionActive) {
      await second.rollbackTransaction();
    }

    await first.release();
    await second.release();
  }
}, 15000);

test('concurrent reversal inserts are arbitrated by PostgreSQL uniqueness', async () => {
  const w = await wallet();
  const ref = await wager(w);
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      wager(w, {
        kind: Kind.Refund,
        reference_transaction_id: ref.id,
        reference_external_transaction_id: ref.external_transaction_id,
      }),
    ),
  );

  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);

  const failure = results.find((result) => result.status === 'rejected');

  if (!failure || failure.status !== 'rejected') {
    throw new Error('Missing reversal conflict');
  }

  expect(failure.reason).toHaveProperty(
    'driverError.constraint',
    'uq_wager_processed_reversal',
  );
});

test('processed transaction deletion cannot free the reversal uniqueness guard', async () => {
  const tx = await wager(await wallet());

  await rejected(
    source.query('DELETE FROM wager_transactions WHERE id=$1', [tx.id]),
    '23514',
    'ck_wager_terminal',
  );
});

test('SQL reserves internal opening identity', async () => {
  const w = await wallet();

  await rejected(
    wager(w, { provider_id: 'internal' }),
    '23514',
    'ck_wager_internal_identity',
  );
  await rejected(
    wager(w, { idempotency_key: 'opening:' + w.id }),
    '23514',
    'ck_wager_internal_identity',
  );
});

for (const value of ['NaN', 'Infinity', '-Infinity', '-1.00']) {
  test('SQL protects ledger balances against ' + value, async () => {
    const w = await wallet();
    const tx = await wager(w);

    await rejected(
      source.manager.insert(
        LedgerRowSchema,
        entry(w, tx, { balance_before: value }),
      ),
      value.includes('Infinity') ? '22003' : '23514',
    );
  });
}

test('outbox skip locked excludes records held by another connection', async () => {
  const key = id();

  await unit.run((ctx) =>
    ctx.outbox.insert({
      id: key,
      aggregateId: key,
      eventType: 'test',
      payload: {},
      occurredAt: at,
      attempts: 0,
    }),
  );

  const first = source.createQueryRunner();
  try {
    await first.connect();
    await first.startTransaction();
    await first.manager
      .createQueryBuilder()
      .select()
      .from('outbox_messages', 'message')
      .where('id = :id', { id: key })
      .setLock('pessimistic_write')
      .getRawMany();
    await unit.run(async (ctx) => {
      expect(
        (await ctx.outbox.lockDue(new Date(), 1000)).some(
          (row) => row.id === key,
        ),
      ).toBe(false);
    });
    await first.commitTransaction();
    await unit.run(async (ctx) => {
      expect(
        (await ctx.outbox.lockDue(new Date(), 1000)).some(
          (row) => row.id === key,
        ),
      ).toBe(true);
    });
  } finally {
    if (first.isTransactionActive) {
      await first.rollbackTransaction();
    }

    await first.release();
  }
});

test('reference lookup and processed reversal round trip preserve domain state', async () => {
  const w = await wallet();
  const ref = await wager(w);
  const reversal = await wager(w, {
    kind: Kind.Rollback,
    reference_transaction_id: ref.id,
    reference_external_transaction_id: ref.external_transaction_id,
  });

  await unit.run(async (ctx) => {
    const loaded = await ctx.transactions.findReference(
      ref.provider_id,
      ref.external_transaction_id,
    );

    expect(loaded?.transaction.id).toBe(ref.id);

    const reversed = await ctx.transactions.findProcessedReversal(
      ref.id,
      Kind.Rollback,
    );

    expect(reversed?.transaction.id).toBe(reversal.id);
    expect(reversed?.transaction.referenceTransactionId).toBe(ref.id);
    expect(reversed?.transaction.referenceExternalTransactionId).toBe(
      ref.external_transaction_id,
    );
    expect(reversed?.transaction.processedAt).toEqual(at);
  });
});

test('repository persists pending-reference retry metadata without domain transitions on reads', async () => {
  const w = await wallet();
  const row = await wager(w, {
    kind: Kind.Refund,
    reference_external_transaction_id: 'missing',
    status: Status.Pending,
    result_balance: null,
    result_version: null,
    processed_at: null,
  });

  await unit.run(async (ctx) => {
    const stored = await ctx.transactions.findById(row.id);

    if (!stored) {
      throw new Error('Missing transaction');
    }

    stored.transaction.markPendingReference();
    await ctx.transactions.update(stored.transaction, {
      referenceAttempts: 2,
      nextAttemptAt: at,
    });

    const loaded = await ctx.transactions.findById(row.id);

    expect(loaded?.transaction.status).toBe(Status.PendingReference);
    expect(loaded?.referenceAttempts).toBe(2);
    expect(loaded?.nextAttemptAt).toEqual(at);
    expect(loaded?.transaction.processedAt).toBeUndefined();
  });
});
