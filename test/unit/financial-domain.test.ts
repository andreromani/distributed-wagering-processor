import { test, expect } from 'bun:test';
import { Money } from '../../src/domain/value-objects/money.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import {
  WalletLedgerEntry,
  type LedgerEntryState,
} from '../../src/domain/entities/wallet-ledger-entry.js';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../../src/domain/entities/wager-transaction.js';
import {
  LedgerDirection as Direction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../../src/domain/financial.types.js';
import { FinancialRuleError } from '../../src/domain/errors/financial-rule.error.js';
import { InvalidTransactionStateError } from '../../src/domain/errors/invalid-transaction-state.error.js';

const money = (amount: string, currency = 'BRL') =>
  Money.rehydrate({ amount, currency });

const at = () => new Date('2026-01-01T00:00:00Z');

const context = () => ({
  transactionId: 'tx',
  ledgerEntryId: 'entry',
  at: at(),
});

const open = (amount = '100.00') =>
  Wallet.open({
    id: 'wallet',
    playerId: 'player',
    initialBalance: money(amount),
    at: at(),
    opening: {
      transactionId: 'opening',
      ledgerEntryId: 'opening-entry',
      payloadHash: 'hash',
    },
  });

const props = (kind = Kind.Bet): CreateWagerTransactionProps => ({
  id: 'tx',
  providerId: 'provider',
  externalTransactionId: 'external',
  idempotencyKey: 'key',
  payloadHash: 'hash',
  walletId: 'wallet',
  playerId: 'player',
  roundId: 'round',
  gameId: 'game',
  kind,
  money: money('10.00'),
  createdAt: at(),
  referenceExternalTransactionId:
    kind === Kind.Refund || kind === Kind.Rollback ? 'external' : undefined,
});

const processed = (kind = Kind.Bet) => {
  const tx = WagerTransaction.create({ ...props(kind), id: 'reference' });
  tx.markProcessed(kind === Kind.Refund ? 'original-bet' : undefined, at());

  return tx;
};

const ledger = (): LedgerEntryState => ({
  id: 'entry',
  walletId: 'wallet',
  transactionId: 'tx',
  direction: Direction.Debit,
  money: money('10.00'),
  balanceBefore: money('100.00'),
  balanceAfter: money('90.00'),
  createdAt: at(),
});

function expectCode(action: () => unknown, code: FailureCode) {
  try {
    action();
    throw new Error('Expected business failure');
  } catch (error) {
    expect(error).toBeInstanceOf(FinancialRuleError);

    if (error instanceof FinancialRuleError) expect(error.code).toBe(code);
  }
}

test('zero opening and positive opening keep version one and return matching accounting records', () => {
  const zero = open('0.00');

  expect(zero.wallet.version).toBe(1);
  expect(zero.openingEntry).toBeUndefined();
  expect(zero.openingTransaction).toBeUndefined();

  const result = open();

  expect(result.wallet.version).toBe(1);
  expect(result.openingTransaction?.kind).toBe(Kind.Opening);
  expect(result.openingTransaction?.status).toBe(Status.Processed);
  expect(result.openingEntry?.transactionId).toBe(
    result.openingTransaction?.id,
  );
  expect(result.openingEntry?.balanceBefore.toString()).toBe('0.00');
  expect(result.openingEntry?.balanceAfter.equals(result.wallet.balance)).toBe(
    true,
  );
});

test('opening rejects negative balance and missing opening accounting context', () => {
  expectCode(() => open('-0.01'), FailureCode.InvalidAmount);
  expectCode(
    () =>
      Wallet.open({
        id: 'wallet',
        playerId: 'player',
        initialBalance: money('1.00'),
        at: at(),
      }),
    FailureCode.InvalidReference,
  );
});

test('debit and credit produce balanced entries and increment version', () => {
  const { wallet } = open();

  const debit = wallet.debit(money('10.00'), context());

  expect(debit.direction).toBe(Direction.Debit);
  expect(debit.balanceBefore.toString()).toBe('100.00');
  expect(debit.balanceAfter.toString()).toBe('90.00');
  expect(wallet.version).toBe(2);

  const credit = wallet.credit(money('5.00'), context());

  expect(credit.isBalanced()).toBe(true);
  expect(wallet.balance.toString()).toBe('95.00');
  expect(wallet.version).toBe(3);
});

test('debit can consume exactly the balance', () => {
  const { wallet } = open();

  wallet.debit(money('100.00'), context());

  expect(wallet.balance.isZero()).toBe(true);
});

for (const method of ['debit', 'credit'] as const) {
  for (const amount of ['0.00', '-0.01'])
    test(method + ' rejects ' + amount + ' without changing wallet', () => {
      const { wallet } = open();

      expectCode(
        () => wallet[method](money(amount), context()),
        FailureCode.InvalidAmount,
      );

      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(at());
    });

  test(method + ' rejects currency mismatch', () => {
    const { wallet } = open();

    expectCode(
      () => wallet[method](money('1.00', 'USD'), context()),
      FailureCode.CurrencyMismatch,
    );

    expect(wallet.version).toBe(1);
  });

  test(method + ' invalid timestamp leaves all state intact', () => {
    const { wallet } = open();

    expectCode(
      () =>
        wallet[method](money('1.00'), {
          ...context(),
          at: new Date('invalid'),
        }),
      FailureCode.InvalidTimestamp,
    );

    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(at());
  });
}

test('insufficient funds leaves wallet intact', () => {
  const { wallet } = open();

  expectCode(
    () => wallet.debit(money('100.01'), context()),
    FailureCode.InsufficientFunds,
  );

  expect(wallet.version).toBe(1);
  expect(wallet.balance.toString()).toBe('100.00');
});

test('wallet rehydration restores state and protects dates and identity', () => {
  const date = at();
  const wallet = Wallet.rehydrate({
    id: 'wallet',
    playerId: 'player',
    currency: 'BRL',
    balance: money('12.00'),
    version: 7,
    createdAt: date,
    updatedAt: date,
  });
  date.setFullYear(2000);
  wallet.createdAt.setFullYear(2001);
  wallet.updatedAt.setFullYear(2002);

  expect(wallet.createdAt).toEqual(at());
  expect(wallet.updatedAt).toEqual(at());
  expect(wallet.version).toBe(7);
  expect(Reflect.set(wallet, 'balance', money('99.00'))).toBe(false);
  expect(Reflect.set(wallet, 'id', 'changed')).toBe(false);
});

for (const direction of Object.values(Direction))
  test('ledger validates ' + direction, () => {
    const entry = WalletLedgerEntry.create({
      ...ledger(),
      direction,
      balanceAfter: money(direction === Direction.Debit ? '90.00' : '110.00'),
    });

    expect(entry.isBalanced()).toBe(true);
  });

test('ledger rejects unbalanced arithmetic', () => {
  expectCode(
    () =>
      WalletLedgerEntry.create({ ...ledger(), balanceAfter: money('80.00') }),
    FailureCode.InvalidLedger,
  );
});

test('ledger rejects invalid direction at runtime', () => {
  expectCode(
    () =>
      WalletLedgerEntry.create({
        ...ledger(),
        direction: 'OTHER' as Direction,
      }),
    FailureCode.InvalidLedger,
  );
});

for (const field of ['money', 'balanceBefore', 'balanceAfter'] as const) {
  test('ledger rejects incompatible currency in ' + field, () => {
    expectCode(
      () =>
        WalletLedgerEntry.create({
          ...ledger(),
          [field]: money('10.00', 'USD'),
        }),
      FailureCode.CurrencyMismatch,
    );
  });

  test('ledger rejects negative ' + field, () => {
    expectCode(
      () => WalletLedgerEntry.create({ ...ledger(), [field]: money('-1.00') }),
      FailureCode.InvalidAmount,
    );
  });
}

test('ledger rejects zero movement', () => {
  expectCode(
    () => WalletLedgerEntry.create({ ...ledger(), money: money('0.00') }),
    FailureCode.InvalidAmount,
  );
});

test('ledger is immutable and rehydrate does not replay create validation', () => {
  const state = ledger();
  const entry = WalletLedgerEntry.rehydrate({
    ...state,
    balanceAfter: money('80.00'),
  });

  expect(entry.isBalanced()).toBe(false);

  state.createdAt.setFullYear(2000);
  entry.createdAt.setFullYear(2001);

  expect(entry.createdAt).toEqual(at());
  expect(Object.isFrozen(entry)).toBe(true);
  expect(Reflect.set(entry, 'money', money('1.00'))).toBe(false);
});

for (const kind of [Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])
  test('creates pending ' + kind, () => {
    const tx = WagerTransaction.create(props(kind));

    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.matchesPayload('hash')).toBe(true);
    expect(tx.matchesPayload('different')).toBe(false);
    expect(tx.requiresReference()).toBe(
      kind === Kind.Refund || kind === Kind.Rollback,
    );
    expect(tx.affectsBalance()).toBe(kind !== Kind.Loss);
  });

