import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseOptions } from './options.js';
import { DataSource } from 'typeorm';
import { TypeOrmFinancialTransaction } from './repositories/typeorm-financial-transaction.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...databaseOptions(), manualInitialization: true }),
    }),
  ],
  providers: [
    {
      provide: TypeOrmFinancialTransaction,
      inject: [DataSource],
      useFactory: (source: DataSource) =>
        new TypeOrmFinancialTransaction(source),
    },
  ],
  exports: [TypeOrmModule, TypeOrmFinancialTransaction],
})
export class DatabaseModule {}
