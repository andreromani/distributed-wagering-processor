import type { WalletLedgerEntry } from '../../src/domain/entities/wallet-ledger-entry.js';
import type { FinancialTransaction } from '../../src/application/ports/financial-transaction.js';
import type {
  FinancialContext,
  InboxRecord,
  OutboxRecord,
} from '../../src/application/ports/financial-context.js';
import type { StoredWager } from '../../src/domain/repositories/wager-transaction.repository.js';
import { Wallet } from '../../src/domain/entities/wallet.js';

export class MemoryFinancialTransaction implements FinancialTransaction {
  readonly wallets = new Map<string, Wallet>();
  readonly wagers = new Map<string, StoredWager>();
  readonly inbox = new Map<string, InboxRecord>();
  readonly outbox: OutboxRecord[] = [];
  readonly entries: WalletLedgerEntry[] = [];
  readonly context: FinancialContext = {
    wallets: {
      insert: async (wallet) => {
        this.wallets.set(wallet.id, wallet);
      },
      findById: async (id) => this.wallets.get(id),
      findByPlayerCurrency: async (player, currency) =>
        [...this.wallets.values()].find(
          (w) => w.playerId === player && w.currency === currency,
        ),
      findByIdForUpdate: async (id) => this.wallets.get(id),
      update: async (wallet) => {
        this.wallets.set(wallet.id, wallet);
      },
    },
    transactions: {
      insert: async (transaction, result, retry) => {
        this.wagers.set(transaction.id, {
          transaction,
          result,
          referenceAttempts: retry?.referenceAttempts ?? 0,
          nextAttemptAt: retry?.nextAttemptAt,
        });
      },
      findById: async (id) => this.wagers.get(id),
      findByProviderExternal: async (provider, external) =>
        [...this.wagers.values()].find(
          (w) =>
            w.transaction.providerId === provider &&
            w.transaction.externalTransactionId === external,
        ),
      findReference: async (provider, external) =>
        this.context.transactions.findByProviderExternal(provider, external),
      findByIdempotencyKey: async (key) =>
        [...this.wagers.values()].find(
          (w) => w.transaction.idempotencyKey === key,
        ),
      findProcessedReversal: async (reference, kind) =>
        [...this.wagers.values()].find(
          (w) =>
            w.transaction.referenceTransactionId === reference &&
            w.transaction.kind === kind &&
            w.transaction.status === 'PROCESSED',
        ),
      update: async (transaction, options) => {
        const old = this.wagers.get(transaction.id);
        this.wagers.set(transaction.id, {
          transaction,
          result: options?.result,
          referenceAttempts:
            options?.referenceAttempts ?? old?.referenceAttempts ?? 0,
          nextAttemptAt: options?.nextAttemptAt ?? undefined,
        });
      },
    },
    ledger: {
      insert: async (entry) => {
        this.entries.push(entry);
      },
      findByWallet: async (walletId) =>
        this.entries.filter((entry) => entry.walletId === walletId),
    },
    inbox: {
      insert: async (record) => {
        this.inbox.set(record.consumerName + ':' + record.messageId, record);
      },
      markProcessed: async (consumerName, messageId, at) => {
        const key = consumerName + ':' + messageId;
        const record = this.inbox.get(key);
        if (!record) {
          throw new Error('Missing receipt');
        }
        this.inbox.set(key, {
          consumerName,
          messageId,
          payloadHash: record.payloadHash,
          receivedAt: record.receivedAt,
          processedAt: at,
        });
      },
      find: async (consumer, message) =>
        this.inbox.get(consumer + ':' + message),
    },
    outbox: {
      insert: async (record) => {
        this.outbox.push(record);
      },
      lockDue: async () => this.outbox,
    },
  };

  run<T>(work: (context: FinancialContext) => Promise<T>): Promise<T> {
    return work(this.context);
  }
}
