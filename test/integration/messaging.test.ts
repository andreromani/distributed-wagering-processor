import { MessagingLifecycle } from '../../src/infrastructure/messaging/messaging-lifecycle.js';
import 'reflect-metadata';
import {
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'bun:test';
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module.js';
import { configureHttp } from '../../src/infrastructure/http/configure-http.js';
import { databaseOptions } from '../../src/infrastructure/database/options.js';
import { environment } from '../../src/infrastructure/config/environment.js';
import { workerOptions } from '../../src/infrastructure/config/worker-options.js';
import { FinancialFoundation1797000000000 } from '../../src/infrastructure/database/migrations/1797000000000-financial-foundation.js';
import { RejectedSnapshots1797000001000 } from '../../src/infrastructure/database/migrations/1797000001000-rejected-snapshots.js';
import { TypeOrmFinancialTransaction } from '../../src/infrastructure/database/repositories/typeorm-financial-transaction.js';
import { TypeOrmOutboxDeliveryStore } from '../../src/infrastructure/database/repositories/typeorm-outbox-delivery.store.js';
import { transactionCancellation } from '../../src/infrastructure/database/transaction-cancellation.js';
import { OpenWalletUseCase } from '../../src/application/use-cases/open-wallet.use-case.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerInput,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import type { FinancialTransaction } from '../../src/application/ports/financial-transaction.js';
import type { OutboxDeliveryStore } from '../../src/application/ports/outbox-delivery-store.js';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case.js';
import { FinancialApplicationError } from '../../src/application/errors/financial-application.error.js';
import { SqsTransport } from '../../src/infrastructure/messaging/sqs/sqs-transport.js';
import type {
  WagerQueue,
  WagerDelivery,
} from '../../src/infrastructure/messaging/sqs/wager-queue.js';
import {
  WagerMessageHandler,
  WAGER_CONSUMER_NAME,
} from '../../src/infrastructure/messaging/consumers/wager-message-handler.js';
import { WagerTransactionConsumer } from '../../src/infrastructure/messaging/consumers/wager-transaction.consumer.js';
import { OutboxPublisher } from '../../src/infrastructure/messaging/publishers/outbox.publisher.js';
import { MessagingDiagnostics } from '../../src/infrastructure/messaging/messaging-diagnostics.js';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/financial.types.js';

const database = 'wager_messaging_' + crypto.randomUUID().replaceAll('-', '');
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
const unit = new TypeOrmFinancialTransaction(source);
const open = new OpenWalletUseCase(unit);
const processor = new ProcessWagerTransactionUseCase(unit);
const client = new SQSClient({
  ...environment().sqs,
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 },
});
const metrics = new MessagingDiagnostics(() => {});
const active = new Set<{ stop(): Promise<void> }>();
let app: INestApplication;
let base: string;
let queueNames: { queueName: string; dlqName: string };
let options = {
  ...workerOptions({}),
  longPollSeconds: 1,
  visibilitySeconds: 1,
  maxReceives: 2,
  retryBaseSeconds: 1,
  retryMaxSeconds: 2,
  externalTimeoutMs: 1500,
  outboxRetryBaseMs: 10,
  outboxRetryMaxMs: 100,
  outboxBatchSize: 30,
};
let transport: SqsTransport;
let urls: { input: string; dead: string; events: string };

beforeAll(async () => {
  await admin.initialize();
  await admin.query('CREATE DATABASE "' + database + '"');
  await source.initialize();
  await source.runMigrations();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DataSource)
    .useValue(source)
    .compile();
  app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 60000);

beforeEach(async () => {
  // Retire fixtures of earlier, independent tests in this disposable database.
  await source.query(
    'UPDATE outbox_messages SET published_at=occurred_at WHERE published_at IS NULL',
  );
  const prefix = 'wager-test-' + crypto.randomUUID().replaceAll('-', '');
  queueNames = {
    queueName: prefix + '-in.fifo',
    dlqName: prefix + '-dead.fifo',
  };
  options = { ...options, eventQueueName: prefix + '-events.fifo' };
  const dead = await client.send(
    new CreateQueueCommand({
      QueueName: queueNames.dlqName,
      Attributes: { FifoQueue: 'true', VisibilityTimeout: '1' },
    }),
  );
  const arn = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dead.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const input = await client.send(
    new CreateQueueCommand({
      QueueName: queueNames.queueName,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '1',
        ReceiveMessageWaitTimeSeconds: '1',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: arn.Attributes?.QueueArn,
          maxReceiveCount: 2,
        }),
      },
    }),
  );
  const events = await client.send(
    new CreateQueueCommand({
      QueueName: options.eventQueueName,
      Attributes: { FifoQueue: 'true', VisibilityTimeout: '1' },
    }),
  );
  if (!dead.QueueUrl || !input.QueueUrl || !events.QueueUrl) {
    throw new Error('Queue provisioning failed');
  }
  urls = {
    input: input.QueueUrl,
    dead: dead.QueueUrl,
    events: events.QueueUrl,
  };
  transport = new SqsTransport(client, queueNames, options);
}, 15000);

