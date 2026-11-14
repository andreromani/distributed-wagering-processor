import 'reflect-metadata';
import { mkdir, readdir, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { environment } from '../src/infrastructure/config/environment.js';
import { databaseOptions } from '../src/infrastructure/database/options.js';
import { canonicalJson } from '../src/application/services/canonical-payload-hash.js';
import type { OutboxRow } from '../src/infrastructure/database/entities/outbox-message.schema.js';
import type { LedgerRow } from '../src/infrastructure/database/entities/wallet-ledger.schema.js';
import type { WagerRow } from '../src/infrastructure/database/entities/wager-transaction.schema.js';
import type { OpenWalletResult } from '../src/application/use-cases/open-wallet.use-case.js';
import type { ProcessWagerResult } from '../src/application/use-cases/process-wager-transaction.use-case.js';
import type { ReconciliationResult } from '../src/application/use-cases/reconcile-wallet.use-case.js';

const runId = crypto.randomUUID();
const database = 'wager_distributed_' + runId.replaceAll('-', '');
const directory = resolve('tmp/distributed-tests', runId);
const logDirectory = resolve('logs/distributed-tests', runId);
const override = join(directory, 'compose.test.json');
const apps = ['app-1', 'app-2', 'app-3'];
const config = environment();
const names = {
  input: `wager-dist-${runId}-input.fifo`,
  dead: `wager-dist-${runId}-dead.fifo`,
  events: `wager-dist-${runId}-events.fifo`,
};
const flags = apps.map(() => ({
  consumer: false,
  publisher: false,
  pending: true,
}));
const options = {
  ...databaseOptions(),
  connectTimeoutMS: 10000,
  extra: { statement_timeout: 60000, query_timeout: 65000 },
};
const admin = new DataSource(options);
const source = new DataSource({ ...options, database });
const sqs = new SQSClient({
  ...config.sqs,
  maxAttempts: 1,
  requestHandler: {
    connectionTimeout: 1000,
    requestTimeout: 6000,
    throwOnRequestTimeout: true,
  },
});
const wallets = new Map<
  string,
  {
    wallet: OpenWalletResult;
    amount: string;
    entries: number;
    transactions: number;
    events: number;
  }
>();
const results: Record<string, unknown>[] = [];
const started = new Date().toISOString();
let assertions = 0;
let inputUrl = '';
let eventsUrl = '';
let changedContainers = false;
let normalConfigurationRestored = false;
let logSequence = 0;
let processEvidence: unknown;

function check(condition: unknown, message: string): asserts condition {
  assertions += 1;
  if (!condition) {
    throw new Error(message);
  }
}

async function poll<T>(
  description: string,
  read: () => Promise<T | undefined>,
  timeout = 60000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }

    await Bun.sleep(50);
  }

  throw new Error('Polling deadline: ' + description);
}

async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(
      `docker ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`,
    );
  }

  return stdout;
}

function compose(args: string[], normal = false): Promise<string> {
  return docker([
    'compose',
    '-f',
    'compose.yaml',
    ...(normal ? [] : ['-f', override]),
    ...args,
  ]);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path + '.next', JSON.stringify(value));
  await rename(path + '.next', path);
}

async function control(
  index: number,
  point: string | null,
  ids: string[] = [],
): Promise<void> {
  await atomicJson(join(directory, apps[index], 'control.json'), {
    runId,
    point,
    ids,
  });
}

async function writeOverride(): Promise<void> {
  const services: Record<string, unknown> = {
    migrations: { environment: { POSTGRES_DB: database } },
  };
  for (const [index, app] of apps.entries()) {
    services[app] = {
      environment: {
        POSTGRES_DB: database,
        SQS_QUEUE_NAME: names.input,
        SQS_DLQ_NAME: names.dead,
        SQS_EVENTS_QUEUE_NAME: names.events,
        SQS_VISIBILITY_TIMEOUT: '5',
        SQS_LONG_POLL_SECONDS: '1',
        SQS_CONSUMER_ENABLED: String(flags[index].consumer),
        OUTBOX_PUBLISHER_ENABLED: String(flags[index].publisher),
        PENDING_REFERENCE_WORKER_ENABLED: String(flags[index].pending),
        DISTRIBUTED_TEST_HOOKS_ENABLED: 'true',
        DISTRIBUTED_TEST_RUN_ID: runId,
        DISTRIBUTED_TEST_DIRECTORY: '/run/wager-tests',
      },
      volumes: [
        {
          type: 'bind',
          source: join(directory, app),
          target: '/run/wager-tests',
        },
      ],
    };
  }

  await atomicJson(override, { services });
}

