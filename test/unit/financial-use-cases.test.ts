import { inboxPayloadHash } from '../../src/application/services/inbox-payload-hash.js';
import { test, expect } from 'bun:test';
import {
  canonicalPayloadHash,
  canonicalJson,
} from '../../src/application/services/canonical-payload-hash.js';
import { OpenWalletUseCase } from '../../src/application/use-cases/open-wallet.use-case.js';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerInput,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import { ReprocessPendingReferenceUseCase } from '../../src/application/use-cases/reprocess-pending-reference.use-case.js';
import { MemoryFinancialTransaction } from '../support/memory-financial-transaction.js';
import { PersistenceError } from '../../src/application/ports/persistence.error.js';
import { FinancialApplicationError } from '../../src/application/errors/financial-application.error.js';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../../src/domain/financial.types.js';
import { InboxMessage } from '../../src/domain/entities/inbox-message.js';
import { OutboxMessage } from '../../src/domain/entities/outbox-message.js';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed.event.js';
import { LedgerDirection } from '../../src/domain/financial.types.js';

function fixture(policy?: {
  maxAttempts: number;
  ttlMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}) {
  const memory = new MemoryFinancialTransaction();
  let now = new Date('2026-01-01T00:00:00Z');
  let sequence = 0;
  const runtime = { now: () => new Date(now), id: () => 'id-' + ++sequence };
  const open = new OpenWalletUseCase(memory, runtime);
  const process = new ProcessWagerTransactionUseCase(memory, runtime, policy);

  return {
    memory,
    open,
    process,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
function payload(
  walletId = 'wallet',
  external = 'external',
): ProcessWagerInput {
  return {
    walletId,
    providerId: 'provider',
    externalTransactionId: external,
    idempotencyKey: external,
    playerId: 'player',
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
  };
}
async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  let failure: unknown;
  try {
    await work;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(FinancialApplicationError);
  expect(failure).toHaveProperty('code', code);
}

test('canonical hash ignores property order and transport metadata', () => {
  const input = payload();
  const reordered = Object.fromEntries(
    Object.entries(input).reverse(),
  ) as unknown as ProcessWagerInput;

  expect(canonicalPayloadHash(input)).toBe(canonicalPayloadHash(reordered));
  expect(canonicalPayloadHash(input)).toBe(
    canonicalPayloadHash({
      ...input,
      correlationId: 'other',
      idempotencyKey: 'other',
      inbox: { consumerName: 'test', messageId: 'message' },
    } as ProcessWagerInput),
  );
  expect(canonicalPayloadHash(input)).toMatch(/^[a-f0-9]{64}$/);
  expect(canonicalJson({ nested: { z: 1, a: 2 }, list: [2, 1] })).toBe(
    '{"list":[2,1],"nested":{"a":2,"z":1}}',
  );
});
for (const changes of [
  { money: { amount: '11.00', currency: 'BRL' } },
  { money: { amount: '10.00', currency: 'USD' } },
  { kind: Kind.Win },
  { walletId: 'other' },
  { referenceExternalTransactionId: 'reference' },
]) {
  test('hash changes for business field ' + JSON.stringify(changes), () => {
    expect(canonicalPayloadHash({ ...payload(), ...changes })).not.toBe(
      canonicalPayloadHash(payload()),
    );
  });
}
test('canonical absent optional reference equals explicit undefined', () => {
  expect(canonicalPayloadHash(payload())).toBe(
    canonicalPayloadHash({
      ...payload(),
      referenceExternalTransactionId: undefined,
    }),
  );
});
for (const amount of ['0.00', '100.00']) {
  test(
    'open wallet with ' + amount + ' persists the expected components',
    async () => {
      const f = fixture();
      const wallet = await f.open.execute({
        playerId: 'player',
        initialBalance: { amount, currency: 'BRL' },
      });

      expect(wallet.version).toBe(1);
      expect(wallet.balance.amount).toBe(amount);
      expect(f.memory.wallets.size).toBe(1);
      expect(f.memory.wagers.size).toBe(amount === '0.00' ? 0 : 1);
      expect(f.memory.entries).toHaveLength(amount === '0.00' ? 0 : 1);
      expect(f.memory.outbox).toHaveLength(amount === '0.00' ? 0 : 2);
    },
  );
}
test('open wallet distinguishes uniqueness and unexpected persistence errors', async () => {
  const f = fixture();
  f.memory.context.wallets.insert = async () => {
    throw new PersistenceError('unique', 'uq_wallet_player_currency');
  };
  await expectCode(
    f.open.execute({
      playerId: 'player',
      initialBalance: { amount: '0.00', currency: 'BRL' },
    }),
    'WALLET_CONFLICT',
  );

  f.memory.context.wallets.insert = async () => {
    throw new Error('disk failure');
  };
  let failure: unknown;
  try {
    await f.open.execute({
      playerId: 'player',
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toHaveProperty('message', 'disk failure');
});
for (const [kind, amount, expected, balance] of [
  [Kind.Bet, '10.00', Status.Processed, '90.00'],
  [Kind.Bet, '101.00', Status.Rejected, '100.00'],
  [Kind.Win, '10.00', Status.Processed, '110.00'],
  [Kind.Loss, '0.00', Status.Processed, '100.00'],
] as const) {
  test('process ' + kind + ' ' + amount + ' yields ' + expected, async () => {
    const f = fixture();
    const wallet = await f.open.execute({
      playerId: 'player',
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const input = {
      ...payload(wallet.id),
      kind,
      money: { amount, currency: 'BRL' },
    };
    const result = await f.process.execute(input);

    expect(result.status).toBe(expected);
    expect(result.balance?.amount).toBe(balance);
    expect(f.memory.outbox.at(-1)?.eventType).toBe(
      expected === Status.Rejected
        ? 'WagerTransactionRejected'
        : kind === Kind.Loss
          ? 'WagerTransactionProcessed'
          : 'WalletBalanceChanged',
    );
    const replay = await f.process.execute(input);
    expect(replay.transactionId).toBe(result.transactionId);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance).toEqual(result.balance);
  });
}
test('idempotency and external identity conflicts are distinct', async () => {
  const f = fixture();
  const wallet = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const input = payload(wallet.id);
  await f.process.execute(input);

  await expectCode(
    f.process.execute({
      ...input,
      money: { amount: '11.00', currency: 'BRL' },
    }),
    'IDEMPOTENCY_CONFLICT',
  );
  await expectCode(
    f.process.execute({ ...input, idempotencyKey: 'new' }),
    'EXTERNAL_IDENTITY_CONFLICT',
  );
});
test('invalid input, missing wallet and incompatible context are distinct', async () => {
  const f = fixture();
  await expectCode(
    f.process.execute({ ...payload(), kind: Kind.Opening }),
    'INVALID_INPUT',
  );
  await expectCode(
    f.process.execute({ ...payload(), providerId: 'internal' }),
    'INVALID_INPUT',
  );
  await expectCode(f.process.execute(payload()), 'WALLET_NOT_FOUND');
  const wallet = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '0.00', currency: 'BRL' },
  });
  await expectCode(
    f.process.execute({ ...payload(wallet.id), playerId: 'other' }),
    'CONTEXT_MISMATCH',
  );
});
for (const kind of [Kind.Refund, Kind.Rollback]) {
  test(kind + ' applies integral reversal once', async () => {
    const f = fixture();
    const wallet = await f.open.execute({
      playerId: 'player',
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    await f.process.execute(payload(wallet.id, 'bet'));
    const input = {
      ...payload(wallet.id, 'reversal'),
      kind,
      referenceExternalTransactionId: 'bet',
    };

    expect((await f.process.execute(input)).balance?.amount).toBe('100.00');
    const duplicate = await f.process.execute({
      ...input,
      externalTransactionId: 'second',
      idempotencyKey: 'second',
    });
    expect(duplicate.status).toBe(Status.Rejected);
    expect(duplicate.failureCode).toBe(FailureCode.InvalidReference);
  });
}
test('pending reference replays without retry and later processes using the same transaction', async () => {
  const f = fixture();
  const wallet = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const input = {
    ...payload(wallet.id, 'refund'),
    kind: Kind.Refund,
    referenceExternalTransactionId: 'bet',
  };
  const pending = await f.process.execute(input);
  const events = f.memory.outbox.length;
  expect(pending.status).toBe(Status.PendingReference);
  expect((await f.process.execute(input)).idempotentReplay).toBe(true);
  expect(f.memory.outbox).toHaveLength(events);

  await f.process.execute(payload(wallet.id, 'bet'));
  f.advance(1000);
  const result = await new ReprocessPendingReferenceUseCase(f.process).execute(
    pending.transactionId,
  );
  expect(result.transactionId).toBe(pending.transactionId);
  expect(result.status).toBe(Status.Processed);
  expect(result.balance?.amount).toBe('100.00');
  expect(
    (await f.process.reprocess(result.transactionId)).idempotentReplay,
  ).toBe(true);
});
test('backoff is capped and attempt limit produces a terminal rejection', async () => {
  const f = fixture({
    maxAttempts: 3,
    ttlMs: 100000,
    baseDelayMs: 100,
    maxDelayMs: 150,
  });
  const wallet = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '0.00', currency: 'BRL' },
  });
  const pending = await f.process.execute({
    ...payload(wallet.id),
    kind: Kind.Refund,
    referenceExternalTransactionId: 'missing',
  });
  const first = f.memory.wagers.get(pending.transactionId);
  expect(first?.referenceAttempts).toBe(1);
  f.advance(100);
  await f.process.reprocess(pending.transactionId);
  expect(
    f.memory.wagers.get(pending.transactionId)?.nextAttemptAt?.toISOString(),
  ).toBe('2026-01-01T00:00:00.250Z');
  f.advance(150);

  const result = await f.process.reprocess(pending.transactionId);
  expect(result.status).toBe(Status.Rejected);
  expect(result.failureCode).toBe(FailureCode.ReferenceNotFound);
  expect(f.memory.outbox.map((event) => event.eventType)).toEqual([
    'WagerTransactionPendingReference',
    'WagerTransactionRejected',
  ]);
});
test('TTL expires even before the next scheduled attempt', async () => {
  const f = fixture({
    maxAttempts: 9,
    ttlMs: 100,
    baseDelayMs: 1000,
    maxDelayMs: 1000,
  });
  const wallet = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '0.00', currency: 'BRL' },
  });
  const pending = await f.process.execute({
    ...payload(wallet.id),
    kind: Kind.Refund,
    referenceExternalTransactionId: 'missing',
  });
  f.advance(100);

  expect((await f.process.reprocess(pending.transactionId)).status).toBe(
    Status.Rejected,
  );
});
test('inbox deduplicates and rejects divergent payload hashes', async () => {
  const f = fixture();
  const wallet = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const input = {
    ...payload(wallet.id),
    inbox: { consumerName: 'consumer', messageId: 'message' },
  };
  expect((await f.process.execute(input)).canAcknowledge).toBe(true);
  const count = f.memory.outbox.length;
  expect((await f.process.execute(input)).idempotentReplay).toBe(true);
  expect(f.memory.outbox).toHaveLength(count);
  expect(f.memory.inbox.size).toBe(1);
  await expectCode(
    f.process.execute({
      ...input,
      money: { amount: '20.00', currency: 'BRL' },
    }),
    'INBOX_CONFLICT',
  );
});
test('transient errors retry in a new callback with a bounded limit', async () => {
  const { withFinancialRetry } =
    await import('../../src/application/services/financial-retry.js');
  const f = fixture();
  const work = () =>
    f.memory.run(async () => {
      throw new FinancialApplicationError('WALLET_NOT_FOUND');
    });
  const wait = async (): Promise<void> => {};
  let attempts = 0;
  f.memory.run = async (work) => {
    attempts += 1;
    if (attempts < 3) {
      throw new PersistenceError('transient');
    }
    return work(f.memory.context);
  };
  await expectCode(
    withFinancialRetry(work, undefined, wait),
    'WALLET_NOT_FOUND',
  );
  expect(attempts).toBe(3);

  attempts = 0;
  f.memory.run = async () => {
    attempts += 1;
    throw new PersistenceError('transient');
  };
  await expectCode(
    withFinancialRetry(work, undefined, wait),
    'TRANSIENT_FAILURE',
  );
  expect(attempts).toBe(3);
});
test('inbox timestamps are defensively copied and processing is explicit', () => {
  const date = new Date('2026-01-01T00:00:00Z');
  const message = InboxMessage.receive({
    consumerName: 'consumer',
    messageId: 'message',
    payloadHash: 'hash',
    receivedAt: date,
  });
  date.setFullYear(2000);
  message.receivedAt.setFullYear(2001);
  expect(message.receivedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  message.markProcessed(message.receivedAt);
  expect(message.isProcessed()).toBe(true);
  expect(() => message.markProcessed(new Date())).toThrow();
});
test('event envelope and outbox nested payloads are immutable snapshots', () => {
  const data = {
    walletId: 'wallet',
    transactionId: 'tx',
    direction: LedgerDirection.Credit,
    money: { amount: '10.00', currency: 'BRL' },
    balanceBefore: { amount: '0.00', currency: 'BRL' },
    balanceAfter: { amount: '10.00', currency: 'BRL' },
    walletVersion: 1,
  };
  const date = new Date('2026-01-01T00:00:00Z');
  const event = WalletBalanceChanged.from({
    eventId: 'event',
    aggregateId: 'wallet',
    correlationId: 'correlation',
    occurredAt: date,
    data,
  });
  data.money.amount = '999.00';
  date.setFullYear(2000);
  event.occurredAt.setFullYear(2001);
  const outbox = OutboxMessage.enqueue(event);

  expect(event.toJSON().data.money.amount).toBe('10.00');
  expect(Reflect.set(event.data.money, 'amount', 'changed')).toBe(false);
  expect(event.toJSON().occurredAt).toBe('2026-01-01T00:00:00.000Z');
  expect(outbox.payload).toHaveProperty('version', 1);
  expect(outbox.payload).toHaveProperty('data.money.amount', '10.00');
  expect(outbox.isDue(new Date('2026-01-01T00:00:01Z'))).toBe(true);
  expect(Object.isFrozen(outbox.payload)).toBe(true);
});
test('known SQL uniqueness constraints retry only after a fresh transaction callback', async () => {
  for (const constraint of [
    'uq_wager_idempotency',
    'uq_wager_provider_external',
    'uq_wager_processed_reversal',
    'inbox_messages_pkey',
  ]) {
    const f = fixture();
    let attempts = 0;
    f.memory.run = async (work) => {
      attempts += 1;
      if (attempts === 1) {
        throw new PersistenceError('unique', constraint);
      }
      return work(f.memory.context);
    };

    await expectCode(f.process.execute(payload()), 'WALLET_NOT_FOUND');
    expect(attempts).toBe(2);
  }
});

test('reference found in rejected state is ineligible', async () => {
  const f = fixture();
  const w = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '0.00', currency: 'BRL' },
  });
  const failedBet = payload(w.id, 'bet');
  await f.process.execute(failedBet);
  const rejected = await f.process.execute({
    ...payload(w.id, 'refund'),
    kind: Kind.Refund,
    referenceExternalTransactionId: 'bet',
  });

  expect(rejected.status).toBe(Status.Rejected);
  expect(rejected.failureCode).toBe(FailureCode.InvalidReference);
});

