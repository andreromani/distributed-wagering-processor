import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.js';
import { Money } from '../../../domain/value-objects/money.js';
import type { LedgerRow } from '../entities/wallet-ledger.schema.js';

export function ledgerToRow(entry: WalletLedgerEntry): LedgerRow {
  return {
    id: entry.id,
    wallet_id: entry.walletId,
    transaction_id: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toString(),
    currency: entry.money.currency,
    balance_before: entry.balanceBefore.toString(),
    balance_after: entry.balanceAfter.toString(),
    created_at: entry.createdAt,
  };
}

export function ledgerFromRow(row: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction,
    money: Money.rehydrate({ amount: row.amount, currency: row.currency }),
    balanceBefore: Money.rehydrate({
      amount: row.balance_before,
      currency: row.currency,
    }),
    balanceAfter: Money.rehydrate({
      amount: row.balance_after,
      currency: row.currency,
    }),
    createdAt: row.created_at,
  });
}
