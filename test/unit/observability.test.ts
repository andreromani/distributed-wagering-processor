import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { instanceId } from '../../src/infrastructure/config/instance-id.js';
import { OperationalMetrics } from '../../src/infrastructure/observability/operational-metrics.js';
import { FinancialDiagnostics } from '../../src/infrastructure/http/financial-diagnostics.js';
import { MessagingDiagnostics } from '../../src/infrastructure/messaging/messaging-diagnostics.js';
import { WagerTransactionStatus as Status } from '../../src/domain/financial.types.js';
import type { ProcessWagerResult } from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import { MetricsController } from '../../src/infrastructure/http/metrics.controller.js';
import { DataSource } from 'typeorm';
import { SQSClient } from '@aws-sdk/client-sqs';
import { databaseOptions } from '../../src/infrastructure/database/options.js';

const result: ProcessWagerResult = {
  transactionId: crypto.randomUUID(),
  status: Status.Processed,
  createdAt: new Date().toISOString(),
  idempotentReplay: false,
  canAcknowledge: true,
};

test('instance identity is stable, configurable and bounded', () => {
  expect(instanceId({})).toBe(instanceId({}));
  expect(instanceId({ INSTANCE_ID: 'app-3' })).toBe('app-3');
  for (const value of ['', 'a\nb', 'a"b', 'x'.repeat(129)]) {
    expect(() => instanceId({ INSTANCE_ID: value })).toThrow();
  }
});

test('Prometheus counters distinguish observed statuses and replays without business ID labels', () => {
  const metrics = new OperationalMetrics();
  metrics.processing(result, 'http');
  metrics.processing({ ...result, idempotentReplay: true }, 'sqs');
  metrics.conflict('IDEMPOTENCY_CONFLICT');
  metrics.conflict(result.transactionId);

  const text = metrics.render();

  expect(text).toContain('source="http",status="PROCESSED",replay="false"} 1');
  expect(text).toContain('source="sqs",status="PROCESSED",replay="true"} 1');
  expect(text).toContain('code="IDEMPOTENCY_CONFLICT"} 1');
  expect(text).not.toContain(result.transactionId);
  expect(text).not.toMatch(/walletId|messageId|eventId|transactionId/);
  expect(text.endsWith('\n')).toBe(true);
});

test('histograms expose cumulative buckets, count and sum using seconds', () => {
  const metrics = new OperationalMetrics();
  metrics.duration('sqs', 0.1);
  metrics.duration('sqs', 2);
  metrics.duration('sqs', NaN);

  const text = metrics.render();

  expect(text).toContain('source="sqs",le="0.1"} 1');
  expect(text).toContain('source="sqs",le="5"} 2');
  expect(text).toContain('source="sqs",le="+Inf"} 2');
  expect(text).toContain('source="sqs"} 2.1');
  expect(text).not.toContain('NaN');
});

test('database and DLQ gauges preserve last known values with failed collection flags', () => {
  const metrics = new OperationalMetrics();
  metrics.database(3, 12.5, 1);
  metrics.dlq(2);
  metrics.databaseAvailable(false);
  metrics.sqsAvailable(false);

  const text = metrics.render();

  expect(text).toMatch(/wager_outbox_oldest_pending_age_seconds\{[^}]+\} 12.5/);
  expect(text).toMatch(/wager_sqs_dlq_messages\{[^}]+\} 2/);
  expect(text).toMatch(/wager_metrics_database_collection_success\{[^}]+\} 0/);
  expect(text).toMatch(/wager_metrics_sqs_collection_success\{[^}]+\} 0/);
});

test('SQL metrics distinguish lock conflicts from other transient failures', () => {
  const metrics = new OperationalMetrics();
  metrics.sqlFailure({ driverError: { code: '40P01' } }, true);
  metrics.sqlFailure({ code: 'ECONNREFUSED' }, true);
  metrics.sqlFailure({ driverError: { code: '23514' } }, false);

  const text = metrics.render();

  expect(text).toMatch(/wager_sql_lock_conflicts_total\{[^}]+\} 1/);
  expect(text).toMatch(/wager_sql_transient_failures_total\{[^}]+\} 2/);
});

test('existing messaging diagnostics feed the shared metrics registry', () => {
  const metrics = new OperationalMetrics();
  const diagnostics = new MessagingDiagnostics(() => {}, metrics);
  for (const metric of [
    'retries',
    'ackFailures',
    'dlq',
    'published',
    'pendingReferenceResolved',
  ] as const) {
    diagnostics.increment(metric);
  }

  const text = metrics.render();

  for (const name of [
    'sqs_retries_total',
    'sqs_ack_failures_total',
    'sqs_dlq_forwarded_total',
    'outbox_broker_confirmations_total',
    'reference_resolved_total',
  ]) {
    expect(text).toMatch(new RegExp('wager_' + name + '\\{[^}]+\\} 1'));
  }
});

test('financial logs share instance identity while request and processing metrics remain sanitized', () => {
  const records: Readonly<Record<string, unknown>>[] = [];
  const metrics = new OperationalMetrics();
  const diagnostics = new FinancialDiagnostics(
    (record) => records.push(record),
    metrics,
  );
  diagnostics.processing(result, {
    correlationId: 'correlation',
    walletId: 'wallet',
    providerId: 'provider',
  });
  diagnostics.httpFinished(200);
  diagnostics.duration(0.2);

  expect(records[0]).toMatchObject({
    instanceId: metrics.instanceId,
    correlationId: 'correlation',
    transactionId: result.transactionId,
  });
  expect(metrics.render()).toContain('status_class="2xx"} 1');
  expect(JSON.stringify(records)).not.toContain('amount');
});

test('metrics endpoint serves counters when collection dependencies fail', async () => {
  const source = new DataSource(databaseOptions());
  source.initialize = async () => {
    throw new Error('Unavailable');
  };
  const client = new SQSClient({
    endpoint: 'http://127.0.0.1:1',
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
  const controller = new MetricsController(
    new OperationalMetrics(),
    source,
    client,
  );
  try {
    const text = await controller.get();

    expect(text).toContain('# TYPE wager_sqs_ack_failures_total counter');
    expect(text).toMatch(
      /wager_metrics_database_collection_success\{[^}]+\} 0/,
    );
    expect(text).toMatch(/wager_metrics_sqs_collection_success\{[^}]+\} 0/);
  } finally {
    client.destroy();
  }
});
