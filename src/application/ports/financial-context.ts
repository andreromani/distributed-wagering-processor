import type { WalletRepository } from '../../domain/repositories/wallet.repository.js';
import type { WagerTransactionRepository } from '../../domain/repositories/wager-transaction.repository.js';
import type { LedgerRepository } from '../../domain/repositories/wallet-ledger.repository.js';

export interface InboxRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export interface FinancialContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: {
    insert(message: InboxRecord): Promise<void>;

    markProcessed(
      consumerName: string,
      messageId: string,
      at: Date,
    ): Promise<void>;

    find(
      consumerName: string,
      messageId: string,
    ): Promise<InboxRecord | undefined>;
  };
  outbox: {
    insert(message: OutboxRecord): Promise<void>;

    lockDue(now: Date, limit: number): Promise<OutboxRecord[]>;
  };
}
