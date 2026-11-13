import { WagerTransactionStatus as Status } from '../../src/domain/financial.types.js';
import 'reflect-metadata';
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { configureHttp } from '../../src/infrastructure/http/configure-http.js';
import { FinancialDiagnostics } from '../../src/infrastructure/http/financial-diagnostics.js';
import { databaseOptions } from '../../src/infrastructure/database/options.js';
import { FinancialFoundation1797000000000 } from '../../src/infrastructure/database/migrations/1797000000000-financial-foundation.js';
import { RejectedSnapshots1797000001000 } from '../../src/infrastructure/database/migrations/1797000001000-rejected-snapshots.js';
import { TypeOrmFinancialTransaction } from '../../src/infrastructure/database/repositories/typeorm-financial-transaction.js';
import type { FinancialTransaction } from '../../src/application/ports/financial-transaction.js';
import { PersistenceError } from '../../src/application/ports/persistence.error.js';
import { ReprocessPendingReferenceUseCase } from '../../src/application/use-cases/reprocess-pending-reference.use-case.js';
import type { OpenWalletResult } from '../../src/application/use-cases/open-wallet.use-case.js';
import type { ProcessWagerResult } from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import type { ReconciliationResult } from '../../src/application/use-cases/reconcile-wallet.use-case.js';
import { decodeLedgerCursor } from '../../src/application/services/ledger-cursor.js';

const database = 'wager_http_' + crypto.randomUUID().replaceAll('-', '');
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
const actual = new TypeOrmFinancialTransaction(source);
const records: Readonly<Record<string, unknown>>[] = [];
const diagnostics = new FinancialDiagnostics((record) => records.push(record));
let app: INestApplication;
let base: string;
let failure: 'transient' | 'unexpected' | undefined;
let pauseWrite: { entered: () => void; release: Promise<void> } | undefined;
const controlled: FinancialTransaction = {
  run: (work) => {
    if (failure) {
      return Promise.reject(
        failure === 'transient'
          ? new PersistenceError('transient')
          : new Error('SQL password SECRET_STACK'),
      );
    }
    return actual.run((context) => {
      const insert = context.ledger.insert.bind(context.ledger);
      context.ledger.insert = async (entry) => {
        await insert(entry);
        const pause = pauseWrite;
        if (pause) {
          pauseWrite = undefined;
          pause.entered();
          await pause.release;
        }
      };
      return work(context);
    });
  },
};

beforeAll(async () => {
  await admin.initialize();
  await admin.query('CREATE DATABASE "' + database + '"');
  await source.initialize();
  await source.runMigrations();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DataSource)
    .useValue(source)
    .overrideProvider(TypeOrmFinancialTransaction)
    .useValue(controlled)
    .overrideProvider(FinancialDiagnostics)
    .useValue(diagnostics)
    .compile();
  app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 60000);

afterAll(async () => {
  if (app) {
    await app.close();
  }
  if (source.isInitialized) {
    await source.destroy();
  }
  if (admin.isInitialized) {
    if (!/^wager_http_[a-f0-9]{32}$/.test(database)) {
      throw new Error('Unsafe test database');
    }
    await admin.query(
      'DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)',
    );
    await admin.destroy();
  }
});

async function request<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ response: Response; body: T }> {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json();
  return { response, body: json as T };
}