test('reference mismatches are auditable business rejections', async () => {
  const f = fixture();
  const w = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  await f.process.execute(payload(w.id, 'bet'));
  const partial = await f.process.execute({
    ...payload(w.id, 'refund'),
    kind: Kind.Refund,
    money: { amount: '5.00', currency: 'BRL' },
    referenceExternalTransactionId: 'bet',
  });

  expect(partial.status).toBe(Status.Rejected);
  expect(partial.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
  expect(partial.balance?.amount).toBe('90.00');
});

test('permanent infrastructure errors are not recorded as financial rejections', async () => {
  const f = fixture();
  f.memory.run = async () => {
    throw new PersistenceError('permanent');
  };

  await expectCode(f.process.execute(payload()), 'PERMANENT_FAILURE');
  expect(f.memory.wagers.size).toBe(0);
  expect(f.memory.outbox).toHaveLength(0);
});
test('matching unprocessed inbox receipt can be completed without a hash conflict', async () => {
  const f = fixture();
  const w = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const input = {
    ...payload(w.id),
    inbox: { consumerName: 'consumer', messageId: 'message' },
  };
  f.memory.inbox.set('consumer:message', {
    ...input.inbox,
    payloadHash: inboxPayloadHash(input),
    receivedAt: new Date('2026-01-01T00:00:00Z'),
  });

  const result = await f.process.execute(input);

  expect(result.canAcknowledge).toBe(true);
  expect(f.memory.inbox.get('consumer:message')?.processedAt).toBeInstanceOf(
    Date,
  );
});
test('incompatible pending reference rejects before the original becomes terminal', async () => {
  const f = fixture();
  const w = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const first = await f.process.execute({
    ...payload(w.id, 'win-a'),
    kind: Kind.Win,
    referenceExternalTransactionId: 'bet',
  });
  const second = await f.process.execute({
    ...payload(w.id, 'win-b'),
    kind: Kind.Win,
    referenceExternalTransactionId: 'win-a',
  });
  expect(second.status).toBe(Status.Rejected);
  expect(second.failureCode).toBe(FailureCode.InvalidReferenceKind);

  await f.process.execute(payload(w.id, 'bet'));
  f.advance(1000);
  expect((await f.process.reprocess(first.transactionId)).status).toBe(
    Status.Processed,
  );
  const rejected = await f.process.reprocess(second.transactionId);

  expect(rejected.status).toBe(Status.Rejected);
  expect(rejected.failureCode).toBe(FailureCode.InvalidReferenceKind);
  expect(rejected.balance?.amount).toBe('100.00');
});

test('outbox rehydration preserves attempts and defensively copies nested data and dates', () => {
  const date = new Date('2026-01-01T00:00:00Z');
  const payload = { nested: { amount: '10.00' } };
  const message = OutboxMessage.rehydrate({
    id: 'event',
    aggregateId: 'wallet',
    eventType: 'test',
    payload,
    occurredAt: date,
    attempts: 2,
    nextAttemptAt: date,
    publishedAt: date,
  });
  payload.nested.amount = '99.00';
  date.setFullYear(2000);
  message.nextAttemptAt?.setFullYear(2001);
  message.publishedAt?.setFullYear(2002);

  expect(message.payload).toHaveProperty('nested.amount', '10.00');
  expect(message.attempts).toBe(2);
  expect(message.occurredAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  expect(message.nextAttemptAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  expect(message.publishedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  expect(message.isPending()).toBe(false);
  expect(message.isDue(new Date())).toBe(false);
});

test('inbox hash includes idempotency key and excludes redelivery metadata', async () => {
  const input = payload();
  const redelivery = {
    ...input,
    correlationId: 'new',
    receiptHandle: 'new',
    receiveCount: 2,
  };

  expect(inboxPayloadHash(redelivery)).toBe(inboxPayloadHash(input));
  expect(inboxPayloadHash({ ...input, idempotencyKey: 'other' })).not.toBe(
    inboxPayloadHash(input),
  );
  expect(
    canonicalPayloadHash({
      ...input,
      idempotencyKey: 'other',
    } as ProcessWagerInput),
  ).toBe(canonicalPayloadHash(input));

  const f = fixture();
  const w = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const message = {
    ...payload(w.id),
    inbox: { consumerName: 'consumer', messageId: 'message' },
  };
  await f.process.execute(message);
  await expectCode(
    f.process.execute({ ...message, idempotencyKey: 'other' }),
    'INBOX_CONFLICT',
  );
});

test('every inbox receipt used by final deduplication has its hash checked', async () => {
  const f = fixture();
  const w = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  let reads = 0;
  f.memory.context.inbox.find = async () => {
    reads += 1;
    return reads === 1
      ? undefined
      : {
          consumerName: 'consumer',
          messageId: 'message',
          payloadHash: 'divergent',
          receivedAt: new Date(),
        };
  };

  await expectCode(
    f.process.execute({
      ...payload(w.id),
      inbox: { consumerName: 'consumer', messageId: 'message' },
    }),
    'INBOX_CONFLICT',
  );

  expect(reads).toBe(2);
});

test('infrastructure retry waits only for transient failures and stops at three attempts', async () => {
  const { withFinancialRetry } =
    await import('../../src/application/services/financial-retry.js');
  const waits: number[] = [];
  const wait = async (milliseconds: number): Promise<void> => {
    waits.push(milliseconds);
  };
  let attempts = 0;
  const value = await withFinancialRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new PersistenceError('transient');
      }
      return 'ok';
    },
    undefined,
    wait,
  );

  expect(value).toBe('ok');
  expect(waits).toEqual([25, 50]);
  expect(Math.max(...waits)).toBeLessThanOrEqual(100);
  waits.length = 0;
  attempts = 0;
  await expectCode(
    withFinancialRetry(
      async () => {
        attempts += 1;
        throw new PersistenceError('transient');
      },
      undefined,
      wait,
    ),
    'TRANSIENT_FAILURE',
  );
  expect(attempts).toBe(3);
  expect(waits).toEqual([25, 50]);
  waits.length = 0;
  attempts = 0;
  await withFinancialRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new PersistenceError('unique', 'inbox_messages_pkey');
      }
    },
    undefined,
    wait,
  );
  expect(attempts).toBe(2);
  expect(waits).toEqual([]);
  attempts = 0;
  await expectCode(
    withFinancialRetry(
      async () => {
        attempts += 1;
        throw new PersistenceError('permanent');
      },
      undefined,
      wait,
    ),
    'PERMANENT_FAILURE',
  );
  expect(attempts).toBe(1);
  expect(waits).toEqual([]);
});

