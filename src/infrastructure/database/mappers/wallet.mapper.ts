import { Wallet } from '../../../domain/entities/wallet.js';
import { Money } from '../../../domain/value-objects/money.js';
import type { WalletRow } from '../entities/wallet.schema.js';

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
