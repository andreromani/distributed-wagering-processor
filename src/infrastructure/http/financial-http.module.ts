import { Module } from '@nestjs/common';
import { FinancialApplicationModule } from '../financial-application.module.js';
import { WalletsController } from './controllers/wallets.controller.js';
import { WageringTransactionsController } from './controllers/wagering-transactions.controller.js';
import { ProviderWageringTransactionsController } from './controllers/provider-wagering-transactions.controller.js';

// Extension point for external OIDC authentication and resource authorization:
// attach the future guards to these financial controllers. Health lives in AppModule.
@Module({
  imports: [FinancialApplicationModule],
  controllers: [
    WalletsController,
    WageringTransactionsController,
    ProviderWageringTransactionsController,
  ],
})
export class FinancialHttpModule {}