test('external OPENING and invalid kind are rejected', () => {
  expectCode(
    () => WagerTransaction.create(props(Kind.Opening)),
    FailureCode.ExternalOpeningForbidden,
  );
  expectCode(
    () => WagerTransaction.create({ ...props(), kind: 'INVALID' as Kind }),
    FailureCode.InvalidKind,
  );
});

for (const kind of [
  Kind.Bet,
  Kind.Win,
  Kind.Loss,
  Kind.Refund,
  Kind.Rollback,
]) {
  test('negative amount rejected for ' + kind, () => {
    expectCode(
      () => WagerTransaction.create({ ...props(kind), money: money('-0.01') }),
      FailureCode.InvalidAmount,
    );
  });
}

for (const kind of [Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])
  test('zero movement rejected for ' + kind, () => {
    expectCode(
      () => WagerTransaction.create({ ...props(kind), money: money('0.00') }),
      FailureCode.InvalidAmount,
    );
  });

for (const kind of [Kind.Loss])
  test('zero outcome accepted for ' + kind, () => {
    const { wallet } = open();
    const tx = WagerTransaction.create({
      ...props(kind),
      money: money('0.00'),
    });

    expect(tx.applyTo(wallet, context())).toBeUndefined();
    expect(wallet.version).toBe(1);
    expect(tx.status).toBe(Status.Processed);
  });