async function apply(indices: number[], ready = true): Promise<void> {
  await writeOverride();
  changedContainers = true;
  await compose([
    'up',
    '-d',
    '--no-deps',
    '--force-recreate',
    ...indices.map((index) => apps[index]),
  ]);
  if (ready) {
    await readiness(indices);
  }
}

async function readiness(indices = [0, 1, 2]): Promise<void> {
  await Promise.all(
    indices.map((index) =>
      poll(
        'readiness ' + apps[index],
        async () => {
          try {
            const response = await fetch(
              `http://127.0.0.1:${3001 + index}/health/ready`,
              { signal: AbortSignal.timeout(8000) },
            );
            const body = await response.text();
            return response.ok &&
              response.headers.get('x-instance-id') === apps[index]
              ? body
              : undefined;
          } catch {
            return undefined;
          }
        },
        180000,
      ),
    ),
  );
}

async function request<T>(
  index: number,
  path: string,
  body?: unknown,
  key?: string,
  statuses = [200, 201, 202],
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${3001 + index}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': runId,
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  check(
    statuses.includes(response.status),
    `HTTP ${response.status} ${apps[index]} ${path}: ${text}`,
  );
  check(
    response.headers.get('x-instance-id') === apps[index],
    'Serving instance mismatch',
  );
  return JSON.parse(text) as T;
}