for (const [change, code] of [
  [{}, undefined],
  [{ walletId: 'other' }, FailureCode.ReferenceContextMismatch],
  [{ playerId: 'other' }, FailureCode.ReferenceContextMismatch],
  [
    { money: { amount: '10.00', currency: 'USD' } },
    FailureCode.ReferenceContextMismatch,
  ],
  [{ kind: Kind.Loss }, FailureCode.InvalidReferenceKind],
  [
    { money: { amount: '11.00', currency: 'BRL' } },
    FailureCode.ReferenceAmountMismatch,
  ],
] as const) {
  test(
    'pending reference is structurally validated ' + JSON.stringify(change),
    async () => {
      const { WagerTransaction } =
        await import('../../src/domain/entities/wager-transaction.js');
      const { Money } = await import('../../src/domain/value-objects/money.js');
      const f = fixture();
      const w = await f.open.execute({
        playerId: 'player',
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const ref = { ...payload(w.id, 'reference'), ...change };
      const reference = WagerTransaction.create({
        ...ref,
        id: 'reference-id',
        payloadHash: canonicalPayloadHash(ref),
        money: Money.from(ref.money),
        createdAt: new Date(),
      });
      f.memory.wagers.set(reference.id, {
        transaction: reference,
        referenceAttempts: 0,
      });
      const entries = f.memory.entries.length;

      const result = await f.process.execute({
        ...payload(w.id, 'refund'),
        kind: Kind.Refund,
        referenceExternalTransactionId: 'reference',
      });

      expect(result.status).toBe(
        code ? Status.Rejected : Status.PendingReference,
      );
      expect(result.failureCode).toBe(code);
      expect(f.memory.wallets.get(w.id)?.balance.toString()).toBe('100.00');
      expect(f.memory.wallets.get(w.id)?.version).toBe(1);
      expect(f.memory.entries).toHaveLength(entries);
    },
  );
}

test('self reference rejects immediately without a financial movement', async () => {
  const f = fixture();
  const w = await f.open.execute({
    playerId: 'player',
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });

  const result = await f.process.execute({
    ...payload(w.id, 'self'),
    kind: Kind.Refund,
    referenceExternalTransactionId: 'self',
  });

  expect(result.status).toBe(Status.Rejected);
  expect(result.failureCode).toBe(FailureCode.InvalidReference);
  expect(f.memory.entries).toHaveLength(1);
  expect(result.balance?.amount).toBe('100.00');
});
