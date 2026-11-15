import type { FinancialContext } from './financial-context.js';
import type { FinancialObservation } from './financial-observer.js';

export interface FinancialTransaction {
  run<T>(
    work: (context: FinancialContext) => Promise<T>,
    observation?: FinancialObservation,
  ): Promise<T>;
}