for (const kind of [Kind.Refund, Kind.Rollback])
  test(kind + ' requires external reference', () => {
    expectCode(
      () =>
        WagerTransaction.create({
          ...props(kind),
          referenceExternalTransactionId: undefined,
        }),
      FailureCode.InvalidReference,
    );
  });

for (const from of [Status.Pending, Status.PendingReference]) {
  for (const to of [Status.Processed, Status.Rejected, Status.Failed])
    test(from + ' transitions to ' + to, () => {
      const tx = WagerTransaction.create(props(Kind.Refund));
      if (from === Status.PendingReference) tx.markPendingReference();
      if (to === Status.Processed) tx.markProcessed('reference', at());
      if (to === Status.Rejected) tx.reject(FailureCode.InvalidReference);
      if (to === Status.Failed)
        tx.fail(FailureCode.PermanentInfrastructureFailure);

      expect(tx.status).toBe(to);
      expect(tx.isTerminal()).toBe(true);

      if (to !== Status.Processed) expect(tx.failureCode).toBeDefined();
    });
}

for (const status of [Status.Processed, Status.Rejected, Status.Failed])
  test('terminal ' + status + ' forbids all mutations', () => {
    const tx = WagerTransaction.rehydrate({ ...props(Kind.Refund), status });
    for (const action of [
      () => tx.markProcessed('ref', at()),
      () => tx.markPendingReference(),
      () => tx.reject(FailureCode.InvalidAmount),
      () => tx.fail(FailureCode.PermanentInfrastructureFailure),
      () => tx.applyTo(open().wallet, context(), processed()),
    ])
      expect(action).toThrow(InvalidTransactionStateError);
  });

