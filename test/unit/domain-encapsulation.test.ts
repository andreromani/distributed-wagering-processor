import { test, expect } from 'bun:test';
import { Money } from '../../src/domain/value-objects/money.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { WalletLedgerEntry } from '../../src/domain/entities/wallet-ledger-entry.js';
import { WagerTransaction } from '../../src/domain/entities/wager-transaction.js';
import {
  LedgerDirection,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/financial.types.js';

const at = new Date('2026-01-01T00:00:00Z');
const money = Money.from({ amount: '10.00', currency: 'BRL' });

test('transaction public readonly fields remain readable and frozen at runtime', () => {
  const state = {
    id: 'tx',
    providerId: 'provider',
    externalTransactionId: 'external',
    idempotencyKey: 'key',
    payloadHash: 'hash',
    walletId: 'wallet',
    playerId: 'player',
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Bet,
    money,
    referenceExternalTransactionId: undefined,
    createdAt: at,
    status: Status.Pending,
  };
  const transaction = WagerTransaction.rehydrate(state);
  const keys = [
    'id',
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'payloadHash',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
    'kind',
    'money',
    'referenceExternalTransactionId',
  ] as const;

  expect(Object.isFrozen(transaction)).toBe(true);
  for (const key of keys) {
    expect(transaction[key]).toBe(state[key]);
    expect(Reflect.set(transaction, key, 'changed')).toBe(false);
    expect(transaction[key]).toBe(state[key]);
  }
  expect(Reflect.set(transaction, 'status', Status.Rejected)).toBe(false);

  transaction.markProcessed(undefined, at);

  expect(transaction.status).toBe(Status.Processed);
  expect(transaction.createdAt).not.toBe(at);
  expect(transaction.processedAt).not.toBe(at);
});

test('wallet public identity is frozen while business methods update private state', () => {
  const wallet = Wallet.open({
    id: 'wallet',
    playerId: 'player',
    initialBalance: Money.zero('BRL'),
    at,
  }).wallet;

  expect(Object.isFrozen(wallet)).toBe(true);
  for (const key of [
    'id',
    'playerId',
    'currency',
    'balance',
    'version',
  ] as const) {
    const original = wallet[key];
    expect(Reflect.set(wallet, key, 'changed')).toBe(false);
    expect(wallet[key]).toBe(original);
  }

  const credit = wallet.credit(money, {
    transactionId: 'credit',
    ledgerEntryId: 'credit-entry',
    at,
  });
  const debit = wallet.debit(money, {
    transactionId: 'debit',
    ledgerEntryId: 'debit-entry',
    at,
  });

  expect(credit.isBalanced()).toBe(true);
  expect(debit.isBalanced()).toBe(true);
  expect(wallet.balance.isZero()).toBe(true);
  expect(wallet.version).toBe(3);
});

test('ledger public readonly properties cannot be replaced', () => {
  const state = {
    id: 'entry',
    walletId: 'wallet',
    transactionId: 'tx',
    direction: LedgerDirection.Credit,
    money,
    balanceBefore: Money.zero('BRL'),
    balanceAfter: money,
    createdAt: at,
  };
  const entry = WalletLedgerEntry.create(state);

  expect(Object.isFrozen(entry)).toBe(true);
  for (const key of [
    'id',
    'walletId',
    'transactionId',
    'direction',
    'money',
    'balanceBefore',
    'balanceAfter',
  ] as const) {
    expect(entry[key]).toBe(state[key]);
    expect(Reflect.set(entry, key, 'changed')).toBe(false);
    expect(entry[key]).toBe(state[key]);
  }

  entry.createdAt.setFullYear(2000);

  expect(entry.createdAt).toEqual(at);
  expect(entry.isBalanced()).toBe(true);
});

test('enumeration exposes only public immutable transaction fields', () => {
  const transaction = WagerTransaction.opening({
    id: 'tx',
    walletId: 'wallet',
    playerId: 'player',
    money,
    payloadHash: 'hash',
    createdAt: at,
  });
  const keys = [
    'id',
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'payloadHash',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
    'kind',
    'money',
    'referenceExternalTransactionId',
  ];

  const publicFields: Pick<WagerTransaction, 'money'> = transaction;

  expect(Object.keys(transaction)).toEqual(keys);
  expect({ ...publicFields }.money).toBe(money);
  expect(JSON.parse(JSON.stringify(transaction))).toEqual({
    id: 'tx',
    providerId: 'internal',
    externalTransactionId: 'tx',
    idempotencyKey: 'opening:wallet',
    payloadHash: 'hash',
    walletId: 'wallet',
    playerId: 'player',
    roundId: 'opening:wallet',
    gameId: 'internal',
    kind: Kind.Opening,
    money: { amount: '10.00', currency: 'BRL' },
  });
  expect(Object.keys(transaction)).not.toContain('status');
  expect(Object.keys(transaction)).not.toContain('createdAt');
});

test('wallet enumeration contains identity without private balance or timestamps', () => {
  const wallet = Wallet.open({
    id: 'wallet',
    playerId: 'player',
    initialBalance: Money.zero('BRL'),
    at,
  }).wallet;

  const publicFields: Pick<Wallet, 'id' | 'playerId' | 'currency'> = wallet;

  expect(Object.keys(wallet)).toEqual(['id', 'playerId', 'currency']);
  expect({ ...publicFields }).toEqual({
    id: 'wallet',
    playerId: 'player',
    currency: 'BRL',
  });
  expect(JSON.parse(JSON.stringify(wallet))).toEqual({
    id: 'wallet',
    playerId: 'player',
    currency: 'BRL',
  });
});

test('ledger enumeration preserves monetary strings without exposing creation date', () => {
  const entry = WalletLedgerEntry.create({
    id: 'entry',
    walletId: 'wallet',
    transactionId: 'tx',
    direction: LedgerDirection.Credit,
    money,
    balanceBefore: Money.zero('BRL'),
    balanceAfter: money,
    createdAt: at,
  });

  expect(Object.keys(entry)).toEqual([
    'id',
    'walletId',
    'transactionId',
    'direction',
    'money',
    'balanceBefore',
    'balanceAfter',
  ]);
  const publicFields: Pick<WalletLedgerEntry, 'balanceAfter'> = entry;

  expect({ ...publicFields }.balanceAfter).toBe(money);
  expect(JSON.parse(JSON.stringify(entry))).toEqual({
    id: 'entry',
    walletId: 'wallet',
    transactionId: 'tx',
    direction: LedgerDirection.Credit,
    money: { amount: '10.00', currency: 'BRL' },
    balanceBefore: { amount: '0.00', currency: 'BRL' },
    balanceAfter: { amount: '10.00', currency: 'BRL' },
  });
});
