import { WagerTransaction } from '../../../domain/entities/wager-transaction.js';
import { Money } from '../../../domain/value-objects/money.js';
import type { WagerRow } from '../entities/wager-transaction.schema.js';

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
