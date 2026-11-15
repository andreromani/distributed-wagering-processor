import 'reflect-metadata';
import { afterEach, expect, test } from 'bun:test';
import { JsonLog } from '../../src/infrastructure/observability/json-log.js';
import { ApplicationLogger } from '../../src/infrastructure/observability/application-logger.js';
import { FinancialDiagnostics } from '../../src/infrastructure/http/financial-diagnostics.js';
import { MessagingDiagnostics } from '../../src/infrastructure/messaging/messaging-diagnostics.js';
import { logLevel } from '../../src/infrastructure/config/log-level.js';
import { environment } from '../../src/infrastructure/config/environment.js';
import { withFinancialRetry } from '../../src/application/services/financial-retry.js';
import { PersistenceError } from '../../src/application/ports/persistence.error.js';
import { OpenWalletUseCase } from '../../src/application/use-cases/open-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import { MemoryFinancialTransaction } from '../support/memory-financial-transaction.js';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../../src/domain/financial.types.js';
import { OutboxMessage } from '../../src/domain/entities/outbox-message.js';
import { OutboxPublisher } from '../../src/infrastructure/messaging/publishers/outbox.publisher.js';
import { workerOptions } from '../../src/infrastructure/config/worker-options.js';

const originalLevel = process.env.LOG_LEVEL;
afterEach(() => {
  if (originalLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = originalLevel;
  }
});

test('log configuration defaults, case normalization and invalid values are explicit', () => {
  expect(logLevel({})).toBe('info');
  expect(logLevel({ LOG_LEVEL: 'DEBUG' })).toBe('debug');
  for (const value of ['', 'trace', ' info ', 'off']) {
    expect(() => logLevel({ LOG_LEVEL: value })).toThrow('Invalid LOG_LEVEL');
    expect(() => environment({ ...process.env, LOG_LEVEL: value })).toThrow(
      'Invalid LOG_LEVEL',
    );
  }
});

for (const [level, count] of [
  ['debug', 4],
  ['info', 3],
  ['warn', 2],
  ['error', 1],
] as const) {
  test('JSON and all diagnostic mechanisms filter at ' + level, () => {
    process.env.LOG_LEVEL = level;
    const records: Readonly<Record<string, unknown>>[] = [];
    const sink = (record: Readonly<Record<string, unknown>>): void => {
      records.push(record);
    };
    const json = new JsonLog(sink);
    for (const item of ['debug', 'info', 'warn', 'error'] as const) {
      json.emit(item, 'sample');
    }
    expect(records).toHaveLength(count);
    for (const record of records) {
      expect(record.timestamp).toBeString();
      expect(new Date(String(record.timestamp)).toISOString()).toBe(
        String(record.timestamp),
      );
      expect(record.instanceId).toBeString();
      expect(record.event).toBe('sample');
    }
    records.length = 0;
    const nest = new ApplicationLogger(json);
    nest.debug();
    nest.log('safe');
    nest.warn('safe');
    nest.error();
    expect(records).toHaveLength(count);
    records.length = 0;
    const http = new FinancialDiagnostics(sink);
    http.record({ event: 'detail', level: 'debug' });
    http.record({ event: 'result' });
    http.record({ event: 'conflict', level: 'warn' });
    http.record({ event: 'failure', level: 'error' });
    expect(records).toHaveLength(count);
    records.length = 0;
    const messaging = new MessagingDiagnostics(sink);
    messaging.event('message_received');
    messaging.event('message_acknowledged');
    messaging.event('message_retry');
    messaging.event('message_dead_lettered', {
      failureCode: 'PERMANENT_FAILURE',
    });
    expect(records).toHaveLength(count);
  });
}

test('sink and serialization failures cannot escape diagnostics or expose arbitrary objects', () => {
  const records: Readonly<Record<string, unknown>>[] = [];
  const log = new JsonLog((record) => {
    records.push(record);
  });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  log.emit('info', 'safe', {
    payload: circular,
    password: 'secret',
    token: 'secret',
    money: { amount: '1.00' },
    error: new Error('SQL secret'),
    walletId: 'wallet',
  });
  expect(JSON.stringify(records)).not.toMatch(
    /secret|amount|payload|password|token|SQL/,
  );
  expect(records[0]?.walletId).toBe('wallet');
  const brokenFields = Object.defineProperty({}, 'walletId', {
    enumerable: true,
    get: () => {
      throw new Error('serialization input failed');
    },
  });
  expect(() => log.emit('info', 'safe', brokenFields)).not.toThrow();
  const throwing = (): never => {
    throw new Error('sink unavailable');
  };
  expect(() =>
    new ApplicationLogger(new JsonLog(throwing)).error(),
  ).not.toThrow();
  expect(() =>
    new FinancialDiagnostics(throwing).record({ event: 'safe' }),
  ).not.toThrow();
  expect(() =>
    new MessagingDiagnostics(throwing).event('message_acknowledged'),
  ).not.toThrow();
});

