import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { TypeOrmFinancialTransaction } from './database/repositories/typeorm-financial-transaction.js';
import { OpenWalletUseCase } from '../application/use-cases/open-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from '../application/use-cases/process-wager-transaction.use-case.js';
import { ReprocessPendingReferenceUseCase } from '../application/use-cases/reprocess-pending-reference.use-case.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: OpenWalletUseCase,
      inject: [TypeOrmFinancialTransaction],
      useFactory: (transaction: TypeOrmFinancialTransaction) =>
        new OpenWalletUseCase(transaction),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [TypeOrmFinancialTransaction],
      useFactory: (transaction: TypeOrmFinancialTransaction) =>
        new ProcessWagerTransactionUseCase(transaction),
    },
    {
      provide: ReprocessPendingReferenceUseCase,
      inject: [ProcessWagerTransactionUseCase],
      useFactory: (process: ProcessWagerTransactionUseCase) =>
        new ReprocessPendingReferenceUseCase(process),
    },
  ],
  exports: [
    OpenWalletUseCase,
    ProcessWagerTransactionUseCase,
    ReprocessPendingReferenceUseCase,
  ],
})
export class FinancialApplicationModule {}
