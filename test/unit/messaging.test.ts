import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { workerOptions } from '../../src/infrastructure/config/worker-options.js';
import { parseWagerMessage } from '../../src/infrastructure/messaging/consumers/parse-wager-message.js';
import { classifyMessageError } from '../../src/infrastructure/messaging/consumers/message-error-classifier.js';
import {
  WagerMessageHandler,
  WAGER_CONSUMER_NAME,
} from '../../src/infrastructure/messaging/consumers/wager-message-handler.js';
import { WagerTransactionConsumer } from '../../src/infrastructure/messaging/consumers/wager-transaction.consumer.js';
import { MessageLease } from '../../src/infrastructure/messaging/consumers/message-lease.js';
import { OutboxPublisher } from '../../src/infrastructure/messaging/publishers/outbox.publisher.js';
import { retryDelay } from '../../src/infrastructure/messaging/retry-delay.js';
import { MessagingDiagnostics } from '../../src/infrastructure/messaging/messaging-diagnostics.js';
import { FinancialApplicationError } from '../../src/application/errors/financial-application.error.js';
import type {
  ProcessWagerInput,
  ProcessWagerResult,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import { WagerTransactionStatus as Status } from '../../src/domain/financial.types.js';
import type {
  WagerQueue,
  WagerDelivery,
} from '../../src/infrastructure/messaging/sqs/wager-queue.js';
import { OutboxMessage } from '../../src/domain/entities/outbox-message.js';
import { SqsTransport } from '../../src/infrastructure/messaging/sqs/sqs-transport.js';
import { SQSClient } from '@aws-sdk/client-sqs';

const options = workerOptions({});
const id = '0192f291-27dd-7d3f-8071-5f8685deef37';
const envelope = {
  messageId: 'business-message',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-11-13T12:00:00.000Z',
  data: {
    providerId: 'provider',
    externalTransactionId: 'bet',
    idempotencyKey: 'key',
    walletId: id,
    playerId: id,
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};
const delivery: WagerDelivery = {
  body: JSON.stringify(envelope),
  sqsMessageId: 'broker-id',
  receiptHandle: 'current-receipt',
  groupId: id,
  receiveCount: 1,
};
const result: ProcessWagerResult = {
  transactionId: id,
  status: Status.Processed,
  createdAt: envelope.occurredAt,
  idempotentReplay: false,
  canAcknowledge: true,
};
const signal = () => new AbortController().signal;
const silent = () => new MessagingDiagnostics(() => {});
function queueFixture() {
  const acks: WagerDelivery[] = [],
    vis: { message: WagerDelivery; seconds: number }[] = [],
    dlq: { message: WagerDelivery; code: string }[] = [];
  const queue: WagerQueue = {
    receive: async () => [],
    acknowledge: async (message) => {
      acks.push(message);
    },
    visibility: async (message, seconds) => {
      vis.push({ message, seconds });
    },
    deadLetter: async (message, code) => {
      dlq.push({ message, code });
    },
  };
  return { queue, acks, vis, dlq };
}
async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('Expected failure');
}
function deferred<T>() {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('message validation preserves business identity, exact money and optional correlation', async () => {
  const value = await parseWagerMessage(
    JSON.stringify({
      ...envelope,
      correlationId: 'correlation',
      causationId: 'cause',
      data: {
        ...envelope.data,
        kind: 'WIN',
        referenceExternalTransactionId: 'original',
      },
    }),
  );
  expect(value.messageId).toBe('business-message');
  expect(value.data.money.amount).toBe('25.00');
  expect(value.data.referenceExternalTransactionId).toBe('original');
  expect(value.correlationId).toBe('correlation');
});
for (const change of [
  { type: 'Other' },
  { messageId: undefined },
  { messageId: '' },
  { occurredAt: '2026-02-30T12:00:00Z' },
  { data: [] },
  { data: { ...envelope.data, idempotencyKey: undefined } },
  { data: { ...envelope.data, money: { amount: 25, currency: 'BRL' } } },
  { data: { ...envelope.data, kind: 'OPENING' } },
  { data: { ...envelope.data, providerId: 'internal' } },
  { data: { ...envelope.data, idempotencyKey: 'opening:internal' } },
  { data: { ...envelope.data, walletId: 'bad' } },
  { data: { ...envelope.data, kind: 'REFUND' } },
  { correlationId: 'invalid space' },
  { extra: true },
]) {
  test(
    'message rejects invalid structure ' + JSON.stringify(change),
    async () => {
      expect(
        await failure(
          parseWagerMessage(JSON.stringify({ ...envelope, ...change })),
        ),
      ).toHaveProperty('name', 'InvalidWagerMessageError');
    },
  );
}
for (const body of ['{', 'null', '[]', '"text"', 'x'.repeat(262145)]) {
  test('message rejects invalid JSON/body length ' + body.length, async () => {
    expect(await failure(parseWagerMessage(body))).toHaveProperty(
      'name',
      'InvalidWagerMessageError',
    );
  });
}
for (const status of [
  Status.Processed,
  Status.Rejected,
  Status.PendingReference,
]) {
  test(
    'handler ACKs committed ' +
      status +
      ' with the current receipt and stable inbox identity',
    async () => {
      const q = queueFixture();
      let input: ProcessWagerInput | undefined;
      const handler = new WagerMessageHandler(
        {
          execute: async (value) => {
            input = value;
            return { ...result, status, idempotentReplay: true };
          },
        },
        q.queue,
        options,
        silent(),
      );
      const outcome = await handler.handle(delivery, signal());
      expect(outcome.continueGroup).toBe(true);
      expect(q.acks).toEqual([delivery]);
      expect(input?.inbox).toEqual({
        consumerName: WAGER_CONSUMER_NAME,
        messageId: 'business-message',
      });
      expect(input?.causationId).toBe('business-message');
      expect(q.dlq).toHaveLength(0);
    },
  );
}

test('handler waits for confirmed commit before ACK', async () => {
  const q = queueFixture(),
    entered = deferred<void>(),
    commit = deferred<ProcessWagerResult>();
  const handler = new WagerMessageHandler(
    {
      execute: async () => {
        entered.resolve();
        return commit.promise;
      },
    },
    q.queue,
    options,
    silent(),
  );
  const work = handler.handle(delivery, signal());
  await entered.promise;
  expect(q.acks).toHaveLength(0);
  commit.resolve(result);
  await work;
  expect(q.acks).toHaveLength(1);
});

for (const code of ['TRANSIENT_FAILURE', 'WALLET_NOT_FOUND'] as const) {
  test('transient ' + code + ' schedules visibility without ACK', async () => {
    const q = queueFixture();
    const handler = new WagerMessageHandler(
      {
        execute: async () => {
          throw new FinancialApplicationError(code);
        },
      },
      q.queue,
      options,
      silent(),
    );
    const outcome = await handler.handle(
      { ...delivery, receiveCount: 3 },
      signal(),
    );
    expect(outcome).toEqual({ continueGroup: false, retrySeconds: 4 });
    expect(q.acks).toHaveLength(0);
    expect(q.dlq).toHaveLength(0);
  });
}
for (const code of [
  'INVALID_INPUT',
  'CONTEXT_MISMATCH',
  'IDEMPOTENCY_CONFLICT',
  'EXTERNAL_IDENTITY_CONFLICT',
  'INBOX_CONFLICT',
  'WALLET_CONFLICT',
  'TRANSACTION_NOT_FOUND',
  'PERMANENT_FAILURE',
] as const) {
  test('permanent ' + code + ' sends DLQ before ACK', async () => {
    const q = queueFixture();
    const order: string[] = [];
    q.queue.deadLetter = async () => {
      order.push('dlq');
    };
    q.queue.acknowledge = async () => {
      order.push('ack');
    };
    const handler = new WagerMessageHandler(
      {
        execute: async () => {
          throw new FinancialApplicationError(code);
        },
      },
      q.queue,
      options,
      silent(),
    );
    await handler.handle(delivery, signal());
    expect(order).toEqual(['dlq', 'ack']);
  });
}

test('ACK failure after commit is retried without an artificial financial rejection', async () => {
  const q = queueFixture(),
    diagnostics = silent();
  let executions = 0;
  q.queue.acknowledge = async () => {
    throw new Error('broker unavailable');
  };
  const handler = new WagerMessageHandler(
    {
      execute: async () => {
        executions += 1;
        return result;
      },
    },
    q.queue,
    options,
    diagnostics,
  );
  const outcome = await handler.handle(delivery, signal());
  expect(executions).toBe(1);
  expect(outcome.continueGroup).toBe(false);
  expect(q.dlq).toHaveLength(0);
  expect(diagnostics.snapshot().ackFailures).toBe(1);
});

test('DLQ send failure preserves the original and terminal FAILED uses DLQ', async () => {
  const q = queueFixture();
  q.queue.deadLetter = async () => {
    throw new Error('down');
  };
  await new WagerMessageHandler(
    { execute: async () => result },
    q.queue,
    options,
    silent(),
  ).handle({ ...delivery, body: 'invalid' }, signal());
  expect(q.acks).toHaveLength(0);
  const second = queueFixture();
  await new WagerMessageHandler(
    { execute: async () => ({ ...result, status: Status.Failed }) },
    second.queue,
    options,
    silent(),
  ).handle(delivery, signal());
  expect(second.dlq[0]?.code).toBe('TERMINAL_FAILED');
  expect(second.acks).toHaveLength(1);
});

test('unknown and exhausted failures rely on native redrive with capped backoff', async () => {
  const q = queueFixture(),
    metrics = silent();
  const handler = new WagerMessageHandler(
    {
      execute: async () => {
        throw new Error('unknown');
      },
    },
    q.queue,
    options,
    metrics,
  );
  await handler.handle({ ...delivery, receiveCount: 5 }, signal());
  expect(metrics.snapshot().exhausted).toBe(1);
  expect(q.dlq).toHaveLength(0);
  expect(q.acks).toHaveLength(0);
  expect(retryDelay(100, 1, 60)).toBe(60);
  expect(classifyMessageError(new Error('SQL secret'))).toEqual({
    kind: 'transient',
    code: 'UNCLASSIFIED_FAILURE',
  });
});

test('consumer preserves FIFO order, stops a failed group and allows parallel groups', async () => {
  const q = queueFixture(),
    entered = deferred<void>(),
    release = deferred<ProcessWagerResult>();
  const seen: string[] = [];
  const bEntered = deferred<void>();
  const process = {
    execute: async (input: ProcessWagerInput) => {
      seen.push(input.externalTransactionId);
      if (input.externalTransactionId === 'b1') {
        bEntered.resolve();
      }
      if (input.externalTransactionId === 'a1') {
        entered.resolve();
        return release.promise;
      }
      return result;
    },
  };
  const consumer = new WagerTransactionConsumer(
    q.queue,
    new WagerMessageHandler(process, q.queue, options, silent()),
    options,
    silent(),
  );
  const message = (name: string, groupId: string): WagerDelivery => ({
    ...delivery,
    groupId,
    sqsMessageId: name,
    receiptHandle: name,
    body: JSON.stringify({
      ...envelope,
      messageId: name,
      data: { ...envelope.data, externalTransactionId: name },
    }),
  });
  const work = consumer.processBatch([
    message('a1', 'a'),
    message('a2', 'a'),
    message('b1', 'b'),
  ]);
  await entered.promise;
  await bEntered.promise;
  expect(seen).not.toContain('a2');
  release.resolve(result);
  await work;
  expect(seen.indexOf('a2')).toBeGreaterThan(seen.indexOf('a1'));
  expect(seen).toContain('b1');
  const failing = {
    execute: async () => {
      throw new FinancialApplicationError('TRANSIENT_FAILURE');
    },
  };
  const blocked = new WagerTransactionConsumer(
    q.queue,
    new WagerMessageHandler(failing, q.queue, options, silent()),
    options,
    silent(),
  );
  const before = q.vis.length;
  await blocked.processBatch([message('a1', 'a'), message('a2', 'a')]);
  expect(q.vis.slice(before).map((item) => item.seconds)).toEqual([1, 2]);
});

test('consumer concurrency is bounded and shutdown cancels new polls and drains work', async () => {
  const q = queueFixture(),
    entered = deferred<void>(),
    release = deferred<ProcessWagerResult>();
  let polls = 0;
  q.queue.receive = async (_maximum, abort) => {
    polls += 1;
    if (polls === 1) {
      return [delivery];
    }
    return new Promise((resolve) =>
      abort.addEventListener('abort', () => resolve([]), { once: true }),
    );
  };
  const consumer = new WagerTransactionConsumer(
    q.queue,
    new WagerMessageHandler(
      {
        execute: async () => {
          entered.resolve();
          return release.promise;
        },
      },
      q.queue,
      options,
      silent(),
    ),
    options,
    silent(),
  );
  consumer.start();
  await entered.promise;
  const stopping = consumer.stop();
  expect(q.acks).toHaveLength(0);
  release.resolve(result);
  await stopping;
  expect(q.acks).toHaveLength(1);
  expect(polls).toBe(1);
});

test('message lease cancels renewal timers when closed', async () => {
  const q = queueFixture();
  const lease = new MessageLease(
    delivery,
    q.queue,
    options,
    silent(),
    signal(),
  );
  await lease.close();
  expect(lease.signal.aborted).toBe(false);
  expect(q.vis).toHaveLength(0);
});

function outbox(): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: 'event-id',
    aggregateId: id,
    eventType: 'WagerTransactionProcessed',
    payload: {
      eventId: 'event-id',
      aggregateId: id,
      version: 1,
      data: { money: { amount: '25.00', currency: 'BRL' } },
    },
    occurredAt: new Date(envelope.occurredAt),
    attempts: 0,
  });
}