test('SQL retry records actual attempts and scheduled delays without changing policy', async () => {
  const events: { event: string; fields: Readonly<Record<string, unknown>> }[] =
    [];
  const delays: number[] = [];
  const result = await withFinancialRetry(
    async (attempt) => {
      if (attempt < 3) {
        throw new PersistenceError('transient');
      }
      return 42;
    },
    'operation',
    async (ms) => {
      delays.push(ms);
    },
    {
      observer: {
        record: (event, fields) => {
          events.push({ event, fields });
        },
      },
      fields: { operationId: 'operation' },
    },
  );
  expect(result).toBe(42);
  expect(delays).toEqual([25, 50]);
  expect(
    events
      .filter((item) => item.event === 'financial_attempt_started')
      .map((item) => item.fields.sqlAttempt),
  ).toEqual([1, 2, 3]);
  expect(
    events.filter((item) => item.event === 'financial_retry_scheduled'),
  ).toHaveLength(2);
});

test('a failing application observer does not affect opening, BET, replay or rejection', async () => {
  const memory = new MemoryFinancialTransaction();
  const attempts: Readonly<Record<string, unknown>>[] = [];
  const observer = {
    record: (
      event: string,
      fields: Readonly<Record<string, unknown>>,
    ): never => {
      attempts.push({ event, ...fields });
      throw new Error('observer failed');
    },
  };
  const opener = new OpenWalletUseCase(memory, undefined, observer);
  const zero = await opener.execute({
    playerId: 'zero',
    initialBalance: { amount: '0.00', currency: 'BRL' },
  });
  expect(zero.balance.amount).toBe('0.00');
  expect(attempts[0]?.kind).toBeUndefined();
  const wallet = await opener.execute({
    playerId: 'player',
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const process = new ProcessWagerTransactionUseCase(
    memory,
    undefined,
    undefined,
    observer,
  );
  expect(attempts.some((record) => record.kind === 'OPENING')).toBe(true);
  const input = {
    playerId: 'player',
    walletId: wallet.id,
    providerId: 'provider',
    externalTransactionId: 'bet',
    idempotencyKey: 'key',
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
  };
  const first = await process.execute({ ...input, correlationId: 'first' });
  const replay = await process.execute({ ...input, correlationId: 'second' });
  expect(first.status).toBe(Status.Processed);
  expect(replay.transactionId).toBe(first.transactionId);
  expect(replay.idempotentReplay).toBe(true);
  const rejected = await process.execute({
    ...input,
    idempotencyKey: 'other',
    externalTransactionId: 'other',
    money: { amount: '1000.00', currency: 'BRL' },
  });
  expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
});

for (const failCommit of [false, true]) {
  test(
    'outbox broker confirmation and metadata commit remain distinct: ' +
      failCommit,
    async () => {
      process.env.LOG_LEVEL = 'info';
      const records: Readonly<Record<string, unknown>>[] = [];
      const message = OutboxMessage.rehydrate({
        id: crypto.randomUUID(),
        aggregateId: crypto.randomUUID(),
        eventType: 'WalletBalanceChanged',
        payload: { correlationId: 'original', data: { transactionId: 'tx' } },
        occurredAt: new Date(),
        attempts: 0,
      });
      let selected = false;
      const publisher = new OutboxPublisher(
        {
          processNext: async (_now, action) => {
            if (selected) {
              return false;
            }
            selected = true;
            await action(message);
            expect(
              records.some(
                (item) => item.event === 'outbox_publication_committed',
              ),
            ).toBe(false);
            if (failCommit) {
              throw new Error('metadata commit failed');
            }
            return true;
          },
          countPending: async () => 0,
        },
        { publish: async () => {} },
        workerOptions({}),
        new MessagingDiagnostics((record) => {
          records.push(record);
        }),
      );
      if (failCommit) {
        const failure = await publisher.publishBatch().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
      } else {
        await publisher.publishBatch();
      }
      expect(
        records.find((item) => item.event === 'outbox_event_published'),
      ).toMatchObject({
        stage: 'broker_confirmed',
        correlationId: 'original',
        transactionId: 'tx',
      });
      expect(
        records.filter((item) => item.event === 'outbox_publication_committed'),
      ).toHaveLength(failCommit ? 0 : 1);
    },
  );
}
