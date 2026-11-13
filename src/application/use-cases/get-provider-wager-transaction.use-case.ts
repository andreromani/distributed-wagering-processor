import type { FinancialTransaction } from '../ports/financial-transaction.js';
import type { StoredWager } from '../../domain/repositories/wager-transaction.repository.js';
import { FinancialApplicationError } from '../errors/financial-application.error.js';

export class GetProviderWagerTransactionUseCase {
  constructor(private readonly transaction: FinancialTransaction) {}

  execute(providerId: string, externalId: string): Promise<StoredWager> {
    return this.transaction.run(async (context) => {
      const stored = await context.transactions.findByProviderExternal(
        providerId,
        externalId,
      );
      if (!stored) {
        throw new FinancialApplicationError('TRANSACTION_NOT_FOUND');
      }
      return stored;
    });
  }
}