test('outbox marks success only after broker confirmation and retains the persisted payload', async () => {
  const message = outbox(),
    accepted = deferred<void>(),
    entered = deferred<void>();
  let called = false;
  const publisher = new OutboxPublisher(
    {
      processNext: async (_now, action) => {
        if (called) {
          return false;
        }
        called = true;
        await action(message);
        return true;
      },
      countPending: async () => 0,
    },
    {
      publish: async (value) => {
        expect(value.payload).toEqual(message.payload);
        entered.resolve();
        await accepted.promise;
      },
    },
    options,
    silent(),
  );
  const work = publisher.publishBatch();
  await entered.promise;
  expect(message.publishedAt).toBeUndefined();
  accepted.resolve();
  await work;
  expect(message.publishedAt).toBeInstanceOf(Date);
  expect(message.id).toBe('event-id');
});

test('outbox failure stores attempts and bounded nextAttemptAt without publication', async () => {
  const message = outbox(),
    now = new Date(envelope.occurredAt);
  let called = false;
  const publisher = new OutboxPublisher(
    {
      processNext: async (_now, action) => {
        if (called) {
          return false;
        }
        called = true;
        await action(message);
        return true;
      },
      countPending: async () => 1,
    },
    {
      publish: async () => {
        throw new Error('unavailable');
      },
    },
    options,
    silent(),
    () => now,
  );
  await publisher.publishBatch();
  expect(message.attempts).toBe(1);
  expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 1000);
  expect(message.publishedAt).toBeUndefined();
  expect(message.isDue(now)).toBe(false);
  expect(message.isDue(new Date(now.getTime() + 1000))).toBe(true);
});

