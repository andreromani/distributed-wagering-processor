import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  SQSClient,
  GetQueueUrlCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { databaseOptions } from '../src/infrastructure/database/options.js';
import { environment } from '../src/infrastructure/config/environment.js';

type WalletResponse = {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
};
type TransactionResponse = {
  transactionId: string;
  status: string;
  idempotentReplay: boolean;
  balance: { amount: string };
};
const urls = (
  process.env.SMOKE_APP_URLS ??
  'http://127.0.0.1:3001,http://127.0.0.1:3002,http://127.0.0.1:3003'
).split(',');
if (urls.length !== 3 || new Set(urls).size !== 3) {
  throw new Error('SMOKE_APP_URLS must contain three distinct URLs');
}

const correlationId = crypto.randomUUID();
const config = environment();
const source = new DataSource(databaseOptions());
const sqs = new SQSClient({
  ...config.sqs,
  maxAttempts: 2,
  requestHandler: {
    connectionTimeout: 1000,
    requestTimeout: 6000,
    throwOnRequestTimeout: true,
  },
});
const receipts = new Map<string, string>();
let eventQueueUrl: string | undefined;
const failures: unknown[] = [];
let summary: Record<string, unknown> | undefined;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function poll<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 45000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) {
      return result;
    }

    await Bun.sleep(100);
  }

  throw new Error('Distributed smoke polling deadline');
}

