import type { Wallet } from '../entities/wallet.js';
import type { WagerTransaction } from '../entities/wager-transaction.js';
import type { WalletLedgerEntry } from '../entities/wallet-ledger-entry.js';
import type { WagerTransactionKind } from '../financial.types.js';
import type { Money } from '../value-objects/money.js';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  findByPlayerCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | undefined>;
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  update(wallet: Wallet): Promise<void>;
}

export interface OriginalResult {
  balance: Money;
  version: number;
}

export interface StoredWager {
  transaction: WagerTransaction;
  result?: OriginalResult;
  referenceAttempts: number;
  nextAttemptAt?: Date;
}

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction, result?: OriginalResult): Promise<void>;
  findById(id: string): Promise<StoredWager | undefined>;
  findByProviderExternal(
    providerId: string,
    externalId: string,
  ): Promise<StoredWager | undefined>;
  findByIdempotencyKey(key: string): Promise<StoredWager | undefined>;
  findReference(
    providerId: string,
    externalId: string,
  ): Promise<StoredWager | undefined>;
  findProcessedReversal(
    referenceId: string,
    kind: WagerTransactionKind,
  ): Promise<StoredWager | undefined>;
  update(
    transaction: WagerTransaction,
    options?: {
      result?: OriginalResult;
      referenceAttempts?: number;
      nextAttemptAt?: Date;
    },
  ): Promise<void>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  findByWallet(
    walletId: string,
    limit?: number,
    after?: { createdAt: Date; id: string },
  ): Promise<WalletLedgerEntry[]>;
}
