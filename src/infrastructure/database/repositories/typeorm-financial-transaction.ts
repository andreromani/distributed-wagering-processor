import {
  transactionCancellation,
  cancellableContext,
} from '../transaction-cancellation.js';
import { ensureDatabaseConnection } from '../database-connection.js';
import { persistenceError } from '../mappers/persistence-error.mapper.js';
import { DataSource } from 'typeorm';
import type { FinancialTransaction } from '../../../application/ports/financial-transaction.js';
import type { FinancialContext } from '../../../application/ports/financial-context.js';
import { TypeOrmWalletRepository } from './typeorm-wallet.repository.js';
import { TypeOrmWagerTransactionRepository } from './typeorm-wager-transaction.repository.js';
import { TypeOrmLedgerRepository } from './typeorm-wallet-ledger.repository.js';
import { TypeOrmInboxRepository } from './typeorm-inbox.repository.js';
import { TypeOrmOutboxRepository } from './typeorm-outbox.repository.js';

export class TypeOrmFinancialTransaction implements FinancialTransaction {
  constructor(private readonly source: DataSource) {}

  async run<T>(work: (context: FinancialContext) => Promise<T>): Promise<T> {
    try {
      const signal = transactionCancellation.getStore();
      signal?.throwIfAborted();
      await ensureDatabaseConnection(this.source);
      return await this.source.transaction(
        'READ COMMITTED',
        async (manager) => {
          const context: FinancialContext = {
            wallets: new TypeOrmWalletRepository(manager),
            transactions: new TypeOrmWagerTransactionRepository(manager),
            ledger: new TypeOrmLedgerRepository(manager),
            inbox: new TypeOrmInboxRepository(manager),
            outbox: new TypeOrmOutboxRepository(manager),
          };
          const result = await work(
            signal ? cancellableContext(context, signal) : context,
          );
          signal?.throwIfAborted();
          return result;
        },
      );
    } catch (error) {
      throw persistenceError(error);
    }
  }
}