async function request<T>(
  index: number,
  path: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await fetch(urls[index] + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': correlationId,
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  check(response.ok, `HTTP ${response.status} on instance ${index + 1}`);
  check(
    response.headers.get('x-instance-id') === `app-${index + 1}`,
    'Unexpected serving instance',
  );
  console.log(
    JSON.stringify({
      event: 'distributed_smoke_http',
      instanceId: response.headers.get('x-instance-id'),
      path,
      status: response.status,
      correlationId,
    }),
  );
  return response.json() as Promise<T>;
}

try {
  for (let index = 0; index < 3; index += 1) {
    await poll(async () => {
      try {
        return await request(index, '/health/ready');
      } catch {
        return undefined;
      }
    });
    await request(index, '/health/live');
  }

  const wallet = await request<WalletResponse>(0, '/wallets', {
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const shared = await request<WalletResponse>(1, '/wallets/' + wallet.id);
  check(shared.balance.amount === '100.00', 'Initial shared balance mismatch');
  const financial = {
    providerId: 'smoke-provider',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: correlationId,
    gameId: 'smoke',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  const key = crypto.randomUUID();
  const bet = await request<TransactionResponse>(
    2,
    '/wagering/transactions',
    financial,
    key,
  );
  check(
    bet.status === 'PROCESSED' && bet.balance.amount === '75.00',
    'BET result mismatch',
  );
  check(
    (await request<WalletResponse>(0, '/wallets/' + wallet.id)).balance
      .amount === '75.00',
    'BET shared balance mismatch',
  );
  const replay = await request<TransactionResponse>(
    1,
    '/wagering/transactions',
    financial,
    key,
  );
  check(
    replay.idempotentReplay &&
      replay.transactionId === bet.transactionId &&
      replay.balance.amount === '75.00',
    'Cross-instance replay mismatch',
  );
  check(
    (await request<WalletResponse>(0, '/wallets/' + wallet.id)).balance
      .amount === '75.00',
    'Replay changed balance',
  );
  const input = await sqs.send(
    new GetQueueUrlCommand({ QueueName: config.queueName }),
  );
  const messageId = crypto.randomUUID();
  const win = {
    ...financial,
    kind: 'WIN',
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    money: { amount: '10.00', currency: 'BRL' },
  };
  const sent = await sqs.send(
    new SendMessageCommand({
      QueueUrl: input.QueueUrl,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        correlationId,
        data: win,
      }),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: messageId,
    }),
  );
  console.log(
    JSON.stringify({
      event: 'distributed_smoke_sqs_sent',
      messageId,
      sqsMessageId: sent.MessageId,
      correlationId,
    }),
  );
  const final = await poll(async () => {
    const current = await request<WalletResponse>(0, '/wallets/' + wallet.id);
    return current.balance.amount === '85.00' ? current : undefined;
  });
  check(final.version === 3, 'Unexpected wallet version');
  const ledger = await request<{ items: unknown[] }>(
    1,
    '/wallets/' + wallet.id + '/ledger',
  );
  check(
    ledger.items.length === 3,
    'Expected OPENING, BET and WIN ledger entries',
  );
  const reconciliation = await request<{
    consistent: boolean;
    difference: { amount: string };
    checkedEntries: number;
  }>(2, '/wallets/' + wallet.id + '/reconciliation', {});
  check(
    reconciliation.consistent &&
      reconciliation.difference.amount === '0.00' &&
      reconciliation.checkedEntries === 3,
    'Reconciliation mismatch',
  );
  await source.initialize();
  const eventIds = await poll(async () => {
    const events = await source.query<
      { id: string; published_at: Date | null; correlation: string }[]
    >(
      `SELECT id,published_at,payload->>'correlationId' AS correlation FROM outbox_messages WHERE aggregate_id=$1`,
      [wallet.id],
    );
    return events.length === 6 &&
      events.every(
        (event) =>
          event.published_at !== null && event.correlation === correlationId,
      )
      ? new Set(events.map((event) => event.id))
      : undefined;
  });
  eventQueueUrl = (
    await sqs.send(
      new GetQueueUrlCommand({ QueueName: config.workers.eventQueueName }),
    )
  ).QueueUrl;
  const observed = new Set<string>();
  await poll(async () => {
    const delivery = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: eventQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 120,
      }),
    );
    for (const message of delivery.Messages ?? []) {
      if (message.ReceiptHandle && message.MessageId) {
        receipts.set(message.MessageId, message.ReceiptHandle);
      }

      const envelope: unknown = JSON.parse(message.Body ?? '{}');
      if (
        envelope &&
        typeof envelope === 'object' &&
        'eventId' in envelope &&
        typeof envelope.eventId === 'string' &&
        eventIds.has(envelope.eventId)
      ) {
        observed.add(envelope.eventId);
        if (message.ReceiptHandle) {
          await sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: eventQueueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
        }
      }
    }

    return observed.size === 6 ? true : undefined;
  });
  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(urls[index] + '/metrics', {
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    check(
      response.ok &&
        response.headers.get('content-type')?.includes('text/plain') === true &&
        text.includes(`instance_id="app-${index + 1}"`) &&
        text.includes('wager_processing_duration_seconds_count'),
      'Metrics endpoint mismatch',
    );
    console.log(
      JSON.stringify({
        event: 'distributed_smoke_metrics',
        instanceId: response.headers.get('x-instance-id'),
        status: response.status,
      }),
    );
  }

  summary = {
    event: 'distributed_smoke_passed',
    walletId: wallet.id,
    balance: final.balance.amount,
    ledgerEntries: 3,
    publishedEvents: observed.size,
    correlationId,
  };
} catch (error) {
  failures.push(error);
} finally {
  const cleanup: Promise<unknown>[] = [...receipts.values()].map(
    (ReceiptHandle) =>
      sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: eventQueueUrl,
          ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      ),
  );
  if (source.isInitialized) {
    cleanup.push(source.destroy());
  }

  const results = await Promise.allSettled(cleanup);
  sqs.destroy();
  for (const result of results) {
    if (result.status === 'rejected') {
      failures.push(result.reason);
    }
  }
}

if (failures.length > 0) {
  throw new AggregateError(failures, 'Distributed smoke or cleanup failed');
}

check(summary !== undefined, 'Missing distributed smoke result');
console.log(JSON.stringify(summary));