async function wallet(index = 0): Promise<OpenWalletResult> {
  const value = await request<OpenWalletResult>(index, '/wallets', {
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  wallets.set(value.id, {
    wallet: value,
    amount: '100.00',
    entries: 1,
    transactions: 1,
    events: 2,
  });
  return value;
}

function payload(w: OpenWalletResult, kind = 'BET', amount = '25.00') {
  return {
    providerId: 'distributed-' + runId,
    externalTransactionId: crypto.randomUUID(),
    playerId: w.playerId,
    walletId: w.id,
    roundId: runId,
    gameId: 'distributed-test',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

function submit(
  index: number,
  data: ReturnType<typeof payload> & {
    referenceExternalTransactionId?: string;
  },
): Promise<ProcessWagerResult> {
  return request(
    index,
    '/wagering/transactions',
    data,
    data.externalTransactionId,
    [200, 201, 202, 422],
  );
}

function expected(
  w: OpenWalletResult,
  amount: string,
  entries: number,
  transactions: number,
  events: number,
): void {
  wallets.set(w.id, { wallet: w, amount, entries, transactions, events });
}

async function outbox(walletId?: string): Promise<OutboxRow[]> {
  return source.query<OutboxRow[]>(
    'SELECT * FROM outbox_messages' +
      (walletId ? ' WHERE aggregate_id=$1' : '') +
      ' ORDER BY occurred_at,id',
    walletId ? [walletId] : [],
  );
}

async function published(): Promise<void> {
  await poll('all outbox published', async () => {
    const rows = await outbox();
    return rows.every((row) => row.published_at !== null) ? true : undefined;
  });
}

async function audit(w: OpenWalletResult): Promise<Record<string, unknown>> {
  const wanted = wallets.get(w.id);
  check(wanted, 'Unknown wallet');
  const current = await request<OpenWalletResult>(0, '/wallets/' + w.id);
  const ledger = await source.query<LedgerRow[]>(
    'SELECT * FROM wallet_ledger_entries WHERE wallet_id=$1 ORDER BY created_at,id',
    [w.id],
  );
  const transactions = await source.query<WagerRow[]>(
    'SELECT * FROM wager_transactions WHERE wallet_id=$1',
    [w.id],
  );
  const events = await outbox(w.id);
  let cents = 0n;
  for (const entry of ledger) {
    const value = BigInt(entry.amount.replace('.', ''));
    cents += entry.direction === 'CREDIT' ? value : -value;
    check(
      entry.currency === 'BRL' && !entry.balance_after.startsWith('-'),
      'Invalid ledger currency/balance',
    );
  }

  check(
    cents === BigInt(wanted.amount.replace('.', '')),
    'Reconstructed balance mismatch ' + w.id,
  );
  check(
    current.balance.amount === wanted.amount &&
      current.version === wanted.entries,
    'Balance/version mismatch ' + w.id,
  );
  check(
    ledger.length === wanted.entries &&
      new Set(ledger.map((entry) => entry.transaction_id)).size ===
        ledger.length,
    'Duplicate/missing ledger ' + w.id,
  );
  check(
    transactions.length === wanted.transactions &&
      events.length === wanted.events,
    'Transaction/outbox count mismatch ' + w.id,
  );
  for (const transaction of transactions) {
    const entries = ledger.filter(
      (entry) => entry.transaction_id === transaction.id,
    );
    const moves =
      transaction.status === 'PROCESSED' && transaction.kind !== 'LOSS';
    check(
      entries.length === (moves ? 1 : 0),
      'Ledger effect/status mismatch ' + transaction.id,
    );
  }

  const page = await request<{ items: LedgerRow[]; nextCursor: string | null }>(
    1,
    '/wallets/' + w.id + '/ledger?limit=100',
  );
  check(page.items.length === ledger.length, 'HTTP ledger mismatch');
  const reconciliation = await request<ReconciliationResult>(
    2,
    '/wallets/' + w.id + '/reconciliation',
    {},
  );
  check(
    reconciliation.consistent &&
      reconciliation.difference.amount === '0.00' &&
      reconciliation.checkedEntries === ledger.length,
    'Reconciliation mismatch',
  );
  return {
    walletId: w.id,
    balance: current.balance.amount,
    version: current.version,
    ledger: ledger.length,
    transactions: transactions.length,
    events: events.length,
    consistent: true,
  };
}

async function logs(): Promise<Record<string, unknown>[]> {
  const text = await compose([
    'logs',
    '--no-color',
    '--no-log-prefix',
    '--since',
    started,
    ...apps,
  ]);
  await Bun.write(join(logDirectory, 'applications.log'), text);
  await Bun.write(
    join(logDirectory, `applications-${++logSequence}.log`),
    text,
  );
  return text.split(/\r?\n/).flatMap((line) => {
    try {
      const record: unknown = JSON.parse(line);
      return record && typeof record === 'object'
        ? [record as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

async function marker(
  index: number,
  point: string,
): Promise<{ id: string; instanceId: string; pid: number }> {
  return poll(point + ' ' + apps[index], async () => {
    const files = await readdir(join(directory, apps[index]));
    const matches = files.filter(
      (name) => name.startsWith(point + '-') && name.endsWith('.json'),
    );
    return matches.length
      ? ((await Bun.file(
          join(directory, apps[index], matches[matches.length - 1]),
        ).json()) as { id: string; instanceId: string; pid: number })
      : undefined;
  });
}

async function kill(index: number): Promise<unknown> {
  const before = await compose(['ps', '-q', apps[index]]);
  await compose(['kill', '-s', 'SIGKILL', apps[index]]);
  const state = JSON.parse(await docker(['inspect', before.trim()])) as {
    State: { ExitCode: number; OOMKilled: boolean };
    Id: string;
  }[];
  check(
    state[0].State.ExitCode === 137 && !state[0].State.OOMKilled,
    'Expected deliberate SIGKILL',
  );
  return {
    containerId: state[0].Id,
    exitCode: state[0].State.ExitCode,
    oomKilled: state[0].State.OOMKilled,
  };
}

async function send(
  w: OpenWalletResult,
  data: ReturnType<typeof payload>,
  messageId = crypto.randomUUID(),
): Promise<string> {
  const result = await sqs.send(
    new SendMessageCommand({
      QueueUrl: inputUrl,
      MessageGroupId: w.id,
      MessageDeduplicationId: messageId,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        correlationId: runId,
        data: { ...data, idempotencyKey: data.externalTransactionId },
      }),
    }),
  );
  check(result.MessageId, 'Missing SQS confirmation');
  return result.MessageId;
}

async function scenario(
  name: string,
  wanted: string,
  run: () => Promise<unknown>,
): Promise<void> {
  const start = Date.now();
  try {
    const observed = await run();
    const result = {
      name,
      instances: apps,
      expected: wanted,
      observed,
      result: 'PASS',
      durationMs: Date.now() - start,
      runId,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    results.push({
      name,
      expected: wanted,
      result: 'FAIL',
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.stack : String(error),
      runId,
    });
    throw error;
  }
}

async function prepare(): Promise<void> {
  await mkdir(directory, { recursive: true });
  await mkdir(logDirectory, { recursive: true });
  for (const [index, app] of apps.entries()) {
    await mkdir(join(directory, app), { recursive: true });
    await control(index, null);
  }

  await readiness();
  const status = await compose(['ps', '--format', 'json'], true);
  await Bun.write(join(logDirectory, 'preflight.jsonl'), status);
  for (const name of [
    config.queueName,
    config.dlqName,
    config.workers.eventQueueName,
  ]) {
    const queue = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    const attributes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl,
        AttributeNames: ['All'],
      }),
    );
    check(
      attributes.Attributes?.FifoQueue === 'true',
      'Preflight FIFO queue missing ' + name,
    );
  }

  await admin.initialize();
  await admin.query('CREATE DATABASE "' + database + '"');
  const dead = await sqs.send(
    new CreateQueueCommand({
      QueueName: names.dead,
      Attributes: { FifoQueue: 'true' },
    }),
  );
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dead.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  inputUrl =
    (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: names.input,
          Attributes: {
            FifoQueue: 'true',
            VisibilityTimeout: '5',
            ReceiveMessageWaitTimeSeconds: '1',
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: attributes.Attributes?.QueueArn,
              maxReceiveCount: '5',
            }),
          },
        }),
      )
    ).QueueUrl ?? '';
  eventsUrl =
    (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: names.events,
          Attributes: { FifoQueue: 'true' },
        }),
      )
    ).QueueUrl ?? '';
  check(inputUrl && eventsUrl, 'Test queues not created');
  await writeOverride();
  await compose(['run', '--rm', '--no-deps', 'migrations']);
  await source.initialize();
  await apply([0, 1, 2]);
  const containers = JSON.parse(
    await docker([
      'inspect',
      ...(await compose(['ps', '-q', ...apps])).trim().split(/\s+/),
    ]),
  ) as { Id: string; State: { Pid: number }; Config: { Env: string[] } }[];
  check(
    new Set(containers.map((container) => container.Id)).size === 3 &&
      new Set(containers.map((container) => container.State.Pid)).size === 3,
    'Three independent processes required',
  );
  processEvidence = {
    event: 'distributed_processes',
    runId,
    database,
    queues: names,
    containers: containers.map((container) => ({
      containerId: container.Id,
      hostPid: container.State.Pid,
      instance: container.Config.Env.find((value) =>
        value.startsWith('INSTANCE_ID='),
      ),
    })),
  };
  console.log(JSON.stringify(processEvidence));
}

