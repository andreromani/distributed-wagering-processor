import type { FinancialContext } from './financial-context.js';

export interface FinancialTransaction {
  run<T>(work: (context: FinancialContext) => Promise<T>): Promise<T>;
}