async function wallet(amount = '1000.00'): Promise<OpenWalletResult> {
  const result = await request<OpenWalletResult>('/wallets', 'POST', {
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(result.response.status).toBe(201);
  return result.body;
}

function payload(w: OpenWalletResult, kind = 'BET', amount = '25.00') {
  return {
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    walletId: w.id,
    playerId: w.playerId,
    roundId: 'round',
    gameId: 'game',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

async function submit(
  input: ReturnType<typeof payload> & {
    referenceExternalTransactionId?: string;
  },
  key: string = input.externalTransactionId,
) {
  return request<Omit<ProcessWagerResult, 'canAcknowledge'>>(
    '/wagering/transactions',
    'POST',
    input,
    { 'Idempotency-Key': key },
  );
}

async function reconcile(walletId: string): Promise<ReconciliationResult> {
  const result = await request<ReconciliationResult>(
    '/wallets/' + walletId + '/reconciliation',
    'POST',
  );
  expect(result.response.status).toBe(200);
  expect(result.body.consistent).toBe(true);
  expect(result.body.difference.amount).toBe('0.00');
  return result.body;
}

async function counts(walletId: string) {
  return (
    await source.query<
      {
        balance: string;
        version: number;
        transactions: string;
        ledger: string;
        events: string;
      }[]
    >(
      `SELECT w.balance,w.version,
    (SELECT count(*) FROM wager_transactions WHERE wallet_id=w.id) AS transactions,
    (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id=w.id) AS ledger,
    (SELECT count(*) FROM outbox_messages WHERE aggregate_id=w.id) AS events FROM wallets w WHERE id=$1`,
      [walletId],
    )
  )[0];
}

test('HTTP opens wallet with atomic opening, explicit money, correlation and version one', async () => {
  const w = await wallet();

  expect(w.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
  expect(await counts(w.id)).toEqual({
    balance: '1000.00',
    version: 1,
    transactions: '1',
    ledger: '1',
    events: '2',
  });
  const opening = await source.query<{ id: string; status: string }[]>(
    'SELECT id,status FROM wager_transactions WHERE wallet_id=$1 AND kind=$2',
    [w.id, 'OPENING'],
  );
  expect(opening[0]?.status).toBe('PROCESSED');
  const query = await request('/wagering/transactions/' + opening[0]?.id);
  expect(query.response.status).toBe(200);
  expect(query.body.kind).toBe('OPENING');
  await reconcile(w.id);
});

test('HTTP duplicate wallet is 409 and zero wallet has no ledger', async () => {
  const w = await wallet('0.00');
  const duplicate = await request('/wallets', 'POST', {
    playerId: w.playerId,
    initialBalance: w.balance,
  });

  expect(duplicate.response.status).toBe(409);
  expect(duplicate.body.code).toBe('WALLET_CONFLICT');
  expect(await counts(w.id)).toEqual({
    balance: '0.00',
    version: 1,
    transactions: '0',
    ledger: '0',
    events: '0',
  });
  const ledger = await request('/wallets/' + w.id + '/ledger');
  expect(ledger.body).toEqual({ items: [], nextCursor: null });
  expect((await reconcile(w.id)).checkedEntries).toBe(0);
});

test('HTTP wallet queries distinguish existing, missing and invalid IDs', async () => {
  const w = await wallet();
  const found = await request<OpenWalletResult>('/wallets/' + w.id);

  expect(found.response.status).toBe(200);
  expect(found.body).toEqual(w);
  expect(
    (await request('/wallets/' + crypto.randomUUID())).response.status,
  ).toBe(404);
  expect((await request('/wallets/invalid')).response.status).toBe(400);
  await reconcile(w.id);
});

test('HTTP BET, original snapshot replay and identity conflicts preserve financial effects', async () => {
  const w = await wallet();
  const input = payload(w);
  const original = await submit(input);
  await submit(payload(w));
  const before = await counts(w.id);
  const replay = await submit(input);

  expect(original.response.status).toBe(200);
  expect(original.body.balance?.amount).toBe('975.00');
  expect(original.body).not.toHaveProperty('canAcknowledge');
  expect(original.body).not.toHaveProperty('payloadHash');
  expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
  expect(await counts(w.id)).toEqual(before);
  expect(
    (await submit({ ...input, money: { amount: '26.00', currency: 'BRL' } }))
      .response.status,
  ).toBe(409);
  const conflict = await submit(input, 'different-key');
  expect(conflict.response.status).toBe(409);
  expect(conflict.body).toHaveProperty('code', 'EXTERNAL_IDENTITY_CONFLICT');
  const byId = await request(
    '/wagering/transactions/' + original.body.transactionId,
  );
  const byExternal = await request(
    '/providers/provider-a/wagering/transactions/' +
      input.externalTransactionId,
  );
  expect(byId.body).toEqual(byExternal.body);
  expect(byId.body).toHaveProperty('balance.amount', '975.00');
  expect(byId.body).not.toHaveProperty('payloadHash');
  await reconcile(w.id);
});

for (const header of [undefined, '', 'a,b', 'x'.repeat(257)]) {
  test(
    'HTTP rejects missing or invalid idempotency header ' + String(header),
    async () => {
      const w = await wallet();
      const before = await counts(w.id);

      const result = await request(
        '/wagering/transactions',
        'POST',
        payload(w),
        header === undefined ? {} : { 'Idempotency-Key': header },
      );

      expect(result.response.status).toBe(400);
      expect(result.body.code).toBe('INVALID_INPUT');
      expect(await counts(w.id)).toEqual(before);
      await reconcile(w.id);
    },
  );
}

test('HTTP financial rejection is committed and replayed after a later credit', async () => {
  const w = await wallet('100.00');
  const input = payload(w, 'BET', '101.00');
  const rejected = await submit(input);
  const afterRejection = await counts(w.id);
  await submit(payload(w, 'WIN', '100.00'));
  const replay = await submit(input);

  expect(rejected.response.status).toBe(422);
  expect(rejected.body).toMatchObject({
    status: 'REJECTED',
    failureCode: 'INSUFFICIENT_FUNDS',
    balance: { amount: '100.00', currency: 'BRL' },
  });
  expect(afterRejection).toEqual({
    balance: '100.00',
    version: 1,
    transactions: '2',
    ledger: '1',
    events: '3',
  });
  expect(replay.response.status).toBe(422);
  expect(replay.body).toEqual({ ...rejected.body, idempotentReplay: true });
  expect(
    (await request('/wagering/transactions/' + rejected.body.transactionId))
      .response.status,
  ).toBe(200);
  await reconcile(w.id);
});

test('HTTP pending reference is queryable and later reflects explicit reprocessing', async () => {
  const w = await wallet();
  const bet = payload(w);
  const input = {
    ...payload(w, 'REFUND'),
    referenceExternalTransactionId: bet.externalTransactionId,
  };
  const pending = await submit(input);

  expect(pending.response.status).toBe(202);
  expect(pending.body.status).toBe(Status.PendingReference);
  expect(pending.body).not.toHaveProperty('balance');
  expect(
    (await request('/wagering/transactions/' + pending.body.transactionId))
      .response.status,
  ).toBe(200);
  await reconcile(w.id);
  await submit(bet);
  await source.query(
    'UPDATE wager_transactions SET next_attempt_at=$2 WHERE id=$1',
    [pending.body.transactionId, new Date(0)],
  );
  await app
    .get(ReprocessPendingReferenceUseCase)
    .execute(pending.body.transactionId);
  const resolved = await request(
    '/wagering/transactions/' + pending.body.transactionId,
  );
  expect(resolved.body.status).toBe('PROCESSED');
  expect((await submit(input)).response.status).toBe(200);
  await reconcile(w.id);
});

test('HTTP missing transaction identities return 404', async () => {
  expect(
    (await request('/wagering/transactions/' + crypto.randomUUID())).response
      .status,
  ).toBe(404);
  expect(
    (await request('/wagering/transactions/invalid')).response.status,
  ).toBe(400);
  expect(
    (await request('/providers/missing/wagering/transactions/missing')).response
      .status,
  ).toBe(404);
});

for (const change of [
  { money: { amount: 25, currency: 'BRL' } },
  { extra: true },
  { money: { amount: '25.00', currency: 'BRL', extra: true } },
  { kind: 'OPENING' },
  { providerId: 'internal' },
  { walletId: 'invalid' },
  { kind: 'INVALID' },
  { playerId: undefined },
  { idempotencyKey: 'body-key' },
]) {
  test('HTTP validation rejects ' + JSON.stringify(change), async () => {
    const w = await wallet();
    const before = await counts(w.id);

    const result = await request(
      '/wagering/transactions',
      'POST',
      { ...payload(w), ...change },
      { 'Idempotency-Key': 'valid-key' },
    );

    expect(result.response.status).toBe(400);
    expect(await counts(w.id)).toEqual(before);
    expect(result.body.correlationId).toBe(
      result.response.headers.get('x-correlation-id'),
    );
    await reconcile(w.id);
  });
}

test('HTTP ledger pages preserve ties and PostgreSQL microseconds', async () => {
  const w = await wallet();
  for (let index = 0; index < 4; index += 1) {
    await submit(payload(w));
  }
  // Administrative fixture setup is restricted to this disposable database.
  await source.transaction(async (manager) => {
    await manager.query(
      'ALTER TABLE wallet_ledger_entries DISABLE TRIGGER immutable_ledger',
    );
    await manager.query(
      `UPDATE wallet_ledger_entries SET created_at='2026-11-13T12:00:00.123456Z' WHERE wallet_id=$1`,
      [w.id],
    );
    await manager.query(
      'ALTER TABLE wallet_ledger_entries ENABLE TRIGGER immutable_ledger',
    );
  });
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page: {
      response: Response;
      body: {
        items: { id: string; createdAt: string }[];
        nextCursor: string | null;
      };
    } = await request(
      '/wallets/' +
        w.id +
        '/ledger?limit=2' +
        (cursor ? '&cursor=' + cursor : ''),
    );
    expect(page.response.status).toBe(200);
    ids.push(...page.body.items.map((entry) => entry.id));
    cursor = page.body.nextCursor;
    if (cursor) {
      expect(decodeLedgerCursor(cursor, w.id).createdAt).toBe(
        '2026-11-13T12:00:00.123456Z',
      );
    }
  } while (cursor);

  expect(ids).toHaveLength(5);
  expect(new Set(ids).size).toBe(5);
  expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  for (const query of [
    'limit=0',
    'limit=101',
    'limit=1.5',
    'cursor=invalid',
    'limit=1&limit=2',
    'extra=x',
  ]) {
    expect(
      (await request('/wallets/' + w.id + '/ledger?' + query)).response.status,
    ).toBe(400);
  }
  const first = await request<{ nextCursor: string }>(
    '/wallets/' + w.id + '/ledger?limit=1',
  );
  const other = await wallet();
  expect(
    (
      await request(
        '/wallets/' + other.id + '/ledger?cursor=' + first.body.nextCursor,
      )
    ).response.status,
  ).toBe(400);
  expect(
    (await request('/wallets/' + crypto.randomUUID() + '/ledger')).response
      .status,
  ).toBe(404);
  await reconcile(w.id);
});

test('HTTP divergence returns signed difference and increments metric without changing data', async () => {
  const w = await wallet('100.00');
  await source.query('UPDATE wallets SET balance=$2 WHERE id=$1', [
    w.id,
    '90.00',
  ]);
  const before = await counts(w.id);
  const counter = diagnostics.reconciliationDivergences;
  const result = await request<ReconciliationResult>(
    '/wallets/' + w.id + '/reconciliation',
    'POST',
    undefined,
    { 'x-correlation-id': 'reconciliation-test' },
  );

  expect(result.response.status).toBe(200);
  expect(result.body).toMatchObject({
    consistent: false,
    storedBalance: { amount: '90.00', currency: 'BRL' },
    calculatedBalance: { amount: '100.00', currency: 'BRL' },
    difference: { amount: '-10.00', currency: 'BRL' },
    checkedEntries: 1,
  });
  expect(diagnostics.reconciliationDivergences).toBe(counter + 1);
  expect(records.at(-1)).toMatchObject({
    event: 'wallet_reconciliation_divergence',
    walletId: w.id,
    correlationId: 'reconciliation-test',
  });
  expect(await counts(w.id)).toEqual(before);
  await source.query('UPDATE wallets SET balance=$2 WHERE id=$1', [
    w.id,
    '100.00',
  ]);
  await reconcile(w.id);
});

test('HTTP reconciliation sees an atomic snapshot while financial writes await commit', async () => {
  const w = await wallet('100.00');
  let entered = (): void => {};
  let release = (): void => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  pauseWrite = { entered, release: gate };
  const pending = submit(payload(w, 'WIN', '10.00'));
  try {
    await ready;
    const before = await reconcile(w.id);
    expect(before.storedBalance.amount).toBe('100.00');
    expect(before.checkedEntries).toBe(1);
  } finally {
    release();
    pauseWrite = undefined;
  }
  expect((await pending).response.status).toBe(200);
  const after = await reconcile(w.id);
  expect(after.storedBalance.amount).toBe('110.00');
  expect(after.checkedEntries).toBe(2);
}, 15000);

test('50 concurrent HTTP duplicates produce one debit and original snapshots', async () => {
  const w = await wallet('100.00');
  const input = payload(w, 'BET', '10.00');

  const results = await Promise.all(
    Array.from({ length: 50 }, () => submit(input)),
  );

  expect(results.every((result) => result.response.status === 200)).toBe(true);
  expect(new Set(results.map((result) => result.body.transactionId)).size).toBe(
    1,
  );
  expect(
    results.filter((result) => !result.body.idempotentReplay),
  ).toHaveLength(1);
  expect(await counts(w.id)).toEqual({
    balance: '90.00',
    version: 2,
    transactions: '2',
    ledger: '2',
    events: '4',
  });
  await reconcile(w.id);
}, 30000);

test('two concurrent HTTP bets of 80 approve one and leave balance 20', async () => {
  const w = await wallet('100.00');

  const results = await Promise.all([
    submit(payload(w, 'BET', '80.00')),
    submit(payload(w, 'BET', '80.00')),
  ]);

  expect(
    results.map((result) => result.response.status).sort((a, b) => a - b),
  ).toEqual([200, 422]);
  expect(await counts(w.id)).toEqual({
    balance: '20.00',
    version: 2,
    transactions: '3',
    ledger: '2',
    events: '5',
  });
  await reconcile(w.id);
});

for (const mode of ['transient', 'unexpected'] as const) {
  test('HTTP sanitizes ' + mode + ' persistence failures', async () => {
    const w = await wallet();
    const before = await counts(w.id);
    failure = mode;
    let result: { response: Response; body: Record<string, unknown> };
    try {
      result = await request('/wallets/' + w.id);
    } finally {
      failure = undefined;
    }

    expect(result.response.status).toBe(mode === 'transient' ? 503 : 500);
    expect(JSON.stringify(result.body)).not.toMatch(
      /SQL|password|SECRET_STACK|stack|constraint/,
    );
    expect(result.body.correlationId).toBe(
      result.response.headers.get('x-correlation-id'),
    );
    expect(await counts(w.id)).toEqual(before);
    await reconcile(w.id);
  });
}

test('HTTP correlation propagates to outbox and invalid correlation is rejected', async () => {
  const w = await wallet();
  const input = payload(w);
  const result = await request('/wagering/transactions', 'POST', input, {
    'Idempotency-Key': input.externalTransactionId,
    'x-correlation-id': 'http-correlation',
  });

  expect(result.response.headers.get('x-correlation-id')).toBe(
    'http-correlation',
  );
  const events = await source.query<{ correlation: string }[]>(
    `SELECT payload->>'correlationId' AS correlation FROM outbox_messages WHERE aggregate_id=$1 AND payload->'data'->>'transactionId'=$2`,
    [w.id, result.body.transactionId],
  );
  expect(events).toHaveLength(2);
  expect(
    events.every((event) => event.correlation === 'http-correlation'),
  ).toBe(true);
  expect(
    (
      await request('/wallets/' + w.id, 'GET', undefined, {
        'x-correlation-id': 'invalid value',
      })
    ).response.status,
  ).toBe(400);
  await reconcile(w.id);
});

test('HTTP health stays open and preserves response contracts', async () => {
  for (const path of ['/health', '/health/live', '/health/ready']) {
    const result = await request(path);
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ status: 'ok' });
  }
});

test('HTTP persisted FAILED replays as a terminal 500 result and remains queryable', async () => {
  const { WagerTransaction } =
    await import('../../src/domain/entities/wager-transaction.js');
  const { Money } = await import('../../src/domain/value-objects/money.js');
  const { WagerTransactionKind, FailureCode } =
    await import('../../src/domain/financial.types.js');
  const { canonicalPayloadHash } =
    await import('../../src/application/services/canonical-payload-hash.js');
  const w = await wallet();
  const input = payload(w);
  const transactionInput = { ...input, kind: WagerTransactionKind.Bet };
  const tx = WagerTransaction.create({
    ...transactionInput,
    id: crypto.randomUUID(),
    idempotencyKey: input.externalTransactionId,
    payloadHash: canonicalPayloadHash(transactionInput),
    money: Money.from(input.money),
    createdAt: new Date(),
  });
  tx.fail(FailureCode.PermanentInfrastructureFailure);
  await actual.run((context) =>
    context.transactions.insert(tx, {
      balance: Money.from(w.balance),
      version: w.version,
    }),
  );
  const before = await counts(w.id);

  const result = await submit(input);
  const query = await request('/wagering/transactions/' + tx.id);

  expect(result.response.status).toBe(500);
  expect(result.body).toMatchObject({
    status: 'FAILED',
    idempotentReplay: true,
    failureCode: 'PERMANENT_INFRASTRUCTURE_FAILURE',
  });
  expect(query.response.status).toBe(200);
  expect(query.body.status).toBe('FAILED');
  expect(await counts(w.id)).toEqual(before);
  await reconcile(w.id);
});