test('pending reference can be retried and processed later', () => {
  const tx = WagerTransaction.create(props(Kind.Refund));
  const { wallet } = open();

  expect(tx.applyTo(wallet, context())).toBeUndefined();
  expect(tx.status).toBe(Status.PendingReference);

  tx.markPendingReference();

  expect(tx.applyTo(wallet, context(), processed())?.direction).toBe(
    Direction.Credit,
  );
  expect(tx.referenceTransactionId).toBe('reference');
});

test('transaction dates and rehydrated state are protected', () => {
  const date = at();
  const tx = WagerTransaction.rehydrate({
    ...props(),
    createdAt: date,
    status: Status.Rejected,
    failureCode: FailureCode.InvalidAmount,
    referenceTransactionId: 'ref',
    processedAt: date,
  });
  date.setFullYear(2000);
  tx.createdAt.setFullYear(2001);
  tx.processedAt?.setFullYear(2002);

  expect(tx.createdAt).toEqual(at());
  expect(tx.processedAt).toEqual(at());
  expect(tx.failureCode).toBe(FailureCode.InvalidAmount);
  expect(tx.referenceTransactionId).toBe('ref');
  expect(tx.status).toBe(Status.Rejected);
});

for (const [kind, referenceKind, direction, balance] of [
  [Kind.Bet, undefined, Direction.Debit, '90.00'],
  [Kind.Win, undefined, Direction.Credit, '110.00'],
  [Kind.Refund, Kind.Bet, Direction.Credit, '110.00'],
  [Kind.Rollback, Kind.Bet, Direction.Credit, '110.00'],
  [Kind.Rollback, Kind.Win, Direction.Debit, '90.00'],
  [Kind.Rollback, Kind.Refund, Direction.Debit, '90.00'],
] as const)
  test('financial effect ' + kind + ' referencing ' + referenceKind, () => {
    const { wallet } = open();
    const tx = WagerTransaction.create(props(kind));
    const reference =
      referenceKind === undefined ? undefined : processed(referenceKind);

    expect(tx.ledgerDirectionFor(reference)).toBe(direction);

    const entry = tx.applyTo(wallet, context(), reference);

    expect(entry?.direction).toBe(direction);
    expect(wallet.balance.toString()).toBe(balance);
    expect(tx.status).toBe(Status.Processed);
  });

test('positive LOSS records outcome without financial effect', () => {
  const { wallet } = open();
  const tx = WagerTransaction.create(props(Kind.Loss));

  expect(tx.applyTo(wallet, context())).toBeUndefined();
  expect(wallet.version).toBe(1);
  expect(wallet.balance.toString()).toBe('100.00');

  expectCode(() => tx.ledgerDirectionFor(), FailureCode.InvalidLedger);
});

for (const field of ['providerId', 'playerId', 'walletId', 'roundId'] as const)
  test('reference rejects differing ' + field, () => {
    const tx = WagerTransaction.create(props(Kind.Refund));
    const reference = WagerTransaction.rehydrate({
      ...props(),
      id: 'ref',
      [field]: 'different',
      status: Status.Processed,
    });
    const { wallet } = open();

    expectCode(
      () => tx.applyTo(wallet, context(), reference),
      FailureCode.ReferenceContextMismatch,
    );

    expect(wallet.version).toBe(1);
  });

test('reference rejects currency mismatch', () => {
  const reference = WagerTransaction.rehydrate({
    ...props(),
    id: 'ref',
    money: money('10.00', 'USD'),
    status: Status.Processed,
  });

  expectCode(
    () =>
      WagerTransaction.create(props(Kind.Refund)).validateReference(reference),
    FailureCode.ReferenceContextMismatch,
  );
});

test('partial reversal fails without changing financial state', () => {
  const { wallet } = open();
  const tx = WagerTransaction.create({
    ...props(Kind.Refund),
    money: money('5.00'),
  });

  expectCode(
    () => tx.applyTo(wallet, context(), processed()),
    FailureCode.ReferenceAmountMismatch,
  );

  expect(wallet.version).toBe(1);
  expect(tx.status).toBe(Status.Pending);
});

