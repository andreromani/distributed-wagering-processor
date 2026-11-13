import { DataSource } from 'typeorm';
import { TypeOrmWalletReconciliationReader } from './database/repositories/typeorm-wallet-reconciliation.reader.js';
import { FinancialDiagnostics } from './http/financial-diagnostics.js';
import { ReconcileWalletUseCase } from '../application/use-cases/reconcile-wallet.use-case.js';
import { GetWalletUseCase } from '../application/use-cases/get-wallet.use-case.js';
import { GetWagerTransactionUseCase } from '../application/use-cases/get-wager-transaction.use-case.js';
import { GetProviderWagerTransactionUseCase } from '../application/use-cases/get-provider-wager-transaction.use-case.js';
import { ListWalletLedgerUseCase } from '../application/use-cases/list-wallet-ledger.use-case.js';
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
      provide: FinancialDiagnostics,
      useFactory: () => new FinancialDiagnostics(),
    },
    {
      provide: TypeOrmWalletReconciliationReader,
      inject: [DataSource],
      useFactory: (source: DataSource) =>
        new TypeOrmWalletReconciliationReader(source),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [TypeOrmWalletReconciliationReader, FinancialDiagnostics],
      useFactory: (
        reader: TypeOrmWalletReconciliationReader,
        observer: FinancialDiagnostics,
      ) => new ReconcileWalletUseCase(reader, observer),
    },
    ...[
      GetWalletUseCase,
      GetWagerTransactionUseCase,
      GetProviderWagerTransactionUseCase,
      ListWalletLedgerUseCase,
    ].map((token) => ({
      provide: token,
      inject: [TypeOrmFinancialTransaction],
      useFactory: (transaction: TypeOrmFinancialTransaction) =>
        new token(transaction),
    })),
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
    FinancialDiagnostics,
    ReconcileWalletUseCase,
    GetWalletUseCase,
    GetWagerTransactionUseCase,
    GetProviderWagerTransactionUseCase,
    ListWalletLedgerUseCase,
    OpenWalletUseCase,
    ProcessWagerTransactionUseCase,
    ReprocessPendingReferenceUseCase,
  ],
})
export class FinancialApplicationModule {}
