import 'reflect-metadata';
import { beforeAll, afterAll, test, expect } from 'bun:test';
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module.js';
import { configureHttp } from '../../src/infrastructure/http/configure-http.js';
import { databaseOptions } from '../../src/infrastructure/database/options.js';
import { FinancialFoundation1797000000000 } from '../../src/infrastructure/database/migrations/1797000000000-financial-foundation.js';
import { RejectedSnapshots1797000001000 } from '../../src/infrastructure/database/migrations/1797000001000-rejected-snapshots.js';
import { FinancialDiagnostics } from '../../src/infrastructure/http/financial-diagnostics.js';
import { OperationalMetrics } from '../../src/infrastructure/observability/operational-metrics.js';
import { instanceId } from '../../src/infrastructure/config/instance-id.js';
import { JsonLog } from '../../src/infrastructure/observability/json-log.js';
import { FinancialObservationLogger } from '../../src/infrastructure/observability/financial-observation.js';
import { TypeOrmFinancialTransaction } from '../../src/infrastructure/database/repositories/typeorm-financial-transaction.js';
import { PersistenceError } from '../../src/application/ports/persistence.error.js';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import { WagerTransactionKind as Kind } from '../../src/domain/financial.types.js';

const database = 'wager_metrics_' + crypto.randomUUID().replaceAll('-', '');
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
const records: Readonly<Record<string, unknown>>[] = [];
let app: INestApplication;
let url: string;

beforeAll(async () => {
  await admin.initialize();
  await admin.query('CREATE DATABASE "' + database + '"');
  await source.initialize();
  await source.runMigrations();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(FinancialObservationLogger)
    .useValue(
      new FinancialObservationLogger(
        new JsonLog(
          (record) => {
            records.push(record);
          },
          { ...process.env, LOG_LEVEL: 'debug' },
        ),
      ),
    )
    .overrideProvider(DataSource)
    .useValue(source)
    .overrideProvider(FinancialDiagnostics)
    .useFactory({
      inject: [OperationalMetrics],
      factory: (metrics: OperationalMetrics) =>
        new FinancialDiagnostics((record) => records.push(record), metrics),
    })
    .compile();
  app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
}, 60000);

afterAll(async () => {
  if (app) {
    await app.close();
  }

  if (source.isInitialized) {
    await source.destroy();
  }

  if (admin.isInitialized) {
    if (!/^wager_metrics_[a-f0-9]{32}$/.test(database)) {
      throw new Error('Unsafe test database');
    }

    await admin.query(
      'DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)',
    );
    await admin.destroy();
  }
});