for (const kind of [Kind.Loss, Kind.Rollback, Kind.Opening])
  test('rollback rejects reference kind ' + kind, () => {
    const reference = WagerTransaction.rehydrate({
      ...props(kind),
      id: 'ref',
      status: Status.Processed,
    });

    expectCode(
      () =>
        WagerTransaction.create(props(Kind.Rollback)).validateReference(
          reference,
        ),
      FailureCode.InvalidReferenceKind,
    );
  });

test('refund rejects WIN reference', () => {
  expectCode(
    () =>
      WagerTransaction.create(props(Kind.Refund)).validateReference(
        processed(Kind.Win),
      ),
    FailureCode.InvalidReferenceKind,
  );
});

for (const status of [
  Status.Pending,
  Status.PendingReference,
  Status.Rejected,
  Status.Failed,
])
  test('reference must be processed, got ' + status, () => {
    const reference = WagerTransaction.rehydrate({
      ...props(),
      id: 'ref',
      status,
    });

    expectCode(
      () =>
        WagerTransaction.create(props(Kind.Refund)).validateReference(
          reference,
        ),
      FailureCode.InvalidReference,
    );
  });

test('reference must match external identifier', () => {
  const tx = WagerTransaction.create({
    ...props(Kind.Refund),
    referenceExternalTransactionId: 'different',
  });

  expectCode(
    () => tx.validateReference(processed()),
    FailureCode.InvalidReference,
  );
});

test('insufficient balance distinguishes bet from reversal', () => {
  for (const kind of [Kind.Bet, Kind.Rollback]) {
    const { wallet } = open('1.00');
    const tx = WagerTransaction.create(props(kind));

    expectCode(
      () =>
        tx.applyTo(
          wallet,
          context(),
          kind === Kind.Rollback ? processed(Kind.Win) : undefined,
        ),
      kind === Kind.Bet
        ? FailureCode.InsufficientFunds
        : FailureCode.InsufficientReversalFunds,
    );
    tx.reject(
      kind === Kind.Bet
        ? FailureCode.InsufficientFunds
        : FailureCode.InsufficientReversalFunds,
    );

    expect(wallet.balance.toString()).toBe('1.00');
    expect(wallet.version).toBe(1);
  }
});

test('rejected transaction cannot move balance', () => {
  const { wallet } = open();
  const tx = WagerTransaction.create(props());
  tx.reject(FailureCode.InvalidAmount);

  expect(() => tx.applyTo(wallet, context())).toThrow(
    InvalidTransactionStateError,
  );
  expect(wallet.version).toBe(1);
});

test('ledger reconstructs final balance including opening, bet, win, refund and rollback', () => {
  const { wallet, openingEntry } = open();
  const entries: WalletLedgerEntry[] = [];
  if (openingEntry) entries.push(openingEntry);

  const bet = WagerTransaction.create(props());

  const betEntry = bet.applyTo(wallet, context());
  if (betEntry) entries.push(betEntry);

  const refund = WagerTransaction.create({
    ...props(Kind.Refund),
    id: 'refund',
    externalTransactionId: 'refund',
  });

  const refundEntry = refund.applyTo(wallet, context(), bet);
  if (refundEntry) entries.push(refundEntry);

  const rollback = WagerTransaction.create({
    ...props(Kind.Rollback),
    referenceExternalTransactionId: 'refund',
  });

  const rollbackEntry = rollback.applyTo(wallet, context(), refund);
  if (rollbackEntry) entries.push(rollbackEntry);

  let calculated = Money.zero('BRL');
  for (const entry of entries)
    calculated =
      entry.direction === Direction.Credit
        ? calculated.add(entry.money)
        : calculated.subtract(entry.money);

  expect(wallet.balance.equals(calculated)).toBe(true);
});