async function execute(): Promise<void> {
  await scenario(
    'A',
    '3 repetitions of 50 requests, one debit each',
    async () => {
      const evidence = [];
      for (let repetition = 0; repetition < 3; repetition += 1) {
        const w = await wallet();
        const data = payload(w);
        const responses = await Promise.all(
          Array.from({ length: 50 }, (_, index) => submit(index % 3, data)),
        );
        check(
          new Set(responses.map((response) => response.transactionId)).size ===
            1,
          'Duplicate financial transaction',
        );
        check(
          responses.filter((response) => !response.idempotentReplay).length ===
            1,
          'Expected one original result',
        );
        check(
          responses.every(
            (response) =>
              response.status === 'PROCESSED' &&
              response.balance?.amount === '75.00' &&
              response.walletVersion === 2,
          ),
          'Replay snapshot mismatch',
        );
        expected(w, '75.00', 2, 2, 4);
        evidence.push({
          requests: 50,
          replays: 49,
          transactionId: responses[0].transactionId,
          ...(await audit(w)),
        });
      }

      return evidence;
    },
  );

  await scenario(
    'B',
    'one BET80 approved; extra 12 BET10 produce 10 approvals',
    async () => {
      const w = await wallet();
      const pair = await Promise.all([
        submit(0, payload(w, 'BET', '80.00')),
        submit(1, payload(w, 'BET', '80.00')),
      ]);
      check(
        pair.filter((result) => result.status === 'PROCESSED').length === 1 &&
          pair.filter((result) => result.status === 'REJECTED').length === 1,
        'BET80 race mismatch',
      );
      expected(w, '20.00', 2, 3, 5);
      const hot = await wallet(2);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          submit(index % 3, payload(hot, 'BET', '10.00')),
        ),
      );
      check(
        results.filter((result) => result.status === 'PROCESSED').length ===
          10 &&
          results.filter((result) => result.status === 'REJECTED').length === 2,
        'Hot wallet race mismatch',
      );
      expected(hot, '0.00', 11, 13, 24);
      return [await audit(w), await audit(hot)];
    },
  );

  await scenario(
    'C',
    'two wallets commit while another wallet is locked',
    async () => {
      const [a, b, c] = await Promise.all([wallet(0), wallet(1), wallet(2)]);
      const lock = source.createQueryRunner();
      await lock.connect();
      await lock.startTransaction();
      let pending: Promise<ProcessWagerResult> | undefined;
      try {
        await lock.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [
          a.id,
        ]);
        const owner = await lock.manager.query<{ pid: number }[]>(
          'SELECT pg_backend_pid() AS pid',
        );
        pending = submit(0, payload(a, 'BET', '10.00'));
        await poll(
          'wallet A blocked by test lock',
          async () => {
            const blocked = await source.query<{ pid: number }[]>(
              "SELECT pid FROM pg_stat_activity WHERE application_name='app-1' AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
              [owner[0].pid],
            );
            return blocked.length ? true : undefined;
          },
          5000,
        );
        const completed = await Promise.all([
          submit(1, payload(b, 'BET', '10.00')),
          submit(2, payload(c, 'BET', '10.00')),
        ]);
        check(
          completed.every((result) => result.status === 'PROCESSED'),
          'Other wallets blocked globally',
        );
        const stillBlocked = await source.query<{ pid: number }[]>(
          'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
          [owner[0].pid],
        );
        check(
          stillBlocked.length > 0,
          'Wallet A must still be blocked when others commit',
        );
        await lock.rollbackTransaction();
        check(
          (await pending).status === 'PROCESSED',
          'Wallet A failed after release',
        );
        for (const w of [a, b, c]) {
          expected(w, '90.00', 2, 2, 4);
        }

        return {
          blockedWallet: a.id,
          completedBeforeRelease: [b.id, c.id],
          wallets: await Promise.all([a, b, c].map(audit)),
        };
      } finally {
        if (lock.isTransactionActive) {
          await lock.rollbackTransaction();
        }

        await pending?.catch(() => undefined);
        await lock.release();
      }
    },
  );

  await scenario(
    'F',
    'REFUND before BET resolves automatically once',
    async () => {
      const w = await wallet();
      const bet = payload(w);
      const refund = {
        ...payload(w, 'REFUND'),
        referenceExternalTransactionId: bet.externalTransactionId,
      };
      const pending = await submit(0, refund);
      check(pending.status === 'PENDING_REFERENCE', 'Expected pending refund');
      check(
        (await request<OpenWalletResult>(1, '/wallets/' + w.id)).balance
          .amount === '100.00',
        'Pending changed balance',
      );
      check(
        (
          await source.query<LedgerRow[]>(
            'SELECT * FROM wallet_ledger_entries WHERE wallet_id=$1',
            [w.id],
          )
        ).length === 1,
        'Pending created ledger',
      );
      check(
        (await submit(1, bet)).status === 'PROCESSED',
        'Reference BET failed',
      );
      await poll('refund worker resolution', async () => {
        const rows = await source.query<WagerRow[]>(
          'SELECT * FROM wager_transactions WHERE id=$1',
          [pending.transactionId],
        );
        return rows[0]?.status === 'PROCESSED' ? true : undefined;
      });
      const replay = await submit(2, refund);
      check(
        replay.idempotentReplay && replay.status === 'PROCESSED',
        'Resolved refund replay mismatch',
      );
      expected(w, '100.00', 3, 3, 7);
      const resolution = (await logs()).find(
        (record) =>
          record.event === 'pending_reference_resolved' &&
          record.transactionId === pending.transactionId,
      );
      check(resolution, 'Missing automatic worker resolution evidence');
      return {
        refundId: pending.transactionId,
        submittedOn: 'app-1',
        betOn: 'app-2',
        replayOn: 'app-3',
        resolution,
        ...(await audit(w)),
      };
    },
  );

  await scenario(
    'E1',
    'two publishers simultaneously hold different outbox rows',
    async () => {
      const targets = await Promise.all([
        wallet(2),
        wallet(2),
        wallet(2),
        wallet(2),
      ]);
      const ids = (await Promise.all(targets.map((w) => outbox(w.id))))
        .flat()
        .map((row) => row.id);
      await Promise.all([
        control(0, 'publisher-before-send', ids),
        control(1, 'publisher-before-send', ids),
      ]);
      flags[0].publisher = true;
      flags[1].publisher = true;
      await apply([0, 1], false);
      const [a, b] = await Promise.all([
        marker(0, 'publisher-before-send'),
        marker(1, 'publisher-before-send'),
      ]);
      check(
        a.id !== b.id && a.instanceId !== b.instanceId,
        'Publishers did not claim distinct events',
      );
      const available = await source.query<{ id: string }[]>(
        'SELECT id FROM outbox_messages WHERE id=ANY($1) FOR UPDATE SKIP LOCKED',
        [[a.id, b.id]],
      );
      check(
        available.length === 0,
        'Both publishers must concurrently lock their own row',
      );
      await Promise.all([control(0, null), control(1, null)]);
      await readiness([0, 1]);
      await published();
      return {
        concurrentClaims: [a, b],
        targetEvents: ids,
        publishedEvents: (await outbox()).length,
      };
    },
  );

  await scenario(
    'E2',
    'broker-confirmed event recovers after SIGKILL with stable eventId',
    async () => {
      flags[0].publisher = false;
      flags[1].publisher = false;
      await apply([0, 1]);
      const w = await wallet(2);
      const original = await outbox(w.id);
      await control(
        0,
        'publisher-after-send',
        original.map((row) => row.id),
      );
      flags[0].publisher = true;
      await apply([0], false);
      const reached = await marker(0, 'publisher-after-send');
      check(
        (await outbox(w.id)).every((row) => row.published_at === null),
        'Outbox marked before crash',
      );
      const killed = await kill(0);
      await control(0, null);
      flags[1].publisher = true;
      await apply([1]);
      await published();
      const recovered = await outbox(w.id);
      check(
        canonicalJson(original.map((row) => [row.id, row.payload])) ===
          canonicalJson(recovered.map((row) => [row.id, row.payload])),
        'Event identity changed after restart',
      );
      const records = await logs();
      check(
        records.some(
          (record) =>
            record.eventId === reached.id &&
            record.instanceId === 'app-2' &&
            record.event === 'outbox_event_published',
        ),
        'Missing publication by recovery instance',
      );
      await apply([0]);
      return {
        confirmedBeforeMetadata: reached,
        killed,
        recoveredOn: 'app-2',
        publishedEvents: recovered.map((row) => ({
          id: row.id,
          publishedAt: row.published_at,
        })),
        ...(await audit(w)),
      };
    },
  );

  await scenario(
    'D',
    'committed SQS BET redelivers to another process without another debit',
    async () => {
      const w = await wallet(2);
      const data = payload(w);
      const messageId = crypto.randomUUID();
      await control(0, 'consumer-after-commit', [messageId]);
      flags[0].consumer = true;
      await apply([0]);
      const sqsMessageId = await send(w, data, messageId);
      const reached = await marker(0, 'consumer-after-commit');
      expected(w, '75.00', 2, 2, 4);
      const committed = await audit(w);
      const before = await outbox(w.id);
      const inbox = await source.query<{ processed_at: Date | null }[]>(
        'SELECT processed_at FROM inbox_messages WHERE message_id=$1',
        [messageId],
      );
      check(
        inbox.length === 1 && inbox[0].processed_at,
        'Inbox not committed before crash',
      );
      const records = await logs();
      check(
        !records.some(
          (record) =>
            record.event === 'message_acknowledged' &&
            record.messageId === messageId,
        ),
        'ACK happened before crash',
      );
      const killed = await kill(0);
      await control(0, null);
      flags[1].consumer = true;
      await apply([1]);
      const replay = await poll('ACK in app-2 after replay', async () => {
        const rows = await logs();
        const acknowledged = rows.find(
          (record) =>
            record.event === 'message_acknowledged' &&
            record.messageId === messageId &&
            record.instanceId === 'app-2',
        );
        const financial = rows.find(
          (record) =>
            record.event === 'financial_result' &&
            record.messageId === messageId &&
            record.instanceId === 'app-2' &&
            record.idempotentReplay === true,
        );
        return acknowledged && financial
          ? { acknowledged, financial }
          : undefined;
      });
      check(
        replay.acknowledged.sqsMessageId === sqsMessageId &&
          typeof replay.acknowledged.attempt === 'number' &&
          replay.acknowledged.attempt >= 2,
        'Expected redelivery of the same broker message',
      );
      check(
        canonicalJson(before.map((row) => [row.id, row.payload])) ===
          canonicalJson(
            (await outbox(w.id)).map((row) => [row.id, row.payload]),
          ),
        'Redelivery duplicated events',
      );
      check(
        (
          await source.query<unknown[]>(
            'SELECT * FROM inbox_messages WHERE message_id=$1',
            [messageId],
          )
        ).length === 1,
        'Duplicate inbox',
      );
      await published();
      await apply([0]);
      return {
        messageId,
        sqsMessageId,
        committedBy: reached,
        committed,
        killed,
        replay,
        final: await audit(w),
      };
    },
  );

  await scenario(
    'G',
    'durable SQS, outbox and pending reference recover across restart',
    async () => {
      for (const flag of flags) {
        flag.consumer = false;
        flag.publisher = false;
        flag.pending = false;
      }

      await apply([0, 1, 2]);
      const w = await wallet();
      const bet = payload(w);
      const pending = await submit(0, {
        ...payload(w, 'REFUND'),
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      check(
        pending.status === 'PENDING_REFERENCE',
        'Missing durable reference',
      );
      const original = await outbox(w.id);
      const messageId = crypto.randomUUID();
      const sqsMessageId = await send(w, payload(w, 'WIN', '10.00'), messageId);
      await compose(['stop', 'app-1']);
      check(
        (await submit(1, bet)).status === 'PROCESSED',
        'BET while app-1 stopped failed',
      );
      for (const flag of flags) {
        flag.consumer = true;
        flag.publisher = true;
        flag.pending = true;
      }

      await apply([0, 1, 2]);
      await poll('durable recovery', async () => {
        const current = await request<OpenWalletResult>(1, '/wallets/' + w.id);
        return current.balance.amount === '110.00' && current.version === 4
          ? true
          : undefined;
      });
      await published();
      const recovered = await outbox(w.id);
      check(
        original.every((row) =>
          recovered.some(
            (event) =>
              event.id === row.id &&
              canonicalJson(event.payload) === canonicalJson(row.payload),
          ),
        ),
        'Durable events lost',
      );
      const inbox = await source.query<{ processed_at: Date | null }[]>(
        'SELECT processed_at FROM inbox_messages WHERE message_id=$1',
        [messageId],
      );
      check(
        inbox.length === 1 && inbox[0].processed_at,
        'Durable message lost',
      );
      expected(w, '110.00', 4, 4, 9);
      return {
        messageId,
        sqsMessageId,
        pendingTransactionId: pending.transactionId,
        preservedEvents: original.map((row) => row.id),
        ...(await audit(w)),
      };
    },
  );

  await scenario(
    'H',
    'all wallets reconcile and all stable event IDs reach the isolated broker queue',
    async () => {
      const evidence = [];
      for (const { wallet: w } of wallets.values()) {
        evidence.push(await audit(w));
      }

      await published();
      const events = await outbox();
      const known = new Map(events.map((row) => [row.id, row.payload]));
      const observed = new Set<string>();
      let duplicateDeliveries = 0;
      await poll(
        'all events observed at broker',
        async () => {
          const delivery = await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: eventsUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 1,
              VisibilityTimeout: 30,
            }),
          );
          for (const message of delivery.Messages ?? []) {
            const envelope = JSON.parse(message.Body ?? '{}') as {
              eventId?: string;
            };
            check(
              envelope.eventId && known.has(envelope.eventId),
              'Unexpected event in isolated test queue',
            );
            check(
              canonicalJson(envelope) ===
                canonicalJson(known.get(envelope.eventId)),
              'Broker event payload mismatch',
            );
            if (observed.has(envelope.eventId)) {
              duplicateDeliveries += 1;
            }

            observed.add(envelope.eventId);
            check(message.ReceiptHandle, 'Missing collector receipt');
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: eventsUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
          }

          return observed.size === known.size ? true : undefined;
        },
        120000,
      );
      return {
        wallets: evidence,
        published: events.length,
        brokerObserved: observed.size,
        duplicateDeliveries,
        deliveryGuarantee:
          'at-least-once; FIFO may deduplicate republishing with the same eventId',
      };
    },
  );
}