test('SQS event adapter uses stable event and aggregate IDs and the original envelope', async () => {
  const commands: unknown[] = [];
  const client = new SQSClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const transport = new SqsTransport(
    client,
    { queueName: 'input.fifo', dlqName: 'dead.fifo' },
    options,
  );
  client.send = async (command: unknown) => {
    commands.push(command);
    return commands.length === 1
      ? { QueueUrl: 'http://localhost/events' }
      : { MessageId: 'sent' };
  };
  await transport.publish(outbox());
  expect(commands[1]).toHaveProperty('input.MessageGroupId', id);
  expect(commands[1]).toHaveProperty(
    'input.MessageDeduplicationId',
    'event-id',
  );
  expect(commands[1]).toHaveProperty(
    'input.MessageBody',
    JSON.stringify(outbox().payload),
  );
  client.destroy();
});

for (const [name, value] of [
  ['SQS_BATCH_SIZE', '11'],
  ['SQS_CONSUMER_ENABLED', 'yes'],
  ['SQS_LONG_POLL_SECONDS', '21'],
  ['WORKER_PROCESSING_TIMEOUT_MS', '30001'],
  ['OUTBOX_RETRY_BASE_MS', '9999999'],
]) {
  test('worker configuration rejects ' + name, () => {
    expect(() => workerOptions({ [name as string]: value })).toThrow();
  });
}

