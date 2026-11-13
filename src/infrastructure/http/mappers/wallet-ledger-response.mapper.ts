import type { LedgerPageEntry } from '../../../domain/repositories/wallet-ledger.repository.js';

export function ledgerResponse(row: LedgerPageEntry) {
  const entry = row.entry;
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: row.position,
  };
}