test('wallet credit overflow fails before changing any state', () => {
  const { wallet } = open('9999999999999999999999999999.99');

  expect(() => wallet.credit(money('0.01'), context())).toThrow();
  expect(wallet.version).toBe(1);
  expect(wallet.balance.toString()).toBe('9999999999999999999999999999.99');
  expect(wallet.updatedAt).toEqual(at());
});

test('internal opening is explicit and requires positive money', () => {
  const tx = WagerTransaction.opening({
    id: 'opening',
    walletId: 'wallet',
    playerId: 'player',
    money: money('1.00'),
    payloadHash: 'hash',
    createdAt: at(),
  });

  expect(tx.status).toBe(Status.Pending);
  expect(tx.ledgerDirectionFor()).toBe(Direction.Credit);

  for (const amount of ['0.00', '-1.00'])
    expectCode(
      () =>
        WagerTransaction.opening({
          id: 'opening',
          walletId: 'wallet',
          playerId: 'player',
          money: money(amount),
          payloadHash: 'hash',
          createdAt: at(),
        }),
      FailureCode.InvalidAmount,
    );
});

test('markProcessed rejects missing reversal reference and invalid dates without mutation', () => {
  const tx = WagerTransaction.create(props(Kind.Refund));

  expectCode(
    () => tx.markProcessed(undefined, at()),
    FailureCode.InvalidReference,
  );
  expectCode(
    () => tx.markProcessed('ref', new Date('invalid')),
    FailureCode.InvalidTimestamp,
  );

  expect(tx.status).toBe(Status.Pending);
  expect(tx.referenceTransactionId).toBeUndefined();
  expect(tx.processedAt).toBeUndefined();
});

test('nonreferenced transaction cannot enter pending reference', () => {
  expect(() => WagerTransaction.create(props()).markPendingReference()).toThrow(
    InvalidTransactionStateError,
  );
});

test('self reference is ineligible', () => {
  const tx = WagerTransaction.create(props(Kind.Refund));
  const reference = WagerTransaction.rehydrate({
    ...props(),
    status: Status.Processed,
  });

  expectCode(
    () => tx.validateReference(reference),
    FailureCode.InvalidReference,
  );
});

test('optional WIN reference validates BET and can await a missing reference', () => {
  const tx = WagerTransaction.create({
    ...props(Kind.Win),
    referenceExternalTransactionId: 'external',
  });
  const { wallet } = open();

  expect(tx.applyTo(wallet, context())).toBeUndefined();
  expect(tx.status).toBe(Status.PendingReference);

  tx.applyTo(wallet, context(), processed());

  expect(wallet.balance.toString()).toBe('110.00');
});

test('application to a different wallet rejects without state changes', () => {
  const { wallet } = open();
  const tx = WagerTransaction.create({ ...props(), walletId: 'other' });

  expectCode(
    () => tx.applyTo(wallet, context()),
    FailureCode.ReferenceContextMismatch,
  );

  expect(wallet.version).toBe(1);
  expect(tx.status).toBe(Status.Pending);
});

test('application rejects different wallet currency without changes', () => {
  const { wallet } = open();
  const tx = WagerTransaction.create({
    ...props(),
    money: money('1.00', 'USD'),
  });

  expectCode(() => tx.applyTo(wallet, context()), FailureCode.CurrencyMismatch);

  expect(wallet.version).toBe(1);
});

test('processed timestamps are copied from transition input', () => {
  const tx = WagerTransaction.create(props());
  const date = at();
  tx.markProcessed(undefined, date);
  date.setFullYear(2000);
  tx.processedAt?.setFullYear(2001);

  expect(tx.processedAt).toEqual(at());
});

test('a supplied reference must have been declared by the transaction', () => {
  const tx = WagerTransaction.create(props(Kind.Win));
  const { wallet } = open();

  expectCode(
    () => tx.applyTo(wallet, context(), processed()),
    FailureCode.InvalidReference,
  );

  expect(wallet.version).toBe(1);
  expect(tx.status).toBe(Status.Pending);
});

