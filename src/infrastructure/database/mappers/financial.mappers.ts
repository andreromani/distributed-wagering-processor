import { Wallet } from '../../../domain/entities/wallet.js';
import { WagerTransaction } from '../../../domain/entities/wager-transaction.js';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.js';
import { Money } from '../../../domain/value-objects/money.js';
import type {
  WalletRow,
  WagerRow,
  LedgerRow,
} from '../entities/financial.schemas.js';

export function walletToRow(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    player_id: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    created_at: wallet.createdAt,
    updated_at: wallet.updatedAt,
  };
}

export function walletFromRow(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: Money.rehydrate({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function wagerToRow(tx: WagerTransaction): WagerRow {
  return {
    id: tx.id,
    provider_id: tx.providerId,
    external_transaction_id: tx.externalTransactionId,
    idempotency_key: tx.idempotencyKey,
    payload_hash: tx.payloadHash,
    wallet_id: tx.walletId,
    player_id: tx.playerId,
    round_id: tx.roundId,
    game_id: tx.gameId,
    kind: tx.kind,
    amount: tx.money.toString(),
    currency: tx.money.currency,
    reference_external_transaction_id:
      tx.referenceExternalTransactionId ?? null,
    reference_transaction_id: tx.referenceTransactionId ?? null,
    status: tx.status,
    failure_code: tx.failureCode ?? null,
    created_at: tx.createdAt,
    processed_at: tx.processedAt ?? null,
    result_balance: null,
    result_version: null,
    reference_attempts: 0,
    next_attempt_at: null,
  };
}

export function wagerFromRow(row: WagerRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: Money.rehydrate({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId:
      row.reference_external_transaction_id ?? undefined,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    status: row.status,
    failureCode: row.failure_code ?? undefined,
    createdAt: row.created_at,
    processedAt: row.processed_at ?? undefined,
  });
}

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
