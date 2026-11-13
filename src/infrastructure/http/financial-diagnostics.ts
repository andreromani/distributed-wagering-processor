import type { ReconciliationObserver } from '../../application/ports/reconciliation-observer.js';
import type { ReconciliationSnapshot } from '../../application/ports/wallet-reconciliation-reader.js';

export class FinancialDiagnostics implements ReconciliationObserver {
  #reconciliationDivergences = 0;

  constructor(
    private readonly sink: (
      record: Readonly<Record<string, unknown>>,
    ) => void = (record) => console.log(JSON.stringify(record)),
  ) {}

  get reconciliationDivergences(): number {
    return this.#reconciliationDivergences;
  }

  divergence(snapshot: ReconciliationSnapshot, correlationId: string): void {
    this.#reconciliationDivergences += 1;
    this.record({
      level: 'error',
      event: 'wallet_reconciliation_divergence',
      walletId: snapshot.walletId,
      correlationId,
    });
  }

  record(record: Readonly<Record<string, unknown>>): void {
    this.sink(record);
  }
}