test('real HTTP processing, replay, conflict and reconciliation are exposed as bounded Prometheus metrics', async () => {
  const correlationId = crypto.randomUUID();
  const headers = {
    'content-type': 'application/json',
    'x-correlation-id': correlationId,
  };
  const opened = await fetch(url + '/wallets', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
  });
  const wallet = (await opened.json()) as { id: string; playerId: string };
  const key = crypto.randomUUID();
  const body = {
    providerId: 'provider-metrics',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  const send = (payload: unknown, idempotencyKey: string) =>
    fetch(url + '/wagering/transactions', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': idempotencyKey },
      body: JSON.stringify(payload),
    });
  expect((await send(body, key)).status).toBe(200);
  expect((await send(body, key)).status).toBe(200);
  expect(
    (await send({ ...body, money: { amount: '10.00', currency: 'BRL' } }, key))
      .status,
  ).toBe(409);
  expect(
    (
      await send(
        {
          ...body,
          externalTransactionId: crypto.randomUUID(),
          money: { amount: '80.00', currency: 'BRL' },
        },
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(422);
  expect(
    (
      await send(
        {
          ...body,
          externalTransactionId: crypto.randomUUID(),
          kind: 'REFUND',
          referenceExternalTransactionId: 'missing-bet',
        },
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(202);
  await source.query('UPDATE wallets SET balance=$2 WHERE id=$1', [
    wallet.id,
    '90.00',
  ]);
  try {
    const reconciliation = await fetch(
      url + '/wallets/' + wallet.id + '/reconciliation',
      { method: 'POST', headers },
    );
    expect(await reconciliation.json()).toMatchObject({ consistent: false });
  } finally {
    await source.query('UPDATE wallets SET balance=$2 WHERE id=$1', [
      wallet.id,
      '75.00',
    ]);
  }

  const response = await fetch(url + '/metrics');
  const text = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain');
  expect(response.headers.get('x-instance-id')).toBe(instanceId());
  expect(text).toContain('source="http",status="PROCESSED",replay="false"} 1');
  expect(text).toContain('source="http",status="PROCESSED",replay="true"} 1');
  expect(text).toContain('source="http",status="REJECTED",replay="false"} 1');
  expect(text).toContain(
    'source="http",status="PENDING_REFERENCE",replay="false"} 1',
  );
  expect(text).toContain('code="IDEMPOTENCY_CONFLICT"} 1');
  expect(text).toMatch(/wager_reconciliation_divergences_total\{[^}]+\} 1/);
  expect(text).toMatch(/wager_outbox_pending_events\{[^}]+\} 6/);
  expect(text).toMatch(/wager_reference_pending_transactions\{[^}]+\} 1/);
  expect(text).toMatch(/wager_metrics_database_collection_success\{[^}]+\} 1/);
  expect(text).toMatch(/wager_metrics_sqs_collection_success\{[^}]+\} 1/);
  expect(text).not.toContain(wallet.id);
  expect(text).not.toContain(correlationId);
  expect(records).toContainEqual(
    expect.objectContaining({
      event: 'financial_result',
      instanceId: instanceId(),
      correlationId,
      providerId: body.providerId,
      walletId: wallet.id,
    }),
  );
});