test('visibility renewal failure aborts processing and cancels all lease timers', async () => {
  const q = queueFixture(),
    metrics = silent();
  let renew = (): void => {};
  let expire = (): void => {};
  let cancelled = 0;
  q.queue.visibility = async () => {
    throw new Error('unavailable');
  };
  const lease = new MessageLease(
    delivery,
    q.queue,
    options,
    metrics,
    signal(),
    {
      deadline: (callback) => {
        expire = callback;
        return () => {
          cancelled += 1;
        };
      },
      interval: (callback) => {
        renew = callback;
        return () => {
          cancelled += 1;
        };
      },
    },
  );
  renew();
  await lease.close();
  expect(lease.signal.aborted).toBe(true);
  expect(metrics.snapshot().visibilityFailures).toBe(1);
  expect(cancelled).toBe(2);
  expire();
  expect(lease.signal.aborted).toBe(true);
});

test('consumer bounds parallel groups to configured capacity', async () => {
  const q = queueFixture(),
    ready = deferred<void>(),
    release = deferred<void>();
  let active = 0,
    peak = 0;
  const handler = new WagerMessageHandler(
    {
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        if (active === 2) {
          ready.resolve();
        }
        await release.promise;
        active -= 1;
        return result;
      },
    },
    q.queue,
    options,
    silent(),
  );
  const consumer = new WagerTransactionConsumer(
    q.queue,
    handler,
    { ...options, concurrency: 2 },
    silent(),
  );
  const work = consumer.processBatch(
    Array.from({ length: 6 }, (_, index) => ({
      ...delivery,
      groupId: 'g' + index,
    })),
  );
  await ready.promise;
  expect(peak).toBe(2);
  release.resolve();
  await work;
  expect(peak).toBe(2);
  expect(q.acks).toHaveLength(6);
});

