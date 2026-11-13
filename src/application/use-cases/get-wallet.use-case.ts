import type { FinancialTransaction } from '../ports/financial-transaction.js';
import type { Wallet } from '../../domain/entities/wallet.js';
import { FinancialApplicationError } from '../errors/financial-application.error.js';

export class GetWalletUseCase {
  constructor(private readonly transaction: FinancialTransaction) {}

  execute(walletId: string): Promise<Wallet> {
    return this.transaction.run(async (context) => {
      const wallet = await context.wallets.findById(walletId);
      if (!wallet) {
        throw new FinancialApplicationError('WALLET_NOT_FOUND');
      }
      return wallet;
    });
  }
}