afterEach(async () => {
  await Promise.all([...active].map((worker) => worker.stop()));
  active.clear();
  for (const QueueUrl of Object.values(urls ?? {})) {
    await client.send(new DeleteQueueCommand({ QueueUrl }));
  }
});

afterAll(async () => {
  if (app) {
    await app.close();
  }
  if (source.isInitialized) {
    await source.destroy();
  }
  client.destroy();
  if (admin.isInitialized) {
    if (!/^wager_messaging_[a-f0-9]{32}$/.test(database)) {
      throw new Error('Unsafe database');
    }
    await admin.query(
      'DROP DATABASE IF EXISTS "' + database + '" WITH (FORCE)',
    );
    await admin.destroy();
  }
});

function deferred<T>() {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until<T>(
  label: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 10000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(20);
  }
  throw new Error('Timed out waiting for ' + label);
}
async function wallet() {
  return open.execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
}
function payload(
  w: { id: string; playerId: string },
  kind = Kind.Bet,
  amount = '25.00',
): ProcessWagerInput {
  return {
    providerId: 'provider',
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    walletId: w.id,
    playerId: w.playerId,
    roundId: 'round',
    gameId: 'game',
    kind,
    money: { amount, currency: 'BRL' },
  };
}
function envelope(
  input: ProcessWagerInput,
  messageId: string = crypto.randomUUID(),
) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: input,
    correlationId: 'messaging-test',
  };
}
async function send(
  input: ProcessWagerInput,
  messageId?: string,
): Promise<ReturnType<typeof envelope>> {
  const body = envelope(input, messageId);
  await sendRaw(JSON.stringify(body), input.walletId);
  return body;
}
async function sendRaw(
  body: string,
  groupId: string = crypto.randomUUID(),
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: urls.input,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}
async function receive(): Promise<WagerDelivery> {
  return until('input message', async () => {
    const rows = await transport.receive(10, new AbortController().signal);
    return rows[0];
  });
}
function queue(overrides: Partial<WagerQueue> = {}): WagerQueue {
  return {
    receive: transport.receive.bind(transport),
    acknowledge: transport.acknowledge.bind(transport),
    visibility: transport.visibility.bind(transport),
    deadLetter: transport.deadLetter.bind(transport),
    verify: transport.verify.bind(transport),
    ...overrides,
  };
}
function handler(
  q: WagerQueue = transport,
  core: {
    execute(
      input: ProcessWagerInput,
    ): ReturnType<ProcessWagerTransactionUseCase['execute']>;
  } = processor,
) {
  return new WagerMessageHandler(core, q, options, metrics);
}
async function stats(walletId: string) {
  return (
    await source.query<
      {
        balance: string;
        version: number;
        wagers: string;
        ledger: string;
        outbox: string;
        inbox: string;
      }[]
    >(
      `SELECT w.balance,w.version,
 (SELECT count(*) FROM wager_transactions WHERE wallet_id=w.id) AS wagers,
 (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id=w.id) AS ledger,
 (SELECT count(*) FROM outbox_messages WHERE aggregate_id=w.id) AS outbox,
 (SELECT count(*) FROM inbox_messages) AS inbox FROM wallets w WHERE id=$1`,
      [walletId],
    )
  )[0];
}
async function reconcile(walletId: string): Promise<void> {
  const result = await app
    .get(ReconcileWalletUseCase)
    .execute(walletId, 'test');
  expect(result.consistent).toBe(true);
  expect(result.difference.amount).toBe('0.00');
}
async function empty(QueueUrl = urls.input): Promise<void> {
  await until('queue drained', async () => {
    const state = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
        ],
      }),
    );
    return state.Attributes?.ApproximateNumberOfMessages === '0' &&
      state.Attributes?.ApproximateNumberOfMessagesNotVisible === '0'
      ? true
      : undefined;
  });
}
async function readBroker(QueueUrl: string): Promise<{
  body: string;
  attributes: Record<string, { StringValue?: string }>;
}> {
  return until('broker message', async () => {
    const result = await client.send(
      new ReceiveMessageCommand({
        QueueUrl,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    const message = result.Messages?.[0];
    if (!message?.ReceiptHandle) {
      return undefined;
    }
    await client.send(
      new DeleteMessageCommand({
        QueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
    return {
      body: message.Body ?? '',
      attributes: message.MessageAttributes ?? {},
    };
  });
}
async function publishedRows(walletId: string) {
  return source.query<
    {
      id: string;
      payload: Record<string, unknown>;
      published_at: Date | null;
      attempts: number;
      next_attempt_at: Date | null;
    }[]
  >(
    'SELECT id,payload,published_at,attempts,next_attempt_at FROM outbox_messages WHERE aggregate_id=$1 ORDER BY id',
    [walletId],
  );
}

test('mandatory queues are FIFO with expected redrive, visibility and long polling', async () => {
  const config = environment();
  for (const name of [
    config.queueName,
    config.dlqName,
    config.workers.eventQueueName,
  ]) {
    const url = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    const attrs = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: url.QueueUrl,
        AttributeNames: ['All'],
      }),
    );
    expect(attrs.Attributes?.FifoQueue).toBe('true');
    if (name === config.queueName) {
      expect(attrs.Attributes?.VisibilityTimeout).toBe('30');
      expect(attrs.Attributes?.ReceiveMessageWaitTimeSeconds).toBe('20');
      expect(
        JSON.parse(attrs.Attributes?.RedrivePolicy ?? '{}'),
      ).toHaveProperty('maxReceiveCount', 5);
    }
  }
  await transport.verify();
});

test('real SQS commits wallet, ledger, inbox and outbox before ACK', async () => {
  const w = await wallet(),
    input = payload(w);
  const sent = await send(input);
  const outcome = await handler().handle(
    await receive(),
    new AbortController().signal,
  );
  expect(outcome.continueGroup).toBe(true);
  const state = await stats(w.id);
  expect(state).toMatchObject({
    balance: '75.00',
    version: 2,
    wagers: '2',
    ledger: '2',
    outbox: '4',
  });
  const inbox = await source.query(
    'SELECT message_id,consumer_name FROM inbox_messages WHERE message_id=$1',
    [sent.messageId],
  );
  expect(inbox).toEqual([
    { message_id: sent.messageId, consumer_name: WAGER_CONSUMER_NAME },
  ]);
  await empty();
  await reconcile(w.id);
});

for (const first of ['http', 'sqs']) {
  test('HTTP and SQS share idempotency with ' + first + ' first', async () => {
    const w = await wallet(),
      input = payload(w);
    const http = async () => {
      const { idempotencyKey, ...body } = input;
      const response = await fetch(base + '/wagering/transactions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    if (first === 'http') {
      await http();
    }
    await send(input);
    await handler().handle(await receive(), new AbortController().signal);
    if (first === 'sqs') {
      const result: unknown = await http();
      expect(result).toHaveProperty('idempotentReplay', true);
    }
    expect(await stats(w.id)).toMatchObject({
      balance: '75.00',
      version: 2,
      wagers: '2',
      ledger: '2',
      outbox: '4',
    });
    await empty();
    await reconcile(w.id);
  });
}

test('redelivery with a new FIFO dedup identity still has one financial effect', async () => {
  const w = await wallet(),
    input = payload(w);
  const sent = await send(input);
  await handler().handle(await receive(), new AbortController().signal);
  await send(input, sent.messageId);
  await handler().handle(await receive(), new AbortController().signal);
  expect(await stats(w.id)).toMatchObject({
    balance: '75.00',
    version: 2,
    wagers: '2',
    ledger: '2',
    outbox: '4',
  });
  expect(
    await source.query(
      'SELECT message_id FROM inbox_messages WHERE message_id=$1',
      [sent.messageId],
    ),
  ).toHaveLength(1);
  await empty();
  await reconcile(w.id);
});

test('commit before failed ACK is recovered by another handler without a second debit', async () => {
  const w = await wallet(),
    input = payload(w);
  await send(input);
  const initial = await receive();
  const failed = await handler(
    queue({
      acknowledge: async () => {
        throw new Error('crash before ACK');
      },
    }),
  ).handle(initial, new AbortController().signal);
  expect(failed.continueGroup).toBe(false);
  const committed = await stats(w.id);
  expect(committed).toMatchObject({
    balance: '75.00',
    ledger: '2',
    outbox: '4',
  });
  const again = await receive();
  expect(again.receiptHandle).not.toBe(initial.receiptHandle);
  await handler().handle(again, new AbortController().signal);
  expect(await stats(w.id)).toEqual(committed);
  await empty();
  await reconcile(w.id);
});

for (const kind of [Kind.Bet, Kind.Refund]) {
  test(
    'committed ' + kind + ' rejection or pending state is ACKed without DLQ',
    async () => {
      const w = await wallet();
      const input = payload(w, kind, kind === Kind.Bet ? '101.00' : '25.00');
      if (kind === Kind.Refund) {
        input.referenceExternalTransactionId = 'missing-bet';
      }
      await send(input);
      await handler().handle(await receive(), new AbortController().signal);
      const stored = await unit.run((context) =>
        context.transactions.findByIdempotencyKey(input.idempotencyKey),
      );
      expect(stored?.transaction.status).toBe(
        kind === Kind.Bet ? Status.Rejected : Status.PendingReference,
      );
      expect(await stats(w.id)).toMatchObject({
        balance: '100.00',
        version: 1,
        ledger: '1',
        outbox: '3',
      });
      await empty();
      await empty(urls.dead);
      await reconcile(w.id);
    },
  );
}

test('invalid JSON is forwarded intact with sanitized DLQ diagnostics', async () => {
  const before = await source.query('SELECT count(*) FROM wager_transactions');
  await sendRaw('{invalid');
  await handler().handle(await receive(), new AbortController().signal);
  const dead = await readBroker(urls.dead);
  expect(dead.body).toBe('{invalid');
  expect(dead.attributes.failureCode?.StringValue).toBe('INVALID_MESSAGE');
  expect(await source.query('SELECT count(*) FROM wager_transactions')).toEqual(
    before,
  );
  await empty();
});

test('failed DLQ publication keeps the original recoverable', async () => {
  await sendRaw('{invalid');
  await handler(
    queue({
      deadLetter: async () => {
        throw new Error('DLQ unavailable');
      },
    }),
  ).handle(await receive(), new AbortController().signal);
  await empty(urls.dead);
  await handler().handle(await receive(), new AbortController().signal);
  expect((await readBroker(urls.dead)).body).toBe('{invalid');
  await empty();
});

test('transient persistence failure changes visibility then recovers on redelivery', async () => {
  const w = await wallet(),
    input = payload(w);
  await send(input);
  const original = await receive();
  await handler(transport, {
    execute: async () => {
      throw new FinancialApplicationError('TRANSIENT_FAILURE');
    },
  }).handle(original, new AbortController().signal);
  expect(await stats(w.id)).toMatchObject({ balance: '100.00', ledger: '1' });
  const visibility = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: urls.input,
      AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  expect(visibility.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe(
    '1',
  );
  await handler().handle(await receive(), new AbortController().signal);
  expect(await stats(w.id)).toMatchObject({ balance: '75.00', ledger: '2' });
  await empty();
  await reconcile(w.id);
});

test('exhausted transient deliveries use native redrive in LocalStack', async () => {
  const w = await wallet();
  await send(payload(w));
  const unavailable = handler(transport, {
    execute: async () => {
      throw new FinancialApplicationError('TRANSIENT_FAILURE');
    },
  });
  for (let index = 1; index <= 2; index += 1) {
    const message = await receive();
    expect(message.receiveCount).toBe(index);
    await unavailable.handle(message, new AbortController().signal);
  }
  await until('native redrive', async () => {
    await transport.receive(1, new AbortController().signal);
    const attrs = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: urls.dead,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    return attrs.Attributes?.ApproximateNumberOfMessages === '1'
      ? true
      : undefined;
  });
  const dead = await readBroker(urls.dead);
  expect(JSON.parse(dead.body)).toHaveProperty(
    'type',
    'WagerTransactionRequested',
  );
  expect(await stats(w.id)).toMatchObject({ balance: '100.00', ledger: '1' });
  await reconcile(w.id);
}, 15000);

test('publisher recovers persisted events after startup and publishes original envelopes', async () => {
  const w = await wallet();
  await processor.execute(payload(w));
  const before = await publishedRows(w.id);
  const publisher = new OutboxPublisher(
    new TypeOrmOutboxDeliveryStore(source),
    transport,
    options,
    metrics,
  );
  active.add(publisher);
  publisher.start();
  await until('outbox publication', async () => {
    const rows = await publishedRows(w.id);
    return rows.every((row) => row.published_at !== null) ? true : undefined;
  });
  await publisher.stop();
  active.delete(publisher);
  const envelopes: unknown[] = [];
  for (let i = 0; i < before.length; i += 1) {
    envelopes.push(JSON.parse((await readBroker(urls.events)).body));
  }
  expect(envelopes).toHaveLength(4);
  for (const row of before) {
    expect(envelopes).toContainEqual(row.payload);
  }
  await reconcile(w.id);
});

test('two independent publishers use SKIP LOCKED while one holds a row during send', async () => {
  const w = await wallet();
  for (let i = 0; i < 3; i += 1) {
    await processor.execute(payload(w));
  }
  const before = await publishedRows(w.id);
  const secondSource = new DataSource({ ...databaseOptions(), database });
  await secondSource.initialize();
  const entered = deferred<void>(),
    release = deferred<void>();
  let held = false;
  const first = new OutboxPublisher(
    new TypeOrmOutboxDeliveryStore(source),
    {
      publish: async (message, signal) => {
        if (!held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        await transport.publish(message, signal);
      },
    },
    options,
    metrics,
  );
  const second = new OutboxPublisher(
    new TypeOrmOutboxDeliveryStore(secondSource),
    transport,
    options,
    metrics,
  );
  const one = first.publishBatch();
  try {
    await entered.promise;
    expect(await second.publishBatch()).toBe(before.length - 1);
  } finally {
    release.resolve();
    await one;
    await secondSource.destroy();
  }
  const rows = await publishedRows(w.id);
  expect(rows.every((row) => row.published_at !== null)).toBe(true);
  const ids = new Set<string>();
  for (let i = 0; i < before.length; i += 1) {
    const event: unknown = JSON.parse((await readBroker(urls.events)).body);
    expect(event).toHaveProperty('eventId');
    if (event && typeof event === 'object' && 'eventId' in event) {
      ids.add(String(event.eventId));
    }
  }
  expect(ids.size).toBe(before.length);
  await reconcile(w.id);
}, 15000);

test('crash after broker confirmation rolls back publication metadata and retries the same event ID', async () => {
  const publicationRecords: Readonly<Record<string, unknown>>[] = [];
  const publicationDiagnostics = new MessagingDiagnostics((record) => {
    publicationRecords.push(record);
  });
  const w = await wallet();
  const original = await publishedRows(w.id);
  const store = new TypeOrmOutboxDeliveryStore(source);
  const crash: OutboxDeliveryStore = {
    processNext: (now, action, signal) =>
      store.processNext(
        now,
        async (message) => {
          await action(message);
          throw new Error('crash before metadata commit');
        },
        signal,
      ),
    countPending: () => store.countPending(),
  };
  let failure: unknown;
  try {
    await new OutboxPublisher(
      crash,
      transport,
      options,
      publicationDiagnostics,
    ).publishBatch();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(
    publicationRecords.some(
      (record) =>
        record.event === 'outbox_event_published' &&
        record.stage === 'broker_confirmed',
    ),
  ).toBe(true);
  expect(
    publicationRecords.some(
      (record) => record.event === 'outbox_publication_committed',
    ),
  ).toBe(false);
  expect(
    (await publishedRows(w.id)).every((row) => row.published_at === null),
  ).toBe(true);
  await new OutboxPublisher(store, transport, options, metrics).publishBatch();
  const delivered = [];
  for (let i = 0; i < original.length; i += 1) {
    delivered.push(JSON.parse((await readBroker(urls.events)).body));
  }
  for (const row of original) {
    expect(delivered).toContainEqual(row.payload);
  }
  expect(
    (await publishedRows(w.id)).every((row) => row.published_at !== null),
  ).toBe(true);
  await reconcile(w.id);
});

test('publish failure retains attempts and nextAttemptAt then recovers the original event', async () => {
  const w = await wallet();
  const before = await publishedRows(w.id);
  let now = new Date();
  const store = new TypeOrmOutboxDeliveryStore(source);
  await new OutboxPublisher(
    store,
    {
      publish: async () => {
        throw new Error('destination unavailable');
      },
    },
    options,
    metrics,
    () => now,
  ).publishBatch();
  const failed = await publishedRows(w.id);
  expect(
    failed.every(
      (row) =>
        row.published_at === null &&
        row.attempts === 1 &&
        row.next_attempt_at !== null,
    ),
  ).toBe(true);
  now = new Date(now.getTime() + 1000);
  await new OutboxPublisher(
    store,
    transport,
    options,
    metrics,
    () => now,
  ).publishBatch();
  const recovered = await publishedRows(w.id);
  expect(recovered.map((row) => row.id)).toEqual(before.map((row) => row.id));
  expect(recovered.every((row) => row.published_at !== null)).toBe(true);
  await reconcile(w.id);
});

test('future outbox events remain ineligible until their nextAttemptAt', async () => {
  const w = await wallet();
  const now = new Date();
  await source.query(
    'UPDATE outbox_messages SET next_attempt_at=$2 WHERE aggregate_id=$1',
    [w.id, new Date(now.getTime() + 60000)],
  );
  const store = new TypeOrmOutboxDeliveryStore(source);
  expect(
    await new OutboxPublisher(
      store,
      transport,
      options,
      metrics,
      () => now,
    ).publishBatch(),
  ).toBe(0);
  expect(
    await new OutboxPublisher(
      store,
      transport,
      options,
      metrics,
      () => new Date(now.getTime() + 60001),
    ).publishBatch(),
  ).toBe(2);
  await reconcile(w.id);
});

test('consumer stops polling and drains a committed delivery before ACK', async () => {
  const w = await wallet();
  await send(payload(w));
  const entered = deferred<void>(),
    release = deferred<void>();
  const core = {
    execute: async (input: ProcessWagerInput) => {
      const result = await processor.execute(input);
      entered.resolve();
      await release.promise;
      return result;
    },
  };
  const consumer = new WagerTransactionConsumer(
    transport,
    handler(transport, core),
    options,
    metrics,
  );
  active.add(consumer);
  consumer.start();
  try {
    await entered.promise;
    const stopped = consumer.stop();
    expect(source.isInitialized).toBe(true);
    release.resolve();
    await stopped;
  } finally {
    release.resolve();
    await consumer.stop();
    active.delete(consumer);
  }
  await empty();
  expect(await stats(w.id)).toMatchObject({ balance: '75.00', ledger: '2' });
  await reconcile(w.id);
});

test('shutdown deadline aborts the financial transaction before commit and permits safe redelivery', async () => {
  const w = await wallet();
  await send(payload(w));
  const entered = deferred<void>();
  const blocking: FinancialTransaction = {
    run: (work) =>
      unit.run((context) => {
        const update = context.wallets.update.bind(context.wallets);
        context.wallets.update = async (value) => {
          await update(value);
          entered.resolve();
          const signal = transactionCancellation.getStore();
          if (!signal) {
            throw new Error('Missing worker cancellation');
          }
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          });
        };
        return work(context);
      }),
  };
  const consumer = new WagerTransactionConsumer(
    transport,
    handler(transport, new ProcessWagerTransactionUseCase(blocking)),
    { ...options, shutdownTimeoutMs: 10000 },
    metrics,
  );
  active.add(consumer);
  consumer.start();
  await entered.promise;
  await consumer.stop();
  active.delete(consumer);
  expect(await stats(w.id)).toMatchObject({
    balance: '100.00',
    version: 1,
    wagers: '1',
    ledger: '1',
    outbox: '2',
  });
  await handler().handle(await receive(), new AbortController().signal);
  expect(await stats(w.id)).toMatchObject({ balance: '75.00', ledger: '2' });
  await reconcile(w.id);
});

test('HTTP and SQS concurrent bets of 80 preserve one approval on balance 100', async () => {
  const w = await wallet();
  const sqs = payload(w, Kind.Bet, '80.00'),
    http = payload(w, Kind.Bet, '80.00');
  await send(sqs);
  const message = await receive();
  const { idempotencyKey, ...body } = http;
  const [, response] = await Promise.all([
    handler().handle(message, new AbortController().signal),
    fetch(base + '/wagering/transactions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    }),
  ]);
  expect([200, 422]).toContain(response.status);
  const statuses = await source.query<{ status: string }[]>(
    'SELECT status FROM wager_transactions WHERE wallet_id=$1 AND kind=$2',
    [w.id, 'BET'],
  );
  expect(
    statuses
      .map((row) => row.status)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  ).toEqual(['PROCESSED', 'REJECTED']);
  expect(await stats(w.id)).toMatchObject({
    balance: '20.00',
    version: 2,
    ledger: '2',
  });
  await empty();
  await reconcile(w.id);
});

test('different SQS groups progress while another wallet is locked in PostgreSQL', async () => {
  const a = await wallet(),
    b = await wallet();
  await send(payload(a));
  await send(payload(b));
  const messages: WagerDelivery[] = [];
  await until('two independent groups', async () => {
    messages.push(
      ...(await transport.receive(2, new AbortController().signal)),
    );
    return messages.length === 2 ? true : undefined;
  });
  const locked = deferred<void>(),
    release = deferred<void>();
  const lock = unit.run(async (context) => {
    await context.wallets.findByIdForUpdate(a.id);
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const consumer = new WagerTransactionConsumer(
    transport,
    handler(),
    options,
    metrics,
  );
  const work = consumer.processBatch(messages);
  try {
    await until(
      'unlocked wallet processed',
      async () => {
        const state = await stats(b.id);
        return state?.balance === '75.00' ? true : undefined;
      },
      1500,
    );
    expect((await stats(a.id))?.balance).toBe('100.00');
  } finally {
    release.resolve();
    await lock;
    await work;
  }
  await empty();
  await reconcile(a.id);
  await reconcile(b.id);
});

test('Nest lifecycle drains both workers before closing SQS and PostgreSQL', async () => {
  const w = await wallet();
  await send(payload(w));
  const secondSource = new DataSource({ ...databaseOptions(), database });
  await secondSource.initialize();
  const ownClient = new SQSClient({
    ...environment().sqs,
    maxAttempts: 1,
    requestHandler: { requestTimeout: 4000, connectionTimeout: 1000 },
  });
  let destroyed = false;
  const destroy = ownClient.destroy.bind(ownClient);
  ownClient.destroy = () => {
    destroyed = true;
    destroy();
  };
  const ownTransport = new SqsTransport(ownClient, queueNames, options);
  const entered = deferred<void>(),
    release = deferred<void>();
  const core = new ProcessWagerTransactionUseCase(
    new TypeOrmFinancialTransaction(secondSource),
  );
  const handler = new WagerMessageHandler(
    {
      execute: async (input) => {
        const result = await core.execute(input);
        entered.resolve();
        await release.promise;
        return result;
      },
    },
    ownTransport,
    options,
    metrics,
  );
  const consumer = new WagerTransactionConsumer(
    ownTransport,
    handler,
    options,
    metrics,
  );
  const publisher = new OutboxPublisher(
    new TypeOrmOutboxDeliveryStore(secondSource),
    ownTransport,
    options,
    metrics,
  );
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DataSource)
    .useValue(secondSource)
    .overrideProvider(SQSClient)
    .useValue(ownClient)
    .overrideProvider(MessagingLifecycle)
    .useValue(
      new MessagingLifecycle(consumer, publisher, {
        ...options,
        consumerEnabled: true,
        publisherEnabled: true,
      }),
    )
    .compile();
  const nested = module.createNestApplication({ logger: false });
  try {
    await nested.init();
    await entered.promise;
    const closing = nested.close();
    expect(secondSource.isInitialized).toBe(true);
    expect(destroyed).toBe(false);
    release.resolve();
    await closing;
    expect(secondSource.isInitialized).toBe(false);
    expect(destroyed).toBe(true);
  } finally {
    release.resolve();
    await nested.close();
    if (secondSource.isInitialized) {
      await secondSource.destroy();
    }
    ownClient.destroy();
  }
  await empty();
  await reconcile(w.id);
}, 20000);

test('compiled Bun bootstrap enables both workers and handles the SIGTERM lifecycle', async () => {
  const w = await wallet();
  await send(payload(w));
  let ready = false;
  let code: number | undefined;
  const script = `process.on('message', message => { if (message === 'shutdown') { process.emit('SIGTERM','SIGTERM'); } }); import('./dist/main.js').then(() => process.send?.('ready')).catch(error => { console.error(error); process.exit(1); });`;
  const child = Bun.spawn([process.execPath, '--eval', script], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      POSTGRES_DB: database,
      HTTP_ENABLED: 'false',
      SQS_CONSUMER_ENABLED: 'true',
      OUTBOX_PUBLISHER_ENABLED: 'true',
      SQS_QUEUE_NAME: queueNames.queueName,
      SQS_DLQ_NAME: queueNames.dlqName,
      SQS_EVENTS_QUEUE_NAME: options.eventQueueName,
      SQS_MAX_RECEIVE_COUNT: '2',
      SQS_VISIBILITY_TIMEOUT: '5',
      SQS_LONG_POLL_SECONDS: '1',
      WORKER_EXTERNAL_TIMEOUT_MS: '1500',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    ipc: (message: unknown) => {
      if (message === 'ready') {
        ready = true;
      }
    },
  });
  const stdout = new Response(child.stdout).text(),
    stderr = new Response(child.stderr).text();
  const exited = child.exited.then((value) => {
    code = value;
    return value;
  });
  try {
    await until(
      'compiled worker startup',
      async () => {
        if (code !== undefined) {
          throw new Error('Compiled worker exited before startup: ' + code);
        }
        return ready ? true : undefined;
      },
      30000,
    );
    await until('compiled consumer commit', async () => {
      const state = await stats(w.id);
      return state?.balance === '75.00' ? true : undefined;
    });
    await until('compiled outbox publisher', async () => {
      const rows = await publishedRows(w.id);
      return rows.length === 4 && rows.every((row) => row.published_at !== null)
        ? true
        : undefined;
    });
    await empty();
    child.send('shutdown');
    await until(
      'compiled graceful shutdown',
      async () => (code === undefined ? undefined : true),
      15000,
    );
    const output = await stdout;
    expect(output).toContain('consumer_stopped');
    expect(output).toContain('outbox_publisher_stopped');
    expect(await stats(w.id)).toMatchObject({ balance: '75.00', ledger: '2' });
    await reconcile(w.id);
  } catch (error) {
    child.kill('SIGKILL');
    await exited;
    throw new Error(
      String(error) +
        '\nSTDOUT\n' +
        (await stdout) +
        '\nSTDERR\n' +
        (await stderr),
    );
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    await exited;
    await stdout;
    await stderr;
  }
}, 60000);

test('bounded visibility renewal protects an in-flight delivery beyond its original timeout', async () => {
  const w = await wallet();
  await send(payload(w));
  const message = await receive();
  const renewed = deferred<void>(),
    release = deferred<void>();
  let renewals = 0;
  const renewing = queue({
    visibility: async (value, seconds) => {
      await transport.visibility(value, seconds);
      if (seconds === options.visibilitySeconds && ++renewals === 4) {
        renewed.resolve();
      }
    },
  });
  const slow = {
    execute: async (input: ProcessWagerInput) => {
      await release.promise;
      return processor.execute(input);
    },
  };
  const consumer = new WagerTransactionConsumer(
    renewing,
    handler(renewing, slow),
    options,
    metrics,
  );
  const work = consumer.processBatch([message]);
  try {
    await renewed.promise;
    expect(await transport.receive(1, new AbortController().signal)).toEqual(
      [],
    );
  } finally {
    release.resolve();
    await work;
  }
  expect(renewals).toBeGreaterThanOrEqual(4);
  await empty();
  await reconcile(w.id);
}, 15000);

test('divergent business message identity reaches DLQ without another financial effect', async () => {
  const w = await wallet(),
    input = payload(w);
  const original = await send(input);
  await handler().handle(await receive(), new AbortController().signal);
  const before = await stats(w.id);
  const receipt = await source.query(
    'SELECT * FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2',
    [WAGER_CONSUMER_NAME, original.messageId],
  );
  await send(
    { ...input, money: { amount: '30.00', currency: 'BRL' } },
    original.messageId,
  );
  await handler().handle(await receive(), new AbortController().signal);
  const dead = await readBroker(urls.dead);
  expect(dead.attributes.failureCode?.StringValue).toBe('INBOX_CONFLICT');
  expect(await stats(w.id)).toEqual(before);
  expect(
    await source.query(
      'SELECT * FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2',
      [WAGER_CONSUMER_NAME, original.messageId],
    ),
  ).toEqual(receipt);
  await empty();
  await reconcile(w.id);
});

test('HTTP test applications do not start workers even when development flags are enabled', async () => {
  const previousConsumer = process.env.SQS_CONSUMER_ENABLED;
  const previousPublisher = process.env.OUTBOX_PUBLISHER_ENABLED;
  const previousMode = process.env.NODE_ENV;
  const separate = new DataSource({ ...databaseOptions(), database });
  let starts = 0;
  let nested: INestApplication | undefined;
  try {
    process.env.NODE_ENV = 'test';
    process.env.SQS_CONSUMER_ENABLED = 'true';
    process.env.OUTBOX_PUBLISHER_ENABLED = 'true';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(separate)
      .overrideProvider(WagerTransactionConsumer)
      .useValue({
        start: () => {
          starts += 1;
        },
        stop: async () => {},
      })
      .overrideProvider(OutboxPublisher)
      .useValue({
        start: () => {
          starts += 1;
        },
        stop: async () => {},
      })
      .compile();
    nested = module.createNestApplication({ logger: false });
    await nested.init();
    expect(starts).toBe(0);
  } finally {
    if (nested) {
      await nested.close();
    }
    if (separate.isInitialized) {
      await separate.destroy();
    }
    if (previousConsumer === undefined) {
      delete process.env.SQS_CONSUMER_ENABLED;
    } else {
      process.env.SQS_CONSUMER_ENABLED = previousConsumer;
    }
    if (previousPublisher === undefined) {
      delete process.env.OUTBOX_PUBLISHER_ENABLED;
    } else {
      process.env.OUTBOX_PUBLISHER_ENABLED = previousPublisher;
    }
    if (previousMode === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousMode;
    }
  }
});