for (const kind of [Kind.Win, Kind.Refund, Kind.Rollback]) {
  for (const field of [
    'providerId',
    'playerId',
    'walletId',
    'roundId',
    'money',
  ] as const) {
    test(kind + ' validates reference context field ' + field, () => {
      const tx = WagerTransaction.create({
        ...props(kind),
        referenceExternalTransactionId: 'external',
      });
      const reference = WagerTransaction.rehydrate({
        ...props(),
        id: 'reference',
        status: Status.Processed,
        [field]: field === 'money' ? money('10.00', 'USD') : 'different',
      });
      const { wallet } = open();

      expectCode(
        () => tx.applyTo(wallet, context(), reference),
        FailureCode.ReferenceContextMismatch,
      );

      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(at());
    });
  }
}

test('WIN accepts a different prize and gameId for a BET in the same context', () => {
  const tx = WagerTransaction.create({
    ...props(Kind.Win),
    money: money('25.00'),
    gameId: 'another-game',
    referenceExternalTransactionId: 'external',
  });
  const { wallet } = open();

  const entry = tx.applyTo(wallet, context(), processed());

  expect(entry?.direction).toBe(Direction.Credit);
  expect(entry?.money.toString()).toBe('25.00');
  expect(tx.referenceTransactionId).toBe('reference');
  expect(wallet.balance.toString()).toBe('125.00');
});

for (const kind of [Kind.Win, Kind.Refund, Kind.Rollback]) {
  for (const status of [
    Status.Pending,
    Status.PendingReference,
    Status.Rejected,
    Status.Failed,
  ]) {
    test(kind + ' rejects a reference in ' + status, () => {
      const tx = WagerTransaction.create({
        ...props(kind),
        referenceExternalTransactionId: 'external',
      });
      const reference = WagerTransaction.rehydrate({
        ...props(),
        id: 'ref',
        status,
      });

      expectCode(
        () => tx.validateReference(reference),
        FailureCode.InvalidReference,
      );
    });
  }
}

test('WIN with absent declared reference preserves financial state', () => {
  const tx = WagerTransaction.create({
    ...props(Kind.Win),
    referenceExternalTransactionId: 'missing',
  });
  const { wallet } = open();

  expect(tx.applyTo(wallet, context())).toBeUndefined();
  expect(tx.status).toBe(Status.PendingReference);
  expect(wallet.balance.toString()).toBe('100.00');
  expect(wallet.version).toBe(1);
  expect(wallet.updatedAt).toEqual(at());
});

test('WIN reference must be BET', () => {
  const tx = WagerTransaction.create({
    ...props(Kind.Win),
    referenceExternalTransactionId: 'external',
  });

  expectCode(
    () => tx.validateReference(processed(Kind.Win)),
    FailureCode.InvalidReferenceKind,
  );
});

for (const status of [Status.Processed, Status.Rejected, Status.Failed]) {
  test('terminal ' + status + ' preserves wallet on applyTo', () => {
    const tx = WagerTransaction.rehydrate({ ...props(), status });
    const { wallet } = open();

    expect(() => tx.applyTo(wallet, context())).toThrow(
      InvalidTransactionStateError,
    );
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(at());
  });
}

test('positive opening returns exactly one processed opening and one credit at version one', () => {
  const result = open();

  expect(Object.keys(result).sort()).toEqual([
    'openingEntry',
    'openingTransaction',
    'wallet',
  ]);
  expect(result.openingTransaction?.kind).toBe(Kind.Opening);
  expect(result.openingTransaction?.status).toBe(Status.Processed);
  expect(result.openingEntry?.direction).toBe(Direction.Credit);
  expect(result.openingEntry?.transactionId).toBe(
    result.openingTransaction?.id,
  );
  expect(result.openingEntry?.money.equals(result.wallet.balance)).toBe(true);
  expect(result.wallet.version).toBe(1);
  expect(() =>
    result.openingTransaction?.applyTo(result.wallet, context()),
  ).toThrow(InvalidTransactionStateError);
  expect(result.wallet.version).toBe(1);
  expect(result.wallet.balance.toString()).toBe('100.00');
});