test('financial logs preserve identity, safe outcomes and actual SQL boundaries', async () => {
  const request = async (
    path: string,
    body: unknown,
    correlation: string,
    key?: string,
  ) => {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': correlation,
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: JSON.stringify(body),
    });
    return {
      response,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  for (const amount of ['0.00', '100.00']) {
    const correlation = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const opened = await request(
      '/wallets',
      { playerId, initialBalance: { amount, currency: 'BRL' } },
      correlation,
    );
    expect(opened.response.status).toBe(201);
    expect(
      records.find(
        (record) =>
          record.event === 'wallet_opened' &&
          record.correlationId === correlation,
      ),
    ).toMatchObject({
      walletId: opened.body.id,
      level: 'info',
      source: 'http',
      durationMs: expect.any(Number),
    });
    if (amount === '0.00') {
      continue;
    }
    const key = crypto.randomUUID();
    const payload = {
      walletId: opened.body.id,
      playerId,
      providerId: 'logging-review',
      externalTransactionId: crypto.randomUUID(),
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const firstCorrelation = crypto.randomUUID();
    const replayCorrelation = crypto.randomUUID();
    const first = await request(
      '/wagering/transactions',
      payload,
      firstCorrelation,
      key,
    );
    const replay = await request(
      '/wagering/transactions',
      payload,
      replayCorrelation,
      key,
    );
    expect(first.response.status).toBe(200);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    for (const [correlationId, idempotentReplay] of [
      [firstCorrelation, false],
      [replayCorrelation, true],
    ] as const) {
      expect(
        structuredClone(
          records.find(
            (record) =>
              record.event === 'financial_result' &&
              record.correlationId === correlationId,
          ),
        ),
      ).toMatchObject({
        transactionId: first.body.transactionId,
        kind: 'BET',
        externalTransactionId: payload.externalTransactionId,
        durationMs: expect.any(Number),
        idempotentReplay,
        source: 'http',
        level: 'info',
      });
    }
    const pendingEvents = await source.query<{ correlation: string }[]>(
      "SELECT payload->>'correlationId' AS correlation FROM outbox_messages WHERE payload->'data'->>'transactionId'=$1",
      [first.body.transactionId],
    );
    expect(pendingEvents).toHaveLength(2);
    expect(
      pendingEvents.every((record) => record.correlation === firstCorrelation),
    ).toBe(true);
    const flow = records.filter(
      (record) => record.correlationId === firstCorrelation,
    );
    for (const event of [
      'financial_processing_started',
      'financial_attempt_started',
      'wallet_lock_requested',
      'wallet_lock_acquired',
      'financial_transaction_committed',
    ]) {
      expect(
        flow.some(
          (record) => record.event === event && record.level === 'debug',
        ),
      ).toBe(true);
    }
    expect(
      flow.findIndex(
        (record) => record.event === 'financial_transaction_committed',
      ),
    ).toBeLessThan(
      flow.findIndex((record) => record.event === 'financial_result'),
    );
    const rejectionCorrelation = crypto.randomUUID();
    const rejected = await request(
      '/wagering/transactions',
      {
        ...payload,
        externalTransactionId: crypto.randomUUID(),
        money: { amount: '1000.00', currency: 'BRL' },
      },
      rejectionCorrelation,
      crypto.randomUUID(),
    );
    expect(rejected.response.status).toBe(422);
    expect(
      records.find(
        (record) =>
          record.event === 'financial_result' &&
          record.correlationId === rejectionCorrelation,
      ),
    ).toMatchObject({
      level: 'info',
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    const technical: Readonly<Record<string, unknown>>[] = [];
    const observer = {
      record: (
        event: string,
        fields: Readonly<Record<string, unknown>>,
      ): void => {
        technical.push({ event, ...fields });
      },
    };
    const actual = new TypeOrmFinancialTransaction(source);
    const failedTransaction = await actual
      .run(
        async (context) => {
          await context.wallets.findByIdForUpdate(String(opened.body.id));
          throw new PersistenceError('transient');
        },
        { observer, fields: { sqlAttempt: 1 } },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failedTransaction).toBeInstanceOf(Error);
    expect(
      technical.some(
        (record) => record.event === 'financial_transaction_failed',
      ),
    ).toBe(true);
    expect(
      technical.some(
        (record) => record.event === 'financial_transaction_committed',
      ),
    ).toBe(false);
    expect(
      technical.find((record) => record.event === 'wallet_lock_acquired'),
    ).toMatchObject({ durationMs: expect.any(Number), sqlAttempt: 1 });
    expect(
      await actual.run(async () => 42, {
        observer: {
          record: () => {
            throw new Error('logging unavailable');
          },
        },
        fields: {},
      }),
    ).toBe(42);
    const safeProcessor = new ProcessWagerTransactionUseCase(
      actual,
      undefined,
      undefined,
      {
        record: () => {
          throw new Error('observer unavailable during real writes');
        },
      },
    );
    const safelyCommitted = await safeProcessor.execute({
      ...payload,
      walletId: String(opened.body.id),
      kind: Kind.Bet,
      externalTransactionId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      money: { amount: '1.00', currency: 'BRL' },
    });
    expect(safelyCommitted).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '89.00', currency: 'BRL' },
    });
    const reconciled = await fetch(
      url + '/wallets/' + String(opened.body.id) + '/reconciliation',
      { method: 'POST' },
    );
    expect(await reconciled.json()).toMatchObject({
      consistent: true,
      difference: { amount: '0.00' },
    });
    for (const record of records.filter(
      (item) =>
        item.correlationId === firstCorrelation ||
        item.correlationId === replayCorrelation,
    )) {
      expect(JSON.stringify(record)).not.toMatch(
        /amount|balance|password|ReceiptHandle|idempotencyKey/,
      );
    }
    for (const sampleCorrelation of [
      firstCorrelation,
      replayCorrelation,
      rejectionCorrelation,
    ]) {
      const sample = records.find(
        (record) =>
          record.event === 'financial_result' &&
          record.correlationId === sampleCorrelation,
      );
      expect(sample).toBeDefined();
      console.log(JSON.stringify(sample));
    }
  }
});