test('outbox handles each event result independently and drains during shutdown', async () => {
  const first = outbox(),
    second = outbox();
  let index = 0;
  const publisher = new OutboxPublisher(
    {
      processNext: async (_now, action) => {
        const message = [first, second][index++];
        if (!message) {
          return false;
        }
        await action(message);
        return true;
      },
      countPending: async () => 1,
    },
    {
      publish: async () => {
        if (index === 2) {
          throw new Error('failure');
        }
      },
    },
    options,
    silent(),
  );
  await publisher.publishBatch();
  expect(first.publishedAt).toBeInstanceOf(Date);
  expect(second.publishedAt).toBeUndefined();
  expect(second.attempts).toBe(1);
  const entered = deferred<void>(),
    release = deferred<void>();
  let selected = false;
  const running = new OutboxPublisher(
    {
      processNext: async (_now, action) => {
        if (selected) {
          return false;
        }
        selected = true;
        await action(outbox());
        return true;
      },
      countPending: async () => 0,
    },
    {
      publish: async () => {
        entered.resolve();
        await release.promise;
      },
    },
    options,
    silent(),
  );
  running.start();
  await entered.promise;
  const stopped = running.stop();
  release.resolve();
  await stopped;
  expect(selected).toBe(true);
});

test('outbox database outages back off without losing events and shutdown cancels the wait', async () => {
  const waiting = deferred<void>();
  const delays: number[] = [];
  const publisher = new OutboxPublisher(
    {
      processNext: async () => {
        throw new Error('database unavailable');
      },
      countPending: async () => 1,
    },
    {
      publish: async () => {
        throw new Error('should not publish');
      },
    },
    options,
    silent(),
    () => new Date(),
    async (milliseconds, abort) => {
      delays.push(milliseconds);
      if (delays.length === 3) {
        waiting.resolve();
        await new Promise<void>((resolve) =>
          abort.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
    },
  );
  publisher.start();
  await waiting.promise;
  await publisher.stop();
  expect(delays).toEqual([1000, 2000, 4000]);
});

for (const target of [
  'wager-transactions.fifo',
  'wager-transactions-dlq.fifo',
]) {
  test('integration event destination cannot collide with ' + target, () => {
    expect(() => workerOptions({ SQS_EVENTS_QUEUE_NAME: target })).toThrow();
  });
}

for (const unconfirmed of [
  { ...result, canAcknowledge: false },
  { ...result, status: Status.Pending },
]) {
  test(
    'consumer does not ACK an unconfirmed or initial PENDING result ' +
      unconfirmed.status +
      ' ' +
      unconfirmed.canAcknowledge,
    async () => {
      const q = queueFixture();
      const outcome = await new WagerMessageHandler(
        { execute: async () => unconfirmed },
        q.queue,
        options,
        silent(),
      ).handle(delivery, signal());
      expect(q.acks).toHaveLength(0);
      expect(q.dlq).toHaveLength(0);
      expect(outcome.continueGroup).toBe(false);
    },
  );
}
