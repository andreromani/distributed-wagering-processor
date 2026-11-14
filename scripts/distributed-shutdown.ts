import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  SQSClient,
  GetQueueUrlCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { environment } from '../src/infrastructure/config/environment.js';
import { databaseOptions } from '../src/infrastructure/database/options.js';

const config = environment();
const source = new DataSource({
  ...databaseOptions(),
  connectTimeoutMS: 10000,
});
const sqs = new SQSClient({
  ...config.sqs,
  maxAttempts: 1,
  requestHandler: {
    connectionTimeout: 1000,
    requestTimeout: 5000,
    throwOnRequestTimeout: true,
  },
});
const runner = source.createQueryRunner();
const since = new Date().toISOString();
const correlationId = crypto.randomUUID();
const messageId = crypto.randomUUID();
let restarted = false;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', 'compose', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  check(code === 0, 'Docker command failed: ' + stderr);
  return stdout;
}

async function poll<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 30000,
  label = 'operation',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }

    await Bun.sleep(50);
  }

  throw new Error('Native shutdown validation deadline: ' + label);
}

async function logs(): Promise<Record<string, unknown>[]> {
  const text = await docker([
    'logs',
    '--no-log-prefix',
    '--no-color',
    '--since',
    since,
    'app-1',
  ]);
  return text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

try {
  console.log(
    JSON.stringify({
      event: 'native_shutdown_phase',
      phase: 'stopping_secondary_instances',
    }),
  );
  await docker(['stop', 'app-2', 'app-3']);
  const response = await fetch('http://127.0.0.1:3001/wallets', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
    signal: AbortSignal.timeout(10000),
  });
  check(response.status === 201, 'Shutdown fixture wallet creation failed');
  const wallet = (await response.json()) as { id: string; playerId: string };
  await source.initialize();
  console.log(
    JSON.stringify({
      event: 'native_shutdown_phase',
      phase: 'locking_test_wallet',
    }),
  );
  await runner.connect();
  await runner.startTransaction();
  await runner.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [
    wallet.id,
  ]);
  const [owner] = await runner.manager.query<{ pid: number }[]>(
    'SELECT pg_backend_pid() AS pid',
  );
  check(owner !== undefined, 'Missing test lock owner');
  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: config.queueName }),
  );
  const externalTransactionId = crypto.randomUUID();
  const sent = await sqs.send(
    new SendMessageCommand({
      QueueUrl,
      MessageGroupId: wallet.id,
      MessageDeduplicationId: messageId,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        correlationId,
        data: {
          providerId: 'shutdown-smoke',
          externalTransactionId,
          idempotencyKey: crypto.randomUUID(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: correlationId,
          gameId: 'smoke',
          kind: 'LOSS',
          money: { amount: '0.00', currency: 'BRL' },
        },
      }),
    }),
  );
  await poll(
    async () => {
      const rows = await source.query<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name='app-1' AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`,
        [owner.pid],
      );
      return Number(rows[0]?.count ?? '0') > 0 ? true : undefined;
    },
    Math.min(
      120000,
      Math.max(
        30000,
        (config.workers.visibilitySeconds +
          config.workers.longPollSeconds +
          10) *
          1000,
      ),
    ),
  );
  const started = performance.now();
  console.log(
    JSON.stringify({
      event: 'native_shutdown_phase',
      phase: 'stopping_active_consumer',
    }),
  );
  const stopped = docker(['stop', 'app-1']);
  await poll(async () =>
    (await logs()).some(
      (record) =>
        record.event === 'signal_received' && record.signal === 'SIGTERM',
    )
      ? true
      : undefined,
  );
  await runner.rollbackTransaction();
  await stopped;
  const elapsedMs = performance.now() - started;
  console.log(
    JSON.stringify({
      event: 'native_shutdown_phase',
      phase: 'workers_stopped',
      elapsedMs,
    }),
  );
  check(elapsedMs < 40000, 'Shutdown exceeded Compose grace period');
  const records = await logs();
  const drained = records.findIndex(
    (record) => record.event === 'workers_drained',
  );
  const destroyed = records.findIndex(
    (record) => record.event === 'sqs_client_destroyed',
  );
  check(
    drained >= 0 && destroyed > drained,
    'Resource shutdown preceded worker drain',
  );
  check(
    records[drained]?.databaseConnected === true,
    'Database closed before worker drain',
  );
  for (const event of [
    'consumer_stopped',
    'outbox_publisher_stopped',
    'pending_reference_worker_stopped',
  ]) {
    check(
      records.some(
        (record, index) => record.event === event && index < drained,
      ),
      'Missing worker shutdown evidence: ' + event,
    );
  }

  const [connections] = await source.query<{ count: string }[]>(
    `SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name='app-1'`,
  );
  check(
    connections?.count === '0',
    'Stopped instance retained PostgreSQL connections',
  );
  const [receipt] = await source.query<{ count: string }[]>(
    'SELECT count(*)::text AS count FROM inbox_messages WHERE consumer_name=$1 AND message_id=$2 AND processed_at IS NOT NULL',
    ['wager-financial-v1', messageId],
  );
  const acknowledged = records.some(
    (record) =>
      record.event === 'message_acknowledged' &&
      record.sqsMessageId === sent.MessageId,
  );
  check(!acknowledged || receipt?.count === '1', 'ACK without committed inbox');
  console.log(
    JSON.stringify({
      event: 'native_shutdown_phase',
      phase: 'restarting_instances',
    }),
  );
  await docker(['start', 'app-1', 'app-2', 'app-3']);
  restarted = true;
  for (const port of [3001, 3002, 3003]) {
    console.log(
      JSON.stringify({
        event: 'native_shutdown_phase',
        phase: 'waiting_readiness',
        port,
      }),
    );
    await poll(
      async () => {
        try {
          const ready = await fetch(
            'http://127.0.0.1:' + port + '/health/ready',
            { signal: AbortSignal.timeout(5000) },
          );
          return ready.ok ? true : undefined;
        } catch {
          return undefined;
        }
      },
      180000,
      'readiness port ' + port,
    );
  }

  console.log(
    JSON.stringify({
      event: 'native_shutdown_phase',
      phase: 'checking_financial_recovery',
    }),
  );
  await poll(
    async () => {
      const rows = await source.query<{ status: string }[]>(
        'SELECT status FROM wager_transactions WHERE provider_id=$1 AND external_transaction_id=$2',
        ['shutdown-smoke', externalTransactionId],
      );
      return rows[0]?.status === 'PROCESSED' ? true : undefined;
    },
    60000,
    'financial recovery',
  );
  await poll(
    async () => {
      const [row] = await source.query<{ count: string }[]>(
        'SELECT count(*)::text AS count FROM outbox_messages WHERE aggregate_id=$1 AND published_at IS NOT NULL',
        [wallet.id],
      );
      return row?.count === '3' ? true : undefined;
    },
    60000,
    'outbox recovery',
  );
  const [accounting] = await source.query<
    {
      balance: string;
      version: number;
      entries: string;
      events: string;
      receipts: string;
    }[]
  >(
    `SELECT w.balance,w.version,
      (SELECT count(*)::text FROM wallet_ledger_entries WHERE wallet_id=w.id) AS entries,
      (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id=w.id) AS events,
      (SELECT count(*)::text FROM inbox_messages WHERE message_id=$2 AND processed_at IS NOT NULL) AS receipts
     FROM wallets w WHERE id=$1`,
    [wallet.id, messageId],
  );
  check(
    accounting?.balance === '100.00' &&
      accounting.version === 1 &&
      accounting.entries === '1' &&
      accounting.events === '3' &&
      accounting.receipts === '1',
    'Native shutdown recovery accounting mismatch',
  );
  const reconciliationResponse = await fetch(
    'http://127.0.0.1:3001/wallets/' + wallet.id + '/reconciliation',
    { method: 'POST', signal: AbortSignal.timeout(10000) },
  );
  const reconciliation = (await reconciliationResponse.json()) as {
    consistent: boolean;
    difference: { amount: string };
  };
  check(
    reconciliationResponse.ok &&
      reconciliation.consistent &&
      reconciliation.difference.amount === '0.00',
    'Native shutdown ledger reconciliation mismatch',
  );
  console.log(
    JSON.stringify({
      event: 'native_shutdown_passed',
      instanceId: 'app-1',
      elapsedMs,
      signal: 'SIGTERM',
      workersDrainedBeforeResources: true,
      postgresConnectionsAfterStop: connections?.count,
      acknowledgedBeforeRestart: acknowledged,
      walletId: wallet.id,
      accounting,
      correlationId,
    }),
  );
} finally {
  try {
    if (runner.isTransactionActive) {
      await runner.rollbackTransaction();
    }
  } finally {
    try {
      await runner.release();
      if (source.isInitialized) {
        await source.destroy();
      }
    } finally {
      sqs.destroy();
      if (!restarted) {
        await docker(['start', 'app-1', 'app-2', 'app-3']);
      }
    }
  }
}
