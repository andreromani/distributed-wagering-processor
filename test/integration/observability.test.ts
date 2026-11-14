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
