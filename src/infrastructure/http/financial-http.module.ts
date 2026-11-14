import { Module } from '@nestjs/common';
import { FinancialApplicationModule } from '../financial-application.module.js';
import { WalletsController } from './controllers/wallets.controller.js';
import { WageringTransactionsController } from './controllers/wagering-transactions.controller.js';
import { ProviderWageringTransactionsController } from './controllers/provider-wagering-transactions.controller.js';
import { FinancialAuthGuard } from './financial-auth.guard.js';

@Module({
  imports: [FinancialApplicationModule],
  providers: [FinancialAuthGuard],
  controllers: [
    WalletsController,
    WageringTransactionsController,
    ProviderWageringTransactionsController,
  ],
})
export class FinancialHttpModule {}
