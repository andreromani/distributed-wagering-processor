import type { WagerTransaction } from '../entities/wager-transaction.js';
import type { WagerTransactionKind } from '../financial.types.js';
import type { Money } from '../value-objects/money.js';

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
  insert(
    transaction: WagerTransaction,
    result?: OriginalResult,
    retry?: { referenceAttempts: number; nextAttemptAt?: Date },
  ): Promise<void>;

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
      nextAttemptAt?: Date | null;
    },
  ): Promise<void>;
}
