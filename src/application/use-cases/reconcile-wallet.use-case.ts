import type { WalletReconciliationReader } from '../ports/wallet-reconciliation-reader.js';
import type { ReconciliationObserver } from '../ports/reconciliation-observer.js';
import type { MoneyProps } from '../../domain/value-objects/money.js';
import { FinancialApplicationError } from '../errors/financial-application.error.js';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWalletUseCase {
  constructor(
    private readonly reader: WalletReconciliationReader,
    private readonly observer: ReconciliationObserver,
  ) {}

  async execute(
    walletId: string,
    correlationId: string,
  ): Promise<ReconciliationResult> {
    const snapshot = await this.reader.read(walletId);
    if (!snapshot) {
      throw new FinancialApplicationError('WALLET_NOT_FOUND');
    }
    const result = {
      walletId: snapshot.walletId,
      storedBalance: {
        amount: snapshot.storedBalance,
        currency: snapshot.currency,
      },
      calculatedBalance: {
        amount: snapshot.calculatedBalance,
        currency: snapshot.currency,
      },
      difference: { amount: snapshot.difference, currency: snapshot.currency },
      consistent: snapshot.difference === '0.00',
      checkedEntries: snapshot.checkedEntries,
    };
    if (!result.consistent) {
      this.observer.divergence(snapshot, correlationId);
    }
    return result;
  }
}
