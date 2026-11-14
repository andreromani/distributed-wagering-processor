import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseOptions } from './options.js';
import { DataSource } from 'typeorm';
import { TypeOrmFinancialTransaction } from './repositories/typeorm-financial-transaction.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { OperationalMetrics } from '../observability/operational-metrics.js';

@Module({
  imports: [
    ObservabilityModule,
    TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...databaseOptions(), manualInitialization: true }),
    }),
  ],
  providers: [
    {
      provide: TypeOrmFinancialTransaction,
      inject: [DataSource, OperationalMetrics],
      useFactory: (source: DataSource, metrics: OperationalMetrics) =>
        new TypeOrmFinancialTransaction(source, metrics),
    },
  ],
  exports: [TypeOrmModule, TypeOrmFinancialTransaction],
})
export class DatabaseModule {}