let failure: unknown;
let infrastructureBefore = '';
try {
  infrastructureBefore = (
    await compose(['ps', '-q', 'postgres', 'localstack'], true)
  ).trim();
  await prepare();
  await execute();
  check(
    (await compose(['ps', '-q', 'postgres', 'localstack'], true)).trim() ===
      infrastructureBefore,
    'PostgreSQL/LocalStack were recreated',
  );
} catch (error) {
  failure = error;
  console.error(error);
  if (changedContainers) {
    await logs().catch((diagnostic) =>
      console.error('Log collection failed', diagnostic),
    );
  }
} finally {
  try {
    if (changedContainers) {
      await Promise.all(apps.map((_, index) => control(index, null)));
      await compose(
        ['up', '-d', '--no-deps', '--force-recreate', ...apps],
        true,
      );
      await readiness();
      normalConfigurationRestored = true;
    }
  } catch (error) {
    failure = new AggregateError(
      [failure, error].filter(Boolean),
      'Distributed test/restoration failure',
    );
  }

  const cleanup = await Promise.allSettled([
    ...(source.isInitialized ? [source.destroy()] : []),
    ...(admin.isInitialized ? [admin.destroy()] : []),
  ]);
  for (const result of cleanup) {
    if (result.status === 'rejected') {
      failure = new AggregateError(
        [failure, result.reason].filter(Boolean),
        'Cleanup failure',
      );
    }
  }

  sqs.destroy();
  const summary = {
    runId,
    database,
    processEvidence,
    queues: names,
    results,
    passed: results.filter((result) => result.result === 'PASS').length,
    failed: results.filter((result) => result.result === 'FAIL').length,
    assertions,
    completed: !failure && results.length === 9,
    error:
      failure instanceof Error
        ? failure.stack
        : failure
          ? JSON.stringify(failure)
          : undefined,
    normalConfigurationRestored,
    pending: ['A', 'B', 'C', 'D', 'E1', 'E2', 'F', 'G', 'H'].filter(
      (name) => !results.some((result) => result.name === name),
    ),
  };
  await mkdir(logDirectory, { recursive: true });
  await Bun.write(
    join(logDirectory, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
}

if (failure || results.length !== 9) {
  process.exitCode = 1;
}
