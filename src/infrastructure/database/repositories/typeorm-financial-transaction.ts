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
      await ensureDatabaseConnection(this.source);
      return await this.source.transaction('READ COMMITTED', (manager) =>
        work({
          wallets: new TypeOrmWalletRepository(manager),
          transactions: new TypeOrmWagerTransactionRepository(manager),
          ledger: new TypeOrmLedgerRepository(manager),
          inbox: new TypeOrmInboxRepository(manager),
          outbox: new TypeOrmOutboxRepository(manager),
        }),
      );
    } catch (error) {
      throw persistenceError(error);
    }
  }
}
